import { addressesEqual, isEoaAddress } from "../format";
import { DECISION_NONE, STATE_OPEN } from "./constants";

export type ProductTask = {
  task_id: string;
  funder: string;
  translator: string;
  rewardWei: string;
  source_text: string;
  source_locale: string;
  target_locale: string;
  string_key: string;
  translation: string;
  state: string;
  decision: string;
  payment_status: string;
  payment_kind: string;
  payout_submitted: boolean;
  submit_by_unix: number;
  recover_after_unix: number;
  submitted_at_unix: number;
  decided_at_unix: number;
  recovery_opens_at_unix: number;
  app_context: string;
  intended_meaning: string;
  semantic_criteria: string;
  client_nonce: string;
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

function asBool(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

function asWei(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value)).toString();
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return value.trim();
  return "0";
}

export function parseProductTask(raw: unknown): ProductTask | undefined {
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
    source_text: asString(rec.source_text ?? rec.sourceText),
    source_locale: asString(rec.source_locale ?? rec.sourceLocale),
    target_locale: asString(rec.target_locale ?? rec.targetLocale),
    string_key: asString(rec.string_key ?? rec.stringKey),
    translation: asString(rec.translation),
    state: asString(rec.state),
    decision: asString(rec.decision),
    payment_status: asString(rec.payment_status ?? rec.paymentStatus),
    payment_kind: asString(rec.payment_kind ?? rec.paymentKind),
    payout_submitted: asBool(rec.payout_submitted ?? rec.payoutSubmitted),
    submit_by_unix: asInt(rec.submit_by_unix ?? rec.submitByUnix),
    recover_after_unix: asInt(rec.recover_after_unix ?? rec.recoverAfterUnix),
    submitted_at_unix: asInt(rec.submitted_at_unix ?? rec.submittedAtUnix),
    decided_at_unix: asInt(rec.decided_at_unix ?? rec.decidedAtUnix),
    recovery_opens_at_unix: asInt(rec.recovery_opens_at_unix ?? rec.recoveryOpensAtUnix),
    app_context: asString(rec.app_context ?? rec.appContext),
    intended_meaning: asString(rec.intended_meaning ?? rec.intendedMeaning),
    semantic_criteria: asString(rec.semantic_criteria ?? rec.semanticCriteria),
    client_nonce: asString(rec.client_nonce ?? rec.clientNonce),
    raw,
  };
}

export type TaskMatch = { ok: true } | { ok: false; reason: string };

export function createdTaskMatchesBound(input: {
  task: ProductTask | undefined;
  funder: string;
  translator: string;
  rewardWei: string;
  clientNonce: string;
  expectedTaskId: string;
  submitByUnix: number;
  recoverAfterUnix: number;
}): TaskMatch {
  const task = input.task;
  if (!task) return { ok: false, reason: "get_task did not return a parseable task for this session." };
  if (task.task_id !== input.expectedTaskId) {
    return { ok: false, reason: `On-chain task_id ${task.task_id} does not match nonce-derived ${input.expectedTaskId}.` };
  }
  if (!addressesEqual(task.funder, input.funder)) {
    return { ok: false, reason: `Stored funder ${task.funder} does not match connected wallet ${input.funder}.` };
  }
  if (!addressesEqual(task.translator, input.translator)) {
    return { ok: false, reason: `Stored translator ${task.translator} does not match this session ${input.translator}.` };
  }
  if (task.rewardWei !== input.rewardWei) {
    return { ok: false, reason: `Stored reward ${task.rewardWei} wei does not match this session ${input.rewardWei} wei.` };
  }
  if (task.client_nonce !== input.clientNonce) {
    return { ok: false, reason: `Stored client_nonce does not match this session nonce.` };
  }
  if (task.submit_by_unix !== input.submitByUnix || task.recover_after_unix !== input.recoverAfterUnix) {
    return {
      ok: false,
      reason: `Stored deadlines submit_by=${task.submit_by_unix} recover_after=${task.recover_after_unix} do not match this session.`,
    };
  }
  return { ok: true };
}

export function taskMatchesOpenCreate(input: {
  task: ProductTask | undefined;
  funder: string;
  translator: string;
  contract: string;
  rewardWei: string;
  clientNonce: string;
  expectedTaskId: string;
  submitByUnix: number;
  recoverAfterUnix: number;
}): TaskMatch {
  const bound = createdTaskMatchesBound(input);
  if (!bound.ok) return bound;
  const task = input.task!;
  if (task.state !== STATE_OPEN) {
    return { ok: false, reason: `Task state is ${task.state}, expected ${STATE_OPEN}. Cancel stays disabled.` };
  }
  if (task.translation !== "") {
    return { ok: false, reason: "Task already has a translation. Cancel is not allowed." };
  }
  if (task.decision !== DECISION_NONE) {
    return { ok: false, reason: `Task decision is ${task.decision}, expected none.` };
  }
  if (task.payout_submitted) {
    return { ok: false, reason: "Task already has payout_submitted. Cancel stays disabled." };
  }
  if (!input.contract) return { ok: false, reason: "No contract address in this session." };
  return { ok: true };
}

export function createTaskArgs(input: {
  clientNonce: string;
  translator: string;
  submitByUnix: number;
  recoverAfterUnix: number;
  sourceText: string;
  sourceLocale: string;
  targetLocale: string;
  stringKey: string;
  appContext: string;
  intendedMeaning: string;
  semanticCriteria: string;
}): unknown[] {
  return [
    input.clientNonce,
    input.sourceText,
    input.sourceLocale,
    input.targetLocale,
    input.stringKey,
    input.appContext,
    input.intendedMeaning,
    input.semanticCriteria,
    input.translator,
    input.submitByUnix,
    input.recoverAfterUnix,
  ];
}

export function genToWei(input: string): bigint | null {
  const trimmed = input.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const [whole, frac = ""] = trimmed.split(".");
  if (frac.length > 18) return null;
  const fracPadded = `${frac}000000000000000000`.slice(0, 18);
  try {
    return BigInt(whole) * 10n ** 18n + BigInt(fracPadded);
  } catch {
    return null;
  }
}

export function genRewardError(input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    return "Enter a GEN amount greater than zero (digits with optional fraction).";
  }
  const frac = trimmed.split(".")[1] ?? "";
  if (frac.length > 18) {
    return "GEN reward cannot have more than 18 fractional digits. Extra digits are rejected, not truncated.";
  }
  const wei = genToWei(trimmed);
  if (wei == null || wei <= 0n) return "Enter a GEN amount greater than zero.";
  return undefined;
}

/** Reward used for quotes, cancel, and payment proof. After create has a tx ID, ignore later input edits. */
export function sessionRewardWei(session: {
  create: { txId?: string; quotedValueWei?: string };
  boundRewardWei?: string;
  createTask?: { rewardWei: string };
  rewardGen: string;
}): bigint | null {
  if (session.create.txId) {
    const raw = session.boundRewardWei ?? session.create.quotedValueWei ?? session.createTask?.rewardWei;
    if (!raw) return null;
    try {
      const n = BigInt(raw);
      return n > 0n ? n : null;
    } catch {
      return null;
    }
  }
  return genToWei(session.rewardGen);
}
