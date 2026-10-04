import { isEoaAddress } from "../format";
import { LIST_PAGE_LIMIT } from "./constants";
import { asBool, asInt, asString, asWei } from "./parse";

/** Compact `list_tasks` row. No 4096-character text fields. */
export type LiveTaskSummary = {
  task_id: string;
  funder: string;
  translator: string;
  rewardWei: string;
  source_locale: string;
  target_locale: string;
  string_key: string;
  state: string;
  decision: string;
  payment_status: string;
  payment_kind: string;
  payout_submitted: boolean;
  created_at_unix: number;
  submit_by_unix: number;
  recover_after_unix: number;
  submitted_at_unix: number;
  decided_at_unix: number;
  recovery_opens_at_unix: number;
  client_nonce: string;
};

export function parseTaskSummary(raw: unknown): LiveTaskSummary | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const rec = raw as Record<string, unknown>;
  const task_id = asString(rec.task_id ?? rec.taskId);
  const funder = asString(rec.funder);
  const translator = asString(rec.translator);
  if (!task_id || !isEoaAddress(funder) || !isEoaAddress(translator)) return undefined;
  return {
    task_id,
    funder,
    translator,
    rewardWei: asWei(rec.reward ?? rec.rewardWei),
    source_locale: asString(rec.source_locale ?? rec.sourceLocale),
    target_locale: asString(rec.target_locale ?? rec.targetLocale),
    string_key: asString(rec.string_key ?? rec.stringKey),
    state: asString(rec.state),
    decision: asString(rec.decision),
    payment_status: asString(rec.payment_status ?? rec.paymentStatus),
    payment_kind: asString(rec.payment_kind ?? rec.paymentKind),
    payout_submitted: asBool(rec.payout_submitted ?? rec.payoutSubmitted),
    created_at_unix: asInt(rec.created_at_unix ?? rec.createdAtUnix),
    submit_by_unix: asInt(rec.submit_by_unix ?? rec.submitByUnix),
    recover_after_unix: asInt(rec.recover_after_unix ?? rec.recoverAfterUnix),
    submitted_at_unix: asInt(rec.submitted_at_unix ?? rec.submittedAtUnix),
    decided_at_unix: asInt(rec.decided_at_unix ?? rec.decidedAtUnix),
    recovery_opens_at_unix: asInt(rec.recovery_opens_at_unix ?? rec.recoveryOpensAtUnix),
    client_nonce: asString(rec.client_nonce ?? rec.clientNonce),
  };
}

export function parseTaskSummaryList(raw: unknown): LiveTaskSummary[] {
  if (!Array.isArray(raw)) return [];
  const out: LiveTaskSummary[] = [];
  for (const item of raw) {
    const parsed = parseTaskSummary(item);
    if (parsed) out.push(parsed);
  }
  return out;
}

export function clampListLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit < 1) return 1;
  return Math.min(Math.trunc(limit), LIST_PAGE_LIMIT);
}

export function clampListOffset(offset: number, count: number): number {
  if (!Number.isFinite(offset) || offset < 0) return 0;
  if (!Number.isFinite(count) || count <= 0) return 0;
  return Math.min(Math.trunc(offset), count);
}

export type NewestPageWindow = {
  offset: number;
  length: number;
  moreOlder: boolean;
};

/**
 * Newest-first page over an append-only `task_ids` list.
 * The last page is a remainder (e.g. 51 → 50 + 1, 75 → 50 + 25, 120 → 50 + 50 + 20).
 * Sequential windows are disjoint and cover `0 .. count-1` exactly.
 */
export function newestPageWindow(count: number, limit: number, pagesFromEnd = 0): NewestPageWindow {
  const l = clampListLimit(limit);
  const c = Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0;
  const page = Number.isFinite(pagesFromEnd) && pagesFromEnd > 0 ? Math.trunc(pagesFromEnd) : 0;
  if (c === 0) return { offset: 0, length: 0, moreOlder: false };
  const endExclusive = c - page * l;
  if (endExclusive <= 0) return { offset: 0, length: 0, moreOlder: false };
  const offset = Math.max(0, endExclusive - l);
  return { offset, length: endExclusive - offset, moreOlder: offset > 0 };
}

/** Newest-first page: offset is counted from the end of the append-only task_ids list. */
export function newestPageOffset(count: number, limit: number, pagesFromEnd = 0): number {
  return newestPageWindow(count, limit, pagesFromEnd).offset;
}

export function newestPageWindows(count: number, limit: number): NewestPageWindow[] {
  const windows: NewestPageWindow[] = [];
  let page = 0;
  while (true) {
    const window = newestPageWindow(count, limit, page);
    if (window.length === 0) break;
    windows.push(window);
    if (!window.moreOlder) break;
    page += 1;
  }
  return windows;
}

export function pageWindowsCoverExactly(count: number, windows: NewestPageWindow[]): boolean {
  const c = Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0;
  const seen = new Set<number>();
  for (const window of windows) {
    if (window.length <= 0) continue;
    for (let i = 0; i < window.length; i++) {
      const index = window.offset + i;
      if (index < 0 || index >= c || seen.has(index)) return false;
      seen.add(index);
    }
  }
  return seen.size === c;
}

export function mergeTaskSummaries(existing: LiveTaskSummary[], incoming: LiveTaskSummary[]): LiveTaskSummary[] {
  const map = new Map<string, LiveTaskSummary>();
  for (const row of existing) map.set(row.task_id, row);
  for (const row of incoming) map.set(row.task_id, row);
  return [...map.values()];
}

export function uniqueTaskIds(rows: Array<{ task_id: string }>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    if (!row.task_id || seen.has(row.task_id)) continue;
    seen.add(row.task_id);
    out.push(row.task_id);
  }
  return out;
}

export function belongsToWallet(summary: LiveTaskSummary, wallet?: string): boolean {
  if (!wallet) return false;
  const addr = wallet.trim().toLowerCase();
  return summary.funder.toLowerCase() === addr || summary.translator.toLowerCase() === addr;
}
