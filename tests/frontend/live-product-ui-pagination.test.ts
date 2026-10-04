import { describe, expect, it } from "vitest";
import { LIST_PAGE_LIMIT } from "../../src/live/productUi/constants";
import {
  acceptSequentialLibraryPage,
  discoverLibraryPage,
  emptyLibraryGroup,
  encodeLibraryPair,
  encodeLibraryVersionKey,
  libraryVersionPageWindows,
  loadMoreVersionsForPair,
  loadNextLibraryVersionPage,
  loadNextVersionPageForIncompleteGroups,
  mergeLibraryVersions,
  nextLibraryVersionWindow,
  type LibraryDiscoveryDeps,
} from "../../src/live/productUi/libraryDiscover";
import {
  mergeTaskSummaries,
  newestPageWindow,
  newestPageWindows,
  pageWindowsCoverExactly,
  uniqueTaskIds,
  type LiveTaskSummary,
} from "../../src/live/productUi/summary";
import type { LibraryEntry } from "../../src/live/productB1/library";

function summary(id: string): LiveTaskSummary {
  return {
    task_id: id,
    funder: "0x1111111111111111111111111111111111111111",
    translator: "0x2222222222222222222222222222222222222222",
    rewardWei: "1",
    source_locale: "EN-US",
    target_locale: "ES-ES",
    string_key: "k",
    state: "approved",
    decision: "approved",
    payment_status: "submitted",
    payment_kind: "payout",
    payout_submitted: true,
    created_at_unix: 1,
    submit_by_unix: 2,
    recover_after_unix: 3,
    submitted_at_unix: 0,
    decided_at_unix: 0,
    recovery_opens_at_unix: 3,
    client_nonce: id,
  };
}

describe("list_tasks newest-first pages", () => {
  it.each([51, 75, 120, 50, 1, 0])(
    "covers task_count %s with disjoint remainder pages",
    (count) => {
      const windows = newestPageWindows(count, LIST_PAGE_LIMIT);
      expect(pageWindowsCoverExactly(count, windows)).toBe(true);
      for (const window of windows) {
        expect(window.length).toBeGreaterThan(0);
        expect(window.length).toBeLessThanOrEqual(LIST_PAGE_LIMIT);
      }
      if (count > LIST_PAGE_LIMIT) {
        expect(windows[0]?.length).toBe(LIST_PAGE_LIMIT);
        expect(windows[windows.length - 1]?.length).toBe(count % LIST_PAGE_LIMIT || LIST_PAGE_LIMIT);
      }
    },
  );

  it("does not request 50 overlapping ids on the last page of 51, 75, or 120", () => {
    expect(newestPageWindow(51, 50, 0)).toEqual({ offset: 1, length: 50, moreOlder: true });
    expect(newestPageWindow(51, 50, 1)).toEqual({ offset: 0, length: 1, moreOlder: false });
    expect(newestPageWindow(75, 50, 0)).toEqual({ offset: 25, length: 50, moreOlder: true });
    expect(newestPageWindow(75, 50, 1)).toEqual({ offset: 0, length: 25, moreOlder: false });
    expect(newestPageWindow(120, 50, 0)).toEqual({ offset: 70, length: 50, moreOlder: true });
    expect(newestPageWindow(120, 50, 1)).toEqual({ offset: 20, length: 50, moreOlder: true });
    expect(newestPageWindow(120, 50, 2)).toEqual({ offset: 0, length: 20, moreOlder: false });
  });

  it("merges older pages without duplicating or dropping task ids", () => {
    const first = Array.from({ length: 50 }, (_, i) => summary(String(70 + i)));
    const second = Array.from({ length: 50 }, (_, i) => summary(String(20 + i)));
    const third = Array.from({ length: 20 }, (_, i) => summary(String(i)));
    const merged = mergeTaskSummaries(mergeTaskSummaries(first, second), third);
    expect(uniqueTaskIds(merged)).toHaveLength(120);
    expect(merged.map((row) => row.task_id)).toEqual([...new Set(merged.map((row) => row.task_id))]);
    const overlapAppend = mergeTaskSummaries(first, first);
    expect(uniqueTaskIds(overlapAppend)).toHaveLength(50);
  });
});

