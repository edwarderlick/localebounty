import { isUserRejection } from "../eip1193";
import { formatError } from "../format";
import type { ActionRecord } from "../persist";

export const TRACKING_RESUME_HINT = "Resume tracking; do not resubmit that hash.";

export type AttemptHistoryEntry = {
  txId: string;
  archivedAt: number;
  statusName?: string;
  executionName?: string;
  parentSuccessful?: boolean;
  submittedAt?: number;
  error?: string;
  action?: string;
  taskId?: string;
};

export function trackingFailedAfterTxId(txId: string, err: unknown): string {
  return `Tracking failed after transaction ID ${txId} was stored. ${TRACKING_RESUME_HINT} ${formatError(err)}`;
}

export function preSubmitSignError(err: unknown): string {
  return isUserRejection(err) ? "Wallet rejected the signature." : formatError(err);
}

export function parseAttemptHistory(raw: unknown): AttemptHistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: AttemptHistoryEntry[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Partial<AttemptHistoryEntry>;
    if (typeof rec.txId !== "string" || !rec.txId.trim()) continue;
    const txId = rec.txId.trim();
    if (seen.has(txId.toLowerCase())) continue;
    seen.add(txId.toLowerCase());
    out.push({
      txId,
      archivedAt: typeof rec.archivedAt === "number" && Number.isFinite(rec.archivedAt) ? rec.archivedAt : 0,
      statusName: typeof rec.statusName === "string" ? rec.statusName : undefined,
      executionName: typeof rec.executionName === "string" ? rec.executionName : undefined,
      parentSuccessful: typeof rec.parentSuccessful === "boolean" ? rec.parentSuccessful : undefined,
      submittedAt: typeof rec.submittedAt === "number" ? rec.submittedAt : undefined,
      error: typeof rec.error === "string" ? rec.error : undefined,
      action: typeof rec.action === "string" ? rec.action : undefined,
      taskId: typeof rec.taskId === "string" ? rec.taskId : undefined,
    });
  }
  return out;
}

export function historyEntryFromTx(input: {
  txId: string;
  statusName?: string;
  executionName?: string;
  parentSuccessful?: boolean;
  submittedAt?: number;
  error?: string;
  action?: string;
  taskId?: string;
  archivedAt?: number;
}): AttemptHistoryEntry {
  return {
    txId: input.txId,
    archivedAt: input.archivedAt ?? Date.now(),
    statusName: input.statusName,
    executionName: input.executionName,
    parentSuccessful: input.parentSuccessful,
    submittedAt: input.submittedAt,
    error: input.error,
    action: input.action,
    taskId: input.taskId,
  };
}

export function appendAttemptHistory(
  history: AttemptHistoryEntry[] | undefined,
  entry: AttemptHistoryEntry,
): AttemptHistoryEntry[] {
  const next = parseAttemptHistory(history);
  if (next.some((item) => item.txId.toLowerCase() === entry.txId.toLowerCase())) return next;
  next.push(entry);
  return next;
}

export function historyHasTxId(history: AttemptHistoryEntry[] | undefined, txId: string | undefined): boolean {
  if (!txId) return false;
  return parseAttemptHistory(history).some((item) => item.txId.toLowerCase() === txId.toLowerCase());
}

type SignCatchRecord = {
  txId?: string;
  phase: ActionRecord["phase"];
  statusName?: string;
  error?: string;
};

/** Always start from the latest persisted record. Never overlay a stale React snapshot. */
export function applyTxSignCatch<T extends SignCatchRecord>(persisted: T, err: unknown): T {
  if (persisted.txId) {
    return {
      ...persisted,
      phase: persisted.statusName === "FINALIZED" ? persisted.phase : "waiting",
      error: trackingFailedAfterTxId(persisted.txId, err),
    };
  }
  const phase: ActionRecord["phase"] =
    persisted.phase === "signing" || persisted.phase === "submitted" ? "quoted" : persisted.phase;
  return {
    ...persisted,
    phase,
    error: preSubmitSignError(err),
  };
}
