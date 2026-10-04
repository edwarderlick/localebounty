import { isEoaAddress } from "../format";

export type LibraryEntry = {
  version: number;
  task_id: string;
  translation: string;
  source_text: string;
  string_key: string;
  locale: string;
  approved_at_unix: number;
  raw: unknown;
};

function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "bigint") return value.toString();
  return "";
}

function asInt(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10);
  return 0;
}

export function parseLibraryVersionCount(raw: unknown): number | undefined {
  if (typeof raw === "bigint") return Number(raw);
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.trunc(raw);
  if (typeof raw === "string" && /^-?\d+$/.test(raw.trim())) return Number.parseInt(raw.trim(), 10);
  return undefined;
}

export function parseLibraryEntry(raw: unknown): LibraryEntry | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const rec = raw as Record<string, unknown>;
  const task_id = asString(rec.task_id ?? rec.taskId);
  const translation = asString(rec.translation);
  const string_key = asString(rec.string_key ?? rec.stringKey);
  const locale = asString(rec.locale);
  const version = asInt(rec.version);
  if (!task_id || !string_key || !locale || version <= 0) return undefined;
  return {
    version,
    task_id,
    translation,
    source_text: asString(rec.source_text ?? rec.sourceText),
    string_key,
    locale,
    approved_at_unix: asInt(rec.approved_at_unix ?? rec.approvedAtUnix),
    raw,
  };
}

export function libraryEntryMatchesTask(input: {
  entry: LibraryEntry | undefined;
  taskId: string;
  translation: string;
  stringKey: string;
  locale: string;
}): { ok: true } | { ok: false; reason: string } {
  const entry = input.entry;
  if (!entry) return { ok: false, reason: "No library entry was returned." };
  if (entry.task_id !== input.taskId) {
    return { ok: false, reason: `Library task_id ${entry.task_id} does not match this session ${input.taskId}.` };
  }
  if (entry.translation !== input.translation) {
    return { ok: false, reason: "Library translation does not match the exact submitted translation." };
  }
  if (entry.string_key !== input.stringKey || entry.locale !== input.locale) {
    return { ok: false, reason: "Library string_key/locale do not match this task." };
  }
  return { ok: true };
}

export function assertNoLibraryForTask(input: {
  count: number | undefined;
  entry: LibraryEntry | undefined;
  taskId: string;
}): { ok: true } | { ok: false; reason: string } {
  if (input.entry && input.entry.task_id === input.taskId) {
    return { ok: false, reason: `Library still has an entry for task ${input.taskId}. Reject/timeout must not publish.` };
  }
  if (input.count == null) {
    return { ok: false, reason: "library_version_count was not read. Library absence is UNPROVEN." };
  }
  return { ok: true };
}

/** Reject path: this string_key's version count must not move, and no entry may belong to this task. */
export function libraryUnchangedForReject(input: {
  countBefore: number | undefined;
  countAfter: number | undefined;
  entry: LibraryEntry | undefined;
  taskId: string;
}): { ok: true } | { ok: false; reason: string } {
  if (input.countBefore == null) {
    return { ok: false, reason: "library_version_count before evaluate was not stored. Library absence is UNPROVEN." };
  }
  if (input.countAfter == null) {
    return { ok: false, reason: "library_version_count after evaluate was not read. Library absence is UNPROVEN." };
  }
  if (input.countAfter !== input.countBefore) {
    return {
      ok: false,
      reason: `library_version_count changed from ${input.countBefore} to ${input.countAfter}. Reject must leave this key unchanged.`,
    };
  }
  return assertNoLibraryForTask({ count: input.countAfter, entry: input.entry, taskId: input.taskId });
}

export function isEoaPair(funder: string, translator: string): boolean {
  return isEoaAddress(funder) && isEoaAddress(translator);
}