describe("list_library version pages", () => {
  it("pages more than 50 versions without overlap", () => {
    const windows = libraryVersionPageWindows(51, 50);
    expect(windows).toEqual([
      { offset: 0, length: 50 },
      { offset: 50, length: 1 },
    ]);
    const covered = windows.reduce((n, w) => n + w.length, 0);
    expect(covered).toBe(51);
    expect(libraryVersionPageWindows(120, 50)).toEqual([
      { offset: 0, length: 50 },
      { offset: 50, length: 50 },
      { offset: 100, length: 20 },
    ]);
  });

  it("merges version pages by version number", () => {
    const page1: LibraryEntry[] = [
      {
        version: 1,
        task_id: "a",
        translation: "uno",
        source_text: "one",
        string_key: "k",
        locale: "es",
        approved_at_unix: 1,
        raw: {},
      },
    ];
    const page2: LibraryEntry[] = [
      {
        version: 51,
        task_id: "b",
        translation: "cincuenta y uno",
        source_text: "fifty-one",
        string_key: "k",
        locale: "es",
        approved_at_unix: 2,
        raw: {},
      },
    ];
    const merged = mergeLibraryVersions(page1, page2);
    expect(merged.map((e) => e.version)).toEqual([1, 51]);
    expect(mergeLibraryVersions(merged, page1)).toHaveLength(2);
  });

  it("counts unique approved task ids across overlapping scans", () => {
    const rows = [summary("t1"), summary("t1"), summary("t2")];
    expect(uniqueTaskIds(rows)).toEqual(["t1", "t2"]);
  });

  it("counts unique approved ids when more than 50 compact rows overlap", () => {
    const first = Array.from({ length: 50 }, (_, i) => summary(`a${i}`));
    const second = [summary("a0"), ...Array.from({ length: 25 }, (_, i) => summary(`b${i}`))];
    expect(uniqueTaskIds([...first, ...second])).toHaveLength(75);
  });
});

function entry(partial: Partial<LibraryEntry> & Pick<LibraryEntry, "version" | "string_key" | "locale">): LibraryEntry {
  return {
    task_id: partial.task_id ?? `t${partial.version}`,
    translation: partial.translation ?? `t${partial.version}`,
    source_text: partial.source_text ?? "src",
    approved_at_unix: partial.approved_at_unix ?? partial.version,
    raw: partial.raw ?? {},
    ...partial,
  };
}

function approvedRow(id: string, stringKey: string, locale = "es"): LiveTaskSummary {
  return { ...summary(id), string_key: stringKey, target_locale: locale };
}

function mockDeps(input: {
  rows: LiveTaskSummary[];
  versions: Record<string, LibraryEntry[]>;
  failListAt?: { key: string; offset: number };
  failCountKeys?: string[];
  unreadableCountKeys?: string[];
  listOverride?: (stringKey: string, locale: string, offset: number, limit: number) => unknown;
  listCalls?: Array<{ key: string; offset: number; limit: number }>;
  countCalls?: number[];
}): LibraryDiscoveryDeps {
  const listCalls = input.listCalls ?? [];
  const countCalls = input.countCalls ?? [];
  return {
    taskCount: async () => input.rows.length,
    taskPage: async (offset, limit) => input.rows.slice(offset, offset + limit),
    versionCount: async (stringKey, locale) => {
      const id = encodeLibraryPair(stringKey, locale);
      countCalls.push(1);
      if (input.failCountKeys?.includes(id)) throw new Error("count RPC down");
      if (input.unreadableCountKeys?.includes(id)) return { not: "a count" };
      return input.versions[id]?.length ?? 0;
    },
    listLibrary: async (stringKey, locale, offset, limit) => {
      const id = encodeLibraryPair(stringKey, locale);
      listCalls.push({ key: id, offset, limit });
      if (input.failListAt && input.failListAt.key === id && input.failListAt.offset === offset) {
        throw new Error("list_library RPC down");
      }
      if (input.listOverride) return input.listOverride(stringKey, locale, offset, limit);
      const all = input.versions[id] ?? [];
      return all.slice(offset, offset + limit);
    },
  };
}

describe("library pair encoding", () => {
  it("keeps adversarial NUL and quote keys distinct", () => {
    const a = encodeLibraryPair("a\0b", "c");
    const b = encodeLibraryPair("a", "b\0c");
    const c = encodeLibraryPair('a","b', "c");
    const d = encodeLibraryPair("a", 'b","c');
    expect(new Set([a, b, c, d]).size).toBe(4);
    expect(encodeLibraryVersionKey("a\0b", "c", 1)).not.toBe(encodeLibraryVersionKey("a", "b\0c", 1));
  });
});

