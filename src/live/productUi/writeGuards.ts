import { addressesEqual } from "../format";
import { hasTxId, isFinalizedSuccessful, isTerminalFailure, neverResubmit } from "../guards";
import { STUDIO_DEV_CHAIN_ID } from "../network";
import { rememberedGenvmUnix } from "../product/clock";
import type { ProductTask } from "../product/task";
import {
  DECISION_NONE,
  KIND_REFUND,
  MAX_TEXT,
  STATE_CANCELLED,
  STATE_OPEN,
  STATE_SUBMITTED,
  STATE_TIMED_OUT,
} from "./constants";
import type { ProductUiWriteRecord } from "./writes";

export type GuardResult = { ok: true } | { ok: false; reason: string };

export type ProductUiWriteContext = {
  wallet?: string;
  chainId?: number;
  connected: boolean;
};

function fail(reason: string): GuardResult {
  return { ok: false, reason };
}

export { hasTxId, isFinalizedSuccessful, isTerminalFailure, neverResubmit };

export function productUiWriteWalletReady(ctx: ProductUiWriteContext): GuardResult {
  if (!ctx.wallet) {
    return fail(ctx.connected ? "Unlock the connected wallet. Tracking was not cleared." : "Connect a wallet first.");
  }
  if (!ctx.connected) return fail("Connect a wallet first.");
  if (ctx.chainId !== STUDIO_DEV_CHAIN_ID) {
    return fail(`Wrong chain (${ctx.chainId ?? "unknown"}). Switch to Studio-dev ${STUDIO_DEV_CHAIN_ID}.`);
  }
  return { ok: true };
}

export function isNamedTranslator(task: ProductTask, wallet?: string): boolean {
  return Boolean(wallet && addressesEqual(wallet, task.translator));
}

export function isTaskFunder(task: ProductTask, wallet?: string): boolean {
  return Boolean(wallet && addressesEqual(wallet, task.funder));
}

export function submitWindowOpen(task: ProductTask, executionUnix: number, genvmUnix?: number): GuardResult {
  if (executionUnix <= task.submit_by_unix) return { ok: true };
  return fail(
    `Submission window expired on the execution clock. submit_by_unix=${task.submit_by_unix}, executionClock=${executionUnix}${
      genvmUnix != null
        ? `. Remembered GenVM ${genvmUnix} is the fee-simulation clock only and does not reopen signing.`
        : ""
    }.`,
  );
}

export function submitTextReady(text: string): GuardResult {
  const trimmed = text.trim();
  if (!trimmed) return fail("Enter a translation. It is stored on-chain before AI evaluation.");
  if (trimmed.length > MAX_TEXT) return fail(`Translation exceeds MAX_TEXT (${MAX_TEXT}).`);
  return { ok: true };
}

export function submitEstimateAllowed(input: {
  task: ProductTask | undefined;
  record: ProductUiWriteRecord;
  ctx: ProductUiWriteContext;
  translation: string;
  wallUnix?: number;
  genvmUnix?: number;
}): GuardResult {
  const ready = productUiWriteWalletReady(input.ctx);
  if (!ready.ok) return ready;
  const task = input.task;
  if (!task) return fail("get_task has not returned this task. Submit stays disabled.");
  if (!addressesEqual(task.translator, input.ctx.wallet ?? "")) {
    return fail(
      `Only the named translator ${task.translator} may estimate or sign submit_translation. Connected wallet is a read-only viewer.`,
    );
  }
  if (hasTxId(input.record)) {
    return fail(`Submit already has transaction ID ${input.record.txId}. Resume tracking; do not resubmit.`);
  }
  if (task.state !== STATE_OPEN) return fail(`Task state is ${task.state}, expected ${STATE_OPEN}.`);
  if (task.translation !== "") return fail("Task already has a stored translation.");
  const window = submitWindowOpen(
    task,
    input.wallUnix ?? Math.floor(Date.now() / 1000),
    input.genvmUnix ?? input.record.rememberedGenvmUnix ?? rememberedGenvmUnix(),
  );
  if (!window.ok) return window;
  return submitTextReady(input.translation);
}

export function submitSignAllowed(input: {
  task: ProductTask | undefined;
  record: ProductUiWriteRecord;
  ctx: ProductUiWriteContext;
  translation: string;
  wallUnix?: number;
  genvmUnix?: number;
}): GuardResult {
  const estimate = submitEstimateAllowed(input);
  if (!estimate.ok) return estimate;
  if (!input.record.boundTranslation) return fail("Estimate first so the exact translation text is bound to this quote.");
  if (input.translation.trim() !== input.record.boundTranslation) {
    return fail("Translation text changed since Estimate. Estimate again.");
  }
  return { ok: true };
}

