import { formatError, jsonSafe } from "../format";
import { createReadClient, readProductView } from "../genlayer";
import { parseLibraryEntry, parseLibraryVersionCount, type LibraryEntry } from "../productB1/library";
import { LIST_PAGE_LIMIT, PRODUCT_UI_CONTRACT, STATE_APPROVED } from "./constants";
import { readTaskCount, readTaskPage } from "./list";
import { newestPageWindow, uniqueTaskIds, type LiveTaskSummary } from "./summary";

export type LiveLibraryGroup = {
  string_key: string;
  locale: string;
  versions: LibraryEntry[];
  approvedTaskIds: string[];
  versionCount: number;
  /** 0-based `list_library` offset for the next unread page. */
  nextVersionOffset: number;
  versionsComplete: boolean;
  versionReadError?: string;
};

export type LibraryDiscovery = {
  taskCount: number;
  pagesFromEnd: number;
  scannedOffset: number;
  scannedLimit: number;
  scannedEndExclusive: number;
  uniqueApprovedTaskIds: string[];
  uniqueApprovedTaskCount: number;
  groups: LiveLibraryGroup[];
  moreAvailable: boolean;
  incompleteVersionGroups: number;
  scopeNote: string;
};

export type LibraryDiscoveryDeps = {
  taskCount: () => Promise<number>;
  taskPage: (offset: number, limit: number) => Promise<LiveTaskSummary[]>;
  versionCount: (stringKey: string, locale: string) => Promise<unknown>;
  listLibrary: (stringKey: string, locale: string, offset: number, limit: number) => Promise<unknown>;
};

/** JSON tuple. Distinct from NUL-join: contract `string_key` / locale may contain U+0000. */
export function encodeLibraryPair(stringKey: string, locale: string): string {
  return JSON.stringify([stringKey, locale]);
}

export function encodeLibraryVersionKey(stringKey: string, locale: string, version: number): string {
  return JSON.stringify([stringKey, locale, version]);
}

export function decodeLibraryPair(id: string): { string_key: string; locale: string } | undefined {
  try {
    const parsed = JSON.parse(id) as unknown;
    if (!Array.isArray(parsed) || parsed.length < 2) return undefined;
    if (typeof parsed[0] !== "string" || typeof parsed[1] !== "string") return undefined;
    return { string_key: parsed[0], locale: parsed[1] };
  } catch {
    return undefined;
  }
}

export function libraryPairsEqual(
  a: { string_key: string; locale: string },
  b: { string_key: string; locale: string },
): boolean {
  return a.string_key === b.string_key && a.locale === b.locale;
}

export function emptyLibraryGroup(
  stringKey: string,
  locale: string,
  approvedTaskIds: string[] = [],
): LiveLibraryGroup {
  return {
    string_key: stringKey,
    locale,
    versions: [],
    approvedTaskIds: [...approvedTaskIds],
    versionCount: 0,
    nextVersionOffset: 0,
    versionsComplete: false,
  };
}

/** Bounded `list_library` windows. Versions are 1-indexed; offset is 0-based. */
export function libraryVersionPageWindows(
  versionCount: number,
  pageLimit = LIST_PAGE_LIMIT,
): Array<{ offset: number; length: number }> {
  const total = Number.isFinite(versionCount) && versionCount > 0 ? Math.trunc(versionCount) : 0;
  const limit = pageLimit < 1 ? 1 : Math.min(Math.trunc(pageLimit), LIST_PAGE_LIMIT);
  const windows: Array<{ offset: number; length: number }> = [];
  let offset = 0;
  while (offset < total) {
    const length = Math.min(limit, total - offset);
    windows.push({ offset, length });
    offset += length;
  }
  return windows;
}

export function nextLibraryVersionWindow(
  group: Pick<LiveLibraryGroup, "versionCount" | "nextVersionOffset">,
  pageLimit = LIST_PAGE_LIMIT,
): { offset: number; length: number } | null {
  const total = Number.isFinite(group.versionCount) && group.versionCount > 0 ? Math.trunc(group.versionCount) : 0;
  const offset =
    Number.isFinite(group.nextVersionOffset) && group.nextVersionOffset > 0
      ? Math.trunc(group.nextVersionOffset)
      : 0;
  if (offset >= total) return null;
  const limit = pageLimit < 1 ? 1 : Math.min(Math.trunc(pageLimit), LIST_PAGE_LIMIT);
  return { offset, length: Math.min(limit, total - offset) };
}