describe("bounded list_library reads", () => {
  it("loads only the first 50 of 51 versions until Load more", async () => {
    const key = encodeLibraryPair("k", "es");
    const versions = { [key]: Array.from({ length: 51 }, (_, i) => entry({ version: i + 1, string_key: "k", locale: "es" })) };
    const calls: Array<{ key: string; offset: number; limit: number }> = [];
    const deps = mockDeps({ rows: [approvedRow("t1", "k")], versions, listCalls: calls });
    const first = await discoverLibraryPage(0, undefined, deps);
    expect(first.groups[0]?.versions).toHaveLength(50);
    expect(first.groups[0]?.nextVersionOffset).toBe(50);
    expect(first.groups[0]?.versionsComplete).toBe(false);
    expect(first.incompleteVersionGroups).toBe(1);
    expect(calls).toEqual([{ key, offset: 0, limit: 50 }]);
    const second = await loadMoreVersionsForPair(first, "k", "es", deps);
    expect(second.groups[0]?.versions).toHaveLength(51);
    expect(second.groups[0]?.versionsComplete).toBe(true);
    expect(second.incompleteVersionGroups).toBe(0);
    expect(calls[1]).toEqual({ key, offset: 50, limit: 1 });
  });

  it("pages 120 versions three times of 50/50/20", async () => {
    const key = encodeLibraryPair("k", "es");
    const versions = { [key]: Array.from({ length: 120 }, (_, i) => entry({ version: i + 1, string_key: "k", locale: "es" })) };
    const deps = mockDeps({ rows: [approvedRow("t1", "k")], versions });
    let discovery = await discoverLibraryPage(0, undefined, deps);
    expect(nextLibraryVersionWindow(discovery.groups[0]!)).toEqual({ offset: 50, length: 50 });
    discovery = await loadMoreVersionsForPair(discovery, "k", "es", deps);
    expect(discovery.groups[0]?.versions).toHaveLength(100);
    expect(discovery.groups[0]?.versionsComplete).toBe(false);
    discovery = await loadMoreVersionsForPair(discovery, "k", "es", deps);
    expect(discovery.groups[0]?.versions.map((v) => v.version)).toEqual(Array.from({ length: 120 }, (_, i) => i + 1));
    expect(discovery.groups[0]?.versionsComplete).toBe(true);
  });

  it("loads one page per key when several keys have 120 versions", async () => {
    const alpha = encodeLibraryPair("alpha", "es");
    const beta = encodeLibraryPair("beta", "fr");
    const versions = {
      [alpha]: Array.from({ length: 120 }, (_, i) => entry({ version: i + 1, string_key: "alpha", locale: "es" })),
      [beta]: Array.from({ length: 120 }, (_, i) => entry({ version: i + 1, string_key: "beta", locale: "fr" })),
    };
    const calls: Array<{ key: string; offset: number; limit: number }> = [];
    const deps = mockDeps({
      rows: [approvedRow("t1", "alpha", "es"), approvedRow("t2", "beta", "fr")],
      versions,
      listCalls: calls,
    });
    const discovery = await discoverLibraryPage(0, undefined, deps);
    expect(discovery.uniqueApprovedTaskCount).toBe(2);
    expect(discovery.groups).toHaveLength(2);
    expect(discovery.groups.every((g) => g.versions.length === 50)).toBe(true);
    expect(discovery.incompleteVersionGroups).toBe(2);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.offset === 0 && c.limit === 50)).toBe(true);
  });

  it("keeps loaded versions when a later page fails and retries", async () => {
    const key = encodeLibraryPair("k", "es");
    const versions = { [key]: Array.from({ length: 51 }, (_, i) => entry({ version: i + 1, string_key: "k", locale: "es" })) };
    const failing = mockDeps({
      rows: [approvedRow("t1", "k")],
      versions,
      failListAt: { key, offset: 50 },
    });
    const first = await discoverLibraryPage(0, undefined, failing);
    const interrupted = await loadMoreVersionsForPair(first, "k", "es", failing);
    expect(interrupted.groups[0]?.versions).toHaveLength(50);
    expect(interrupted.groups[0]?.versionsComplete).toBe(false);
    expect(interrupted.groups[0]?.versionReadError).toMatch(/list_library RPC down/);
    const ok = mockDeps({ rows: [approvedRow("t1", "k")], versions });
    const retried = await loadNextLibraryVersionPage(interrupted.groups[0]!, ok);
    expect(retried.versions).toHaveLength(51);
    expect(retried.versionsComplete).toBe(true);
    expect(retried.versionReadError).toBeUndefined();
  });

  it("keeps an empty group incomplete when library_version_count fails", async () => {
    const key = encodeLibraryPair("k", "es");
    const deps = mockDeps({
      rows: [approvedRow("t1", "k")],
      versions: { [key]: [entry({ version: 1, string_key: "k", locale: "es" })] },
      failCountKeys: [key],
    });
    const discovery = await discoverLibraryPage(0, undefined, deps);
    expect(discovery.groups[0]?.versions).toEqual([]);
    expect(discovery.groups[0]?.versionsComplete).toBe(false);
    expect(discovery.groups[0]?.versionReadError).toMatch(/count RPC down/);
  });

  it("does not discard a loaded first page when loading another incomplete key fails", async () => {
    const alpha = encodeLibraryPair("alpha", "es");
    const beta = encodeLibraryPair("beta", "fr");
    const versions = {
      [alpha]: Array.from({ length: 51 }, (_, i) => entry({ version: i + 1, string_key: "alpha", locale: "es" })),
      [beta]: Array.from({ length: 51 }, (_, i) => entry({ version: i + 1, string_key: "beta", locale: "fr" })),
    };
    const first = await discoverLibraryPage(
      0,
      undefined,
      mockDeps({
        rows: [approvedRow("t1", "alpha", "es"), approvedRow("t2", "beta", "fr")],
        versions,
      }),
    );
    expect(first.groups.every((g) => g.versions.length === 50)).toBe(true);
    const mixed: LibraryDiscoveryDeps = {
      ...mockDeps({
        rows: [approvedRow("t1", "alpha", "es"), approvedRow("t2", "beta", "fr")],
        versions,
        failListAt: { key: beta, offset: 50 },
      }),
    };
    const next = await loadNextVersionPageForIncompleteGroups(first, mixed);
    const alphaGroup = next.groups.find((g) => g.string_key === "alpha");
    const betaGroup = next.groups.find((g) => g.string_key === "beta");
    expect(alphaGroup?.versions).toHaveLength(51);
    expect(alphaGroup?.versionsComplete).toBe(true);
    expect(betaGroup?.versions).toHaveLength(50);
    expect(betaGroup?.versionReadError).toMatch(/RPC down/);
  });

  it("starts a fresh group at offset 0", () => {
    const group = emptyLibraryGroup("k", "es");
    expect(nextLibraryVersionWindow({ ...group, versionCount: 51 })).toEqual({ offset: 0, length: 50 });
    expect(libraryVersionPageWindows(51, 50)[0]).toEqual({ offset: 0, length: 50 });
  });
});