export function submitConfirmStored(task: ProductTask | undefined, boundTranslation: string | undefined): GuardResult {
  if (!task) return fail("get_task has not matched this submit yet.");
  if (!boundTranslation) return fail("Bound translation is missing.");
  if (task.translation !== boundTranslation) {
    return fail("On-chain translation does not match the exact signed text.");
  }
  if (task.state !== STATE_SUBMITTED) {
    return fail(`Task state after submit is ${task.state}, expected ${STATE_SUBMITTED}.`);
  }
  return { ok: true };
}

export function evaluateEstimateAllowed(input: {
  task: ProductTask | undefined;
  record: ProductUiWriteRecord;
  ctx: ProductUiWriteContext;
}): GuardResult {
  const ready = productUiWriteWalletReady(input.ctx);
  if (!ready.ok) return ready;
  if (hasTxId(input.record) && !isTerminalFailure(input.record)) {
    return fail(`Evaluate already has transaction ID ${input.record.txId}. Resume tracking; do not resubmit.`);
  }
  if (hasTxId(input.record) && isTerminalFailure(input.record)) {
    return fail("This evaluate hash finished without success. Use New attempt for a new estimate. Do not resubmit that hash.");
  }
  const task = input.task;
  if (!task) return fail("Refresh get_task first.");
  if (task.state !== STATE_SUBMITTED) {
    return fail(`Task state is ${task.state}, expected ${STATE_SUBMITTED}. evaluate_task is available while the task stays submitted.`);
  }
  if (task.decision !== DECISION_NONE) {
    return fail(`Task decision is ${task.decision}. Evaluation is finished.`);
  }
  if (!task.translation) return fail("get_task has an empty translation. Submit is not proven.");
  return { ok: true };
}

export function evaluateSignAllowed(input: {
  task: ProductTask | undefined;
  record: ProductUiWriteRecord;
  ctx: ProductUiWriteContext;
}): GuardResult {
  return evaluateEstimateAllowed(input);
}

export function needsWriteResume(record: ProductUiWriteRecord): boolean {
  return Boolean(record.txId) && !isFinalizedSuccessful(record) && !isTerminalFailure(record);
}

export function failedEvaluateStillSubmitted(task: ProductTask | undefined, record: ProductUiWriteRecord): boolean {
  return Boolean(
    task &&
      task.state === STATE_SUBMITTED &&
      task.decision === DECISION_NONE &&
      isTerminalFailure(record),
  );
}

export function cancelReadyTask(task: ProductTask | undefined): GuardResult {
  if (!task) return fail("get_task has not returned this task. Cancel stays disabled.");
  if (task.state !== STATE_OPEN) return fail(`Task state is ${task.state}, expected ${STATE_OPEN}.`);
  if (task.translation !== "") return fail("Cancel is disabled after a stored translation.");
  if (task.decision !== DECISION_NONE) return fail(`Task decision is ${task.decision}. Cancel is disabled.`);
  return { ok: true };
}

export function cancelEstimateAllowed(input: {
  task: ProductTask | undefined;
  record: ProductUiWriteRecord;
  ctx: ProductUiWriteContext;
}): GuardResult {
  const ready = productUiWriteWalletReady(input.ctx);
  if (!ready.ok) return ready;
  if (hasTxId(input.record) && !isTerminalFailure(input.record)) {
    return fail(`Cancel already has transaction ID ${input.record.txId}. Resume tracking; do not resubmit.`);
  }
  if (hasTxId(input.record) && isTerminalFailure(input.record)) {
    return fail("This cancel hash finished without success. Use New attempt for a new estimate. Do not resubmit that hash.");
  }
  const taskOk = cancelReadyTask(input.task);
  if (!taskOk.ok) return taskOk;
  if (!addressesEqual(input.task!.funder, input.ctx.wallet ?? "")) {
    return fail(
      `Only the funder ${input.task!.funder} may estimate or sign cancel_task. Connected wallet is a read-only viewer.`,
    );
  }
  return { ok: true };
}

export function cancelSignAllowed(input: {
  task: ProductTask | undefined;
  record: ProductUiWriteRecord;
  ctx: ProductUiWriteContext;
}): GuardResult {
  return cancelEstimateAllowed(input);
}