export function mergeLibraryVersions(existing: LibraryEntry[], incoming: LibraryEntry[]): LibraryEntry[] {
  const map = new Map<number, LibraryEntry>();
  for (const entry of existing) map.set(entry.version, entry);
  for (const entry of incoming) map.set(entry.version, entry);
  return [...map.values()].sort((a, b) => a.version - b.version);
}

export function versionsCoverExactly(versions: LibraryEntry[], versionCount: number): boolean {
  if (versionCount <= 0) return versions.length === 0;
  if (versions.length !== versionCount) return false;
  const seen = new Set(versions.map((entry) => entry.version));
  if (seen.size !== versionCount) return false;
  for (let version = 1; version <= versionCount; version++) {
    if (!seen.has(version)) return false;
  }
  return true;
}

export type SequentialPageAccept =
  | { ok: true; accepted: LibraryEntry[] }
  | { ok: false; accepted: LibraryEntry[]; reason: string };

/**
 * Fail closed: keep a valid prefix, never skip a hole, never accept a wrong key/version.
 * Cursor callers must advance only by `accepted.length`.
 */
export function acceptSequentialLibraryPage(input: {
  stringKey: string;
  locale: string;
  offset: number;
  length: number;
  raw: unknown;
  existing: LibraryEntry[];
}): SequentialPageAccept {
  if (!Array.isArray(input.raw)) {
    return { ok: false, accepted: [], reason: "list_library did not return an array" };
  }
  const existing = new Set(input.existing.map((entry) => entry.version));
  const accepted: LibraryEntry[] = [];
  const seenThisPage = new Set<number>();
  const needed = input.length;
  for (let i = 0; i < input.raw.length; i++) {
    if (i >= needed) {
      return {
        ok: false,
        accepted,
        reason: `list_library returned extra entries after offset ${input.offset}`,
      };
    }
    const expectedVersion = input.offset + i + 1;
    const entry = parseLibraryEntry(input.raw[i]);
    if (!entry || !entry.translation) {
      return {
        ok: false,
        accepted,
        reason: `list_library entry at offset ${input.offset + i} is missing or malformed (expected version ${expectedVersion})`,
      };
    }
    if (entry.string_key !== input.stringKey || entry.locale !== input.locale) {
      return {
        ok: false,
        accepted,
        reason: `list_library entry at offset ${input.offset + i} has the wrong string_key or locale (expected version ${expectedVersion})`,
      };
    }
    if (entry.version !== expectedVersion) {
      return {
        ok: false,
        accepted,
        reason: `list_library skipped or reordered versions: expected ${expectedVersion} at offset ${input.offset + i}, got ${entry.version}`,
      };
    }
    if (existing.has(entry.version) || seenThisPage.has(entry.version)) {
      return {
        ok: false,
        accepted,
        reason: `list_library returned duplicate version ${entry.version} at offset ${input.offset + i}`,
      };
    }
    seenThisPage.add(entry.version);
    accepted.push(entry);
  }
  if (accepted.length < needed) {
    return {
      ok: false,
      accepted,
      reason: `list_library missing versions at offset ${input.offset + accepted.length} (got ${accepted.length}, expected ${needed})`,
    };
  }
  return { ok: true, accepted };
}

function withScope(d: Omit<LibraryDiscovery, "scopeNote">): LibraryDiscovery {
  const end = Math.max(d.scannedOffset, d.scannedEndExclusive - 1);
  const incomplete =
    d.incompleteVersionGroups > 0
      ? ` ${d.incompleteVersionGroups} string_key+locale pair(s) still have unread list_library pages. Use Load more versions on that key.`
      : " Each discovered pair loaded at most one list_library page (limit 50) until you request more.";
  return {
    ...d,
    scopeNote: `The contract has no global library index. These versions come from unique approved tasks in list_tasks offset ${d.scannedOffset}–${end} of task_count ${d.taskCount} (${d.uniqueApprovedTaskCount} unique approved compact rows on the scanned pages). Older unread task pages stay hidden until you load more. Rejected translations are not listed.${incomplete}`,
  };
}

export function liveLibraryDiscoveryDeps(): LibraryDiscoveryDeps {
  return {
    taskCount: () => readTaskCount(),
    taskPage: (offset, limit) => readTaskPage(offset, limit),
    versionCount: (stringKey, locale) =>
      readProductView(createReadClient(), PRODUCT_UI_CONTRACT, "library_version_count", [stringKey, locale]),
    listLibrary: (stringKey, locale, offset, limit) =>
      readProductView(createReadClient(), PRODUCT_UI_CONTRACT, "list_library", [
        stringKey,
        locale,
        offset,
        limit,
      ]),
  };
}