describe("fail-closed library pagination", () => {
  it("keeps an unreadable library_version_count visible as incomplete with an error", async () => {
    const key = encodeLibraryPair("k", "es");
    const listCalls: Array<{ key: string; offset: number; limit: number }> = [];
    const deps = mockDeps({
      rows: [approvedRow("t1", "k")],
      versions: { [key]: [entry({ version: 1, string_key: "k", locale: "es" })] },
      unreadableCountKeys: [key],
      listCalls,
    });
    const discovery = await discoverLibraryPage(0, undefined, deps);
    expect(discovery.groups).toHaveLength(1);
    expect(discovery.groups[0]?.versionsComplete).toBe(false);
    expect(discovery.groups[0]?.versionReadError).toMatch(/unreadable/);
    expect(discovery.incompleteVersionGroups).toBe(1);
    expect(listCalls).toEqual([]);
  });

  it("does not treat a later unreadable count as an empty completed library", async () => {
    const key = encodeLibraryPair("k", "es");
    const versions = { [key]: Array.from({ length: 51 }, (_, i) => entry({ version: i + 1, string_key: "k", locale: "es" })) };
    const first = await discoverLibraryPage(0, undefined, mockDeps({ rows: [approvedRow("t1", "k")], versions }));
    expect(first.groups[0]?.versions).toHaveLength(50);
    const next = await loadMoreVersionsForPair(
      first,
      "k",
      "es",
      mockDeps({ rows: [approvedRow("t1", "k")], versions, unreadableCountKeys: [key] }),
    );
    expect(next.groups[0]?.versions).toHaveLength(50);
    expect(next.groups[0]?.versionsComplete).toBe(false);
    expect(next.groups[0]?.nextVersionOffset).toBe(50);
    expect(next.groups[0]?.versionReadError).toMatch(/unreadable/);
  });

  it("keeps a valid prefix and stays incomplete when a page is missing entries", async () => {
    const page = acceptSequentialLibraryPage({
      stringKey: "k",
      locale: "es",
      offset: 0,
      length: 3,
      existing: [],
      raw: [
        entry({ version: 1, string_key: "k", locale: "es" }),
        entry({ version: 2, string_key: "k", locale: "es" }),
      ],
    });
    expect(page.ok).toBe(false);
    if (page.ok) throw new Error("expected fail-closed missing page");
    expect(page.accepted.map((e) => e.version)).toEqual([1, 2]);
    expect(page.reason).toMatch(/missing versions at offset 2/);
  });

  it("rejects a malformed slot without skipping later versions", async () => {
    const page = acceptSequentialLibraryPage({
      stringKey: "k",
      locale: "es",
      offset: 0,
      length: 3,
      existing: [],
      raw: [
        entry({ version: 1, string_key: "k", locale: "es" }),
        { version: 2 },
        entry({ version: 3, string_key: "k", locale: "es" }),
      ],
    });
    expect(page.ok).toBe(false);
    if (page.ok) throw new Error("expected malformed slot");
    expect(page.accepted.map((e) => e.version)).toEqual([1]);
    expect(page.reason).toMatch(/malformed.*version 2/);
  });

  it("rejects duplicate versions without advancing past the hole", async () => {
    const page = acceptSequentialLibraryPage({
      stringKey: "k",
      locale: "es",
      offset: 0,
      length: 3,
      existing: [entry({ version: 1, string_key: "k", locale: "es" })],
      raw: [
        entry({ version: 1, string_key: "k", locale: "es" }),
        entry({ version: 2, string_key: "k", locale: "es" }),
        entry({ version: 3, string_key: "k", locale: "es" }),
      ],
    });
    expect(page.ok).toBe(false);
    if (page.ok) throw new Error("expected duplicate");
    expect(page.accepted).toEqual([]);
    expect(page.reason).toMatch(/duplicate version 1/);
  });

  it("shows an approved task with library_version_count 0 as incomplete inconsistency, not an empty completed group", async () => {
    const listCalls: Array<{ key: string; offset: number; limit: number }> = [];
    const deps = mockDeps({
      rows: [approvedRow("approved-missing-lib", "k")],
      versions: {},
      listCalls,
    });
    const discovery = await discoverLibraryPage(0, undefined, deps);
    expect(discovery.groups).toHaveLength(1);
    expect(discovery.groups[0]?.string_key).toBe("k");
    expect(discovery.groups[0]?.locale).toBe("es");
    expect(discovery.groups[0]?.approvedTaskIds).toEqual(["approved-missing-lib"]);
    expect(discovery.groups[0]?.versionCount).toBe(0);
    expect(discovery.groups[0]?.versions).toEqual([]);
    expect(discovery.groups[0]?.versionsComplete).toBe(false);
    expect(discovery.groups[0]?.versionReadError).toMatch(/inconsistent library.*library_version_count is 0/i);
    expect(discovery.incompleteVersionGroups).toBe(1);
    expect(listCalls).toEqual([]);
  });

  it("rejects a wrong key or version gap and does not mark the pair complete", async () => {
    const key = encodeLibraryPair("k", "es");
    const versions = { [key]: Array.from({ length: 3 }, (_, i) => entry({ version: i + 1, string_key: "k", locale: "es" })) };
    const wrongKey = mockDeps({
      rows: [approvedRow("t1", "k")],
      versions,
      listOverride: () => [
        entry({ version: 1, string_key: "k", locale: "es" }),
        entry({ version: 2, string_key: "other", locale: "es" }),
        entry({ version: 3, string_key: "k", locale: "es" }),
      ],
    });
    const discovery = await discoverLibraryPage(0, undefined, wrongKey);
    expect(discovery.groups[0]?.versions.map((e) => e.version)).toEqual([1]);
    expect(discovery.groups[0]?.nextVersionOffset).toBe(1);
    expect(discovery.groups[0]?.versionsComplete).toBe(false);
    expect(discovery.groups[0]?.versionReadError).toMatch(/wrong string_key or locale/);

    const gap = acceptSequentialLibraryPage({
      stringKey: "k",
      locale: "es",
      offset: 0,
      length: 3,
      existing: [],
      raw: [
        entry({ version: 1, string_key: "k", locale: "es" }),
        entry({ version: 3, string_key: "k", locale: "es" }),
        entry({ version: 4, string_key: "k", locale: "es" }),
      ],
    });
    expect(gap.ok).toBe(false);
    if (gap.ok) throw new Error("expected version gap");
    expect(gap.accepted.map((e) => e.version)).toEqual([1]);
    expect(gap.reason).toMatch(/expected 2.*got 3/);
  });
});
