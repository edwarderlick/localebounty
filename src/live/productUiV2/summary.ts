import { isEoaAddress } from "../format";
import { LIST_PAGE_LIMIT } from "./constants";
import { asBool, asInt, asString, asWei } from "../productUi/parse";
import {
  clampListLimit,
  clampListOffset,
  mergeTaskSummaries as mergeV1Summaries,
  newestPageWindow,
  type LiveTaskSummary,
} from "../productUi/summary";

export type V2TaskSummary = LiveTaskSummary & { accepted_at_unix: number };

export function parseV2TaskSummary(raw: unknown): V2TaskSummary | undefined {
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
    accepted_at_unix: asInt(rec.accepted_at_unix ?? rec.acceptedAtUnix),
    submit_by_unix: asInt(rec.submit_by_unix ?? rec.submitByUnix),
    recover_after_unix: asInt(rec.recover_after_unix ?? rec.recoverAfterUnix),
    submitted_at_unix: asInt(rec.submitted_at_unix ?? rec.submittedAtUnix),
    decided_at_unix: asInt(rec.decided_at_unix ?? rec.decidedAtUnix),
    recovery_opens_at_unix: asInt(rec.recovery_opens_at_unix ?? rec.recoveryOpensAtUnix),
    client_nonce: asString(rec.client_nonce ?? rec.clientNonce),
  };
}

export function parseV2TaskSummaryList(raw: unknown): V2TaskSummary[] {
  if (!Array.isArray(raw)) return [];
  const out: V2TaskSummary[] = [];
  for (const item of raw) {
    const parsed = parseV2TaskSummary(item);
    if (parsed) out.push(parsed);
  }
  return out;
}

export function mergeV2TaskSummaries(existing: V2TaskSummary[], incoming: V2TaskSummary[]): V2TaskSummary[] {
  return mergeV1Summaries(existing, incoming) as V2TaskSummary[];
}

export { clampListLimit, clampListOffset, newestPageWindow, LIST_PAGE_LIMIT };