function unreadablyCounted(group: LiveLibraryGroup, reason: string): LiveLibraryGroup {
  return {
    ...group,
    versionsComplete: false,
    versionReadError: reason,
  };
}

/**
 * Fetch at most one `list_library` page for this pair.
 * Unreadable counts and bad pages stay incomplete with an error.
 * Previously loaded versions are kept. The cursor never skips a hole.
 */
export async function loadNextLibraryVersionPage(
  group: LiveLibraryGroup,
  deps: Pick<LibraryDiscoveryDeps, "versionCount" | "listLibrary">,
): Promise<LiveLibraryGroup> {
  let versionCount = group.versionCount;
  try {
    const countRaw = await deps.versionCount(group.string_key, group.locale);
    const parsed = parseLibraryVersionCount(countRaw);
    if (parsed == null || parsed < 0) {
      return unreadablyCounted(group, "library_version_count is unreadable");
    }
    versionCount = parsed;
  } catch (err) {
    return unreadablyCounted(group, `library_version_count: ${formatError(err)}`);
  }

  if (versionCount === 0) {
    if (group.versions.length > 0) {
      return unreadablyCounted(
        { ...group, versionCount: 0 },
        "library_version_count is 0 after versions were already loaded",
      );
    }
    if (group.approvedTaskIds.length > 0) {
      return unreadablyCounted(
        { ...group, versionCount: 0, nextVersionOffset: 0 },
        "inconsistent library: list_tasks reports an approved task for this key and locale, but library_version_count is 0",
      );
    }
    return {
      ...group,
      versionCount: 0,
      nextVersionOffset: 0,
      versionsComplete: true,
      versionReadError: undefined,
    };
  }

  const window = nextLibraryVersionWindow({ versionCount, nextVersionOffset: group.nextVersionOffset });
  if (!window) {
    const complete = versionsCoverExactly(group.versions, versionCount);
    return {
      ...group,
      versionCount,
      versionsComplete: complete,
      versionReadError: complete
        ? undefined
        : `loaded versions do not cover 1..${versionCount} without gaps`,
    };
  }

  try {
    const raw = jsonSafe(
      await deps.listLibrary(group.string_key, group.locale, window.offset, window.length),
    );
    const page = acceptSequentialLibraryPage({
      stringKey: group.string_key,
      locale: group.locale,
      offset: window.offset,
      length: window.length,
      raw,
      existing: group.versions,
    });
    const versions = mergeLibraryVersions(group.versions, page.accepted);
    const nextVersionOffset = window.offset + page.accepted.length;
    if (!page.ok) {
      return {
        ...group,
        versions,
        versionCount,
        nextVersionOffset,
        versionsComplete: false,
        versionReadError: page.reason,
      };
    }
    const complete = nextVersionOffset >= versionCount && versionsCoverExactly(versions, versionCount);
    return {
      ...group,
      versions,
      versionCount,
      nextVersionOffset,
      versionsComplete: complete,
      versionReadError: undefined,
    };
  } catch (err) {
    return {
      ...group,
      versionCount,
      versionsComplete: false,
      versionReadError: `list_library: ${formatError(err)}`,
    };
  }
}