export function cancelConfirmStored(task: ProductTask | undefined): GuardResult {
  if (!task) return fail("get_task has not matched this cancel yet.");
  if (task.state !== STATE_CANCELLED) {
    return fail(`Task state after cancel is ${task.state}, expected ${STATE_CANCELLED}.`);
  }
  if (task.decision !== STATE_CANCELLED) {
    return fail(`Task decision after cancel is ${task.decision}, expected ${STATE_CANCELLED}.`);
  }
  if (task.payment_kind !== KIND_REFUND) {
    return fail(`payment_kind after cancel is ${task.payment_kind || "none"}, expected ${KIND_REFUND}.`);
  }
  return { ok: true };
}

export function recoveryWindowOpen(task: ProductTask, wallUnix: number, genvmUnix?: number): GuardResult {
  const opens = task.recovery_opens_at_unix;
  if (!opens) return fail("get_task did not return recovery_opens_at_unix. Recover stays disabled.");
  if (wallUnix >= opens) return { ok: true };
  if (genvmUnix != null && genvmUnix >= opens) return { ok: true };
  return fail(
    `Recover is disabled until recovery_opens_at_unix=${opens}. wall=${wallUnix}${
      genvmUnix != null ? `, remembered genvm=${genvmUnix}` : ""
    }. The task stays submitted. Signing is not automatic.`,
  );
}

export function recoverReadyTask(task: ProductTask | undefined): GuardResult {
  if (!task) return fail("Refresh get_task first.");
  if (task.state !== STATE_SUBMITTED) {
    return fail(`Task state is ${task.state}, expected ${STATE_SUBMITTED}. recover_undecided_task needs an undecided submission.`);
  }
  if (task.decision !== DECISION_NONE) {
    return fail(`Task decision is ${task.decision}. Recovery is finished.`);
  }
  if (!task.translation) return fail("get_task has an empty translation. Submit is not proven.");
  return { ok: true };
}

export function recoverEstimateAllowed(input: {
  task: ProductTask | undefined;
  record: ProductUiWriteRecord;
  ctx: ProductUiWriteContext;
  wallUnix?: number;
  genvmUnix?: number;
}): GuardResult {
  const ready = productUiWriteWalletReady(input.ctx);
  if (!ready.ok) return ready;
  if (hasTxId(input.record) && !isTerminalFailure(input.record)) {
    return fail(`Recover already has transaction ID ${input.record.txId}. Resume tracking; do not resubmit.`);
  }
  if (hasTxId(input.record) && isTerminalFailure(input.record)) {
    return fail("This recover hash finished without success. Use New attempt for a new estimate. Do not resubmit that hash.");
  }
  const taskOk = recoverReadyTask(input.task);
  if (!taskOk.ok) return taskOk;
  return recoveryWindowOpen(
    input.task!,
    input.wallUnix ?? Math.floor(Date.now() / 1000),
    input.genvmUnix ?? input.record.rememberedGenvmUnix ?? rememberedGenvmUnix(),
  );
}

export function recoverSignAllowed(input: {
  task: ProductTask | undefined;
  record: ProductUiWriteRecord;
  ctx: ProductUiWriteContext;
  wallUnix?: number;
  genvmUnix?: number;
}): GuardResult {
  return recoverEstimateAllowed(input);
}

export function recoverConfirmStored(task: ProductTask | undefined): GuardResult {
  if (!task) return fail("get_task has not matched this recover yet.");
  if (task.state !== STATE_TIMED_OUT) {
    return fail(`Task state after recover is ${task.state}, expected ${STATE_TIMED_OUT}.`);
  }
  if (task.decision !== STATE_TIMED_OUT) {
    return fail(`Task decision after recover is ${task.decision}, expected ${STATE_TIMED_OUT}.`);
  }
  if (task.payment_kind !== KIND_REFUND) {
    return fail(`payment_kind after recover is ${task.payment_kind || "none"}, expected ${KIND_REFUND}.`);
  }
  return { ok: true };
}

export function failedSubmitStillOpen(task: ProductTask | undefined, record: ProductUiWriteRecord): boolean {
  return Boolean(task && cancelReadyTask(task).ok && isTerminalFailure(record));
}

export function failedCancelStillOpen(task: ProductTask | undefined, record: ProductUiWriteRecord): boolean {
  return Boolean(task && cancelReadyTask(task).ok && isTerminalFailure(record));
}

export function failedRecoverStillSubmitted(task: ProductTask | undefined, record: ProductUiWriteRecord): boolean {
  return Boolean(task && recoverReadyTask(task).ok && isTerminalFailure(record));
}
