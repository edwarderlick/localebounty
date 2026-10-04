import { addressesEqual } from "../format";
import { parseProductTask, type ProductTask } from "../product/task";
import { DECISION_NONE, STATE_ACCEPTED, STATE_OPEN } from "./constants";

export type ProductV2Task = ProductTask & { accepted_at_unix: number };

function asInt(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10);
  return 0;
}

export function parseProductV2Task(raw: unknown): ProductV2Task | undefined {
  const base = parseProductTask(raw);
  if (!base) return undefined;
  const rec = raw as Record<string, unknown>;
  return {
    ...base,
    accepted_at_unix: asInt(rec.accepted_at_unix ?? rec.acceptedAtUnix),
  };
}

export type TaskMatch = { ok: true } | { ok: false; reason: string };

export function createdV2TaskMatchesBound(input: {
  task: ProductV2Task | undefined;
  funder: string;
  translator: string;
  rewardWei: string;
  clientNonce: string;
  expectedTaskId: string;
  submitByUnix: number;
  recoverAfterUnix: number;
}): TaskMatch {
  const task = input.task;
  if (!task) return { ok: false, reason: "get_task did not return a parseable V2 task for this session." };
  if (task.task_id !== input.expectedTaskId) {
    return { ok: false, reason: `On-chain task_id ${task.task_id} does not match nonce-derived ${input.expectedTaskId}.` };
  }
  if (!addressesEqual(task.funder, input.funder)) {
    return { ok: false, reason: `Stored funder ${task.funder} does not match this session ${input.funder}.` };
  }
  if (!addressesEqual(task.translator, input.translator)) {
    return { ok: false, reason: `Stored translator ${task.translator} does not match this session ${input.translator}.` };
  }
  if (task.rewardWei !== input.rewardWei) {
    return { ok: false, reason: `Stored reward ${task.rewardWei} wei does not match this session ${input.rewardWei} wei.` };
  }
  if (task.client_nonce !== input.clientNonce) {
    return { ok: false, reason: "Stored client_nonce does not match this session nonce." };
  }
  if (task.submit_by_unix !== input.submitByUnix || task.recover_after_unix !== input.recoverAfterUnix) {
    return {
      ok: false,
      reason: `Stored deadlines submit_by=${task.submit_by_unix} recover_after=${task.recover_after_unix} do not match this session.`,
    };
  }
  return { ok: true };
}

export function taskMatchesOpenUnaccepted(input: {
  task: ProductV2Task | undefined;
  funder: string;
  translator: string;
  rewardWei: string;
  clientNonce: string;
  expectedTaskId: string;
  submitByUnix: number;
  recoverAfterUnix: number;
}): TaskMatch {
  const bound = createdV2TaskMatchesBound(input);
  if (!bound.ok) return bound;
  const task = input.task!;
  if (task.state !== STATE_OPEN) {
    return { ok: false, reason: `Task state is ${task.state}, expected ${STATE_OPEN}. Cancel stays disabled.` };
  }
  if (task.accepted_at_unix !== 0) {
    return { ok: false, reason: "Task is already accepted. Funder cancel is unavailable after accept_task." };
  }
  if (task.translation !== "") return { ok: false, reason: "Task already has a translation. Cancel is not allowed." };
  if (task.decision !== DECISION_NONE) {
    return { ok: false, reason: `Task decision is ${task.decision}, expected none.` };
  }
  if (task.payout_submitted) {
    return { ok: false, reason: "Task already has payout_submitted. Cancel stays disabled." };
  }
  return { ok: true };
}

export function taskMatchesAccepted(input: {
  task: ProductV2Task | undefined;
  funder: string;
  translator: string;
  rewardWei: string;
  clientNonce: string;
  expectedTaskId: string;
  submitByUnix: number;
  recoverAfterUnix: number;
}): TaskMatch {
  const bound = createdV2TaskMatchesBound(input);
  if (!bound.ok) return bound;
  const task = input.task!;
  if (task.state !== STATE_ACCEPTED) {
    return { ok: false, reason: `Task state is ${task.state}, expected ${STATE_ACCEPTED}.` };
  }
  if (task.accepted_at_unix <= 0) {
    return { ok: false, reason: "get_task accepted_at_unix is still 0." };
  }
  if (task.translation !== "") return { ok: false, reason: "Task already has a translation." };
  if (task.decision !== DECISION_NONE) {
    return { ok: false, reason: `Task decision is ${task.decision}, expected none.` };
  }
  return { ok: true };
}

export function taskMatchesExpireable(input: {
  task: ProductV2Task | undefined;
  funder: string;
  translator: string;
  rewardWei: string;
  clientNonce: string;
  expectedTaskId: string;
  submitByUnix: number;
  recoverAfterUnix: number;
}): TaskMatch {
  const bound = createdV2TaskMatchesBound(input);
  if (!bound.ok) return bound;
  const task = input.task!;
  if (task.state !== STATE_OPEN && task.state !== STATE_ACCEPTED) {
    return { ok: false, reason: `Task state is ${task.state}; expire needs open or accepted with no translation.` };
  }
  if (task.translation !== "") return { ok: false, reason: "already submitted" };
  if (task.decision !== DECISION_NONE || task.payout_submitted) {
    return { ok: false, reason: "Task is already decided." };
  }
  return { ok: true };
}

export function createV2TaskArgs(input: {
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

export function laneBCancelUnavailableReason(task: ProductV2Task | undefined): string {
  if (task && (task.state === STATE_ACCEPTED || task.accepted_at_unix > 0)) {
    return "Funder cancel is unavailable after accept_task. Wait until now > submit_by_unix, then any connected wallet may Estimate and Sign expire_unsubmitted_task. The refund recipient is the stored funder.";
  }
  return "Funder cancel is available while Lane B is OPEN and unaccepted. After accept_task, cancel stays unavailable and expire_unsubmitted_task is used after the exclusive submit deadline.";
}