export async function discoverLibraryPage(
  pagesFromEnd: number,
  previous?: LibraryDiscovery,
  deps: LibraryDiscoveryDeps = liveLibraryDiscoveryDeps(),
): Promise<LibraryDiscovery> {
  const taskCount = await deps.taskCount();
  const limit = LIST_PAGE_LIMIT;
  const window = newestPageWindow(taskCount, limit, pagesFromEnd);
  const items = window.length === 0 ? [] : await deps.taskPage(window.offset, window.length);
  const scannedEndExclusive = Math.min(taskCount, window.offset + items.length);
  const moreAvailable = window.moreOlder;

  const pairTasks = new Map<string, { string_key: string; locale: string; approvedTaskIds: string[] }>();
  if (previous) {
    for (const group of previous.groups) {
      pairTasks.set(encodeLibraryPair(group.string_key, group.locale), {
        string_key: group.string_key,
        locale: group.locale,
        approvedTaskIds: [...group.approvedTaskIds],
      });
    }
  }

  const uniqueApprovedTaskIds = uniqueTaskIds([
    ...(previous?.uniqueApprovedTaskIds ?? []).map((task_id) => ({ task_id })),
    ...items.filter((row) => row.state === STATE_APPROVED),
  ]);
  const newPairs = new Set<string>();
  for (const row of items) {
    if (row.state !== STATE_APPROVED) continue;
    const id = encodeLibraryPair(row.string_key, row.target_locale);
    const existing = pairTasks.get(id);
    if (existing) {
      if (!existing.approvedTaskIds.includes(row.task_id)) existing.approvedTaskIds.push(row.task_id);
    } else {
      pairTasks.set(id, {
        string_key: row.string_key,
        locale: row.target_locale,
        approvedTaskIds: [row.task_id],
      });
      newPairs.add(id);
    }
  }

  const previousGroups = new Map(
    (previous?.groups ?? []).map((g) => [encodeLibraryPair(g.string_key, g.locale), g]),
  );
  const groups: LiveLibraryGroup[] = [];
  for (const meta of pairTasks.values()) {
    const id = encodeLibraryPair(meta.string_key, meta.locale);
    const prev = previousGroups.get(id);
    let group: LiveLibraryGroup = prev
      ? { ...prev, approvedTaskIds: meta.approvedTaskIds }
      : emptyLibraryGroup(meta.string_key, meta.locale, meta.approvedTaskIds);
    if (!prev || newPairs.has(id)) {
      group = await loadNextLibraryVersionPage(group, deps);
    }
    if (
      group.versionsComplete &&
      group.versionCount === 0 &&
      group.versions.length === 0 &&
      !group.versionReadError &&
      group.approvedTaskIds.length === 0
    ) {
      continue;
    }
    groups.push(group);
  }

  groups.sort((a, b) => a.string_key.localeCompare(b.string_key) || a.locale.localeCompare(b.locale));

  const scannedOffset = previous ? Math.min(previous.scannedOffset, window.offset) : window.offset;
  const scannedEnd = previous ? Math.max(previous.scannedEndExclusive, scannedEndExclusive) : scannedEndExclusive;
  const incompleteVersionGroups = groups.filter((g) => !g.versionsComplete).length;
  return withScope({
    taskCount,
    pagesFromEnd,
    scannedOffset,
    scannedLimit: limit,
    scannedEndExclusive: scannedEnd,
    uniqueApprovedTaskIds,
    uniqueApprovedTaskCount: uniqueApprovedTaskIds.length,
    groups,
    moreAvailable,
    incompleteVersionGroups,
  });
}

/** One additional `list_library` page for a single string_key + locale. */
export async function loadMoreVersionsForPair(
  discovery: LibraryDiscovery,
  stringKey: string,
  locale: string,
  deps: LibraryDiscoveryDeps = liveLibraryDiscoveryDeps(),
): Promise<LibraryDiscovery> {
  const groups: LiveLibraryGroup[] = [];
  for (const group of discovery.groups) {
    if (!libraryPairsEqual(group, { string_key: stringKey, locale })) {
      groups.push(group);
      continue;
    }
    if (group.versionsComplete) {
      groups.push(group);
      continue;
    }
    groups.push(await loadNextLibraryVersionPage(group, deps));
  }
  const incompleteVersionGroups = groups.filter((g) => !g.versionsComplete).length;
  return withScope({
    ...discovery,
    groups,
    incompleteVersionGroups,
  });
}

/** One additional page per incomplete pair. Does not drain remaining pages in one click. */
export async function loadNextVersionPageForIncompleteGroups(
  discovery: LibraryDiscovery,
  deps: LibraryDiscoveryDeps = liveLibraryDiscoveryDeps(),
): Promise<LibraryDiscovery> {
  const groups: LiveLibraryGroup[] = [];
  for (const group of discovery.groups) {
    if (group.versionsComplete) {
      groups.push(group);
      continue;
    }
    groups.push(await loadNextLibraryVersionPage(group, deps));
  }
  const incompleteVersionGroups = groups.filter((g) => !g.versionsComplete).length;
  return withScope({
    ...discovery,
    groups,
    incompleteVersionGroups,
  });
}

export function libraryLoadError(err: unknown): string {
  return formatError(err);
}

export function flattenLibraryVersions(groups: LiveLibraryGroup[]): LibraryEntry[] {
  return groups.flatMap((g) => g.versions);
}

export function approvedSummaryIsNotLibraryEntry(row: LiveTaskSummary): boolean {
  return row.state !== STATE_APPROVED;
}
