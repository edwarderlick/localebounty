import { addressesEqual, isEoaAddress, isZeroAddress } from "../format";
import { hasTxId, isFinalizedSuccessful, isTerminalFailure, neverResubmit } from "../guards";
import { STUDIO_DEV_CHAIN_ID } from "../network";
import { createDeadlinesFromGenvm } from "../product/clock";
import { DEADLINE_STALE_SECONDS } from "../product/constants";
import { expectedTaskId, freshClientNonce } from "../product/taskId";
import { createFormErrors, formFingerprint, type CreateForm } from "../productUi/form";
import { acceptWindowOpen, expireWindowOpen, submitTranslationWindowOpen } from "../productV2/expireClock";
import type { ProductV2Task } from "../productV2/task";
import {
  DECISION_NONE,
  KIND_REFUND,
  MAX_TEXT,
  PRODUCT_UI_V2_CONTRACT,
  STATE_ACCEPTED,
  STATE_EXPIRED,
  STATE_CANCELLED,
  STATE_OPEN,
  STATE_SUBMITTED,
  STATE_TIMED_OUT,
} from "./constants";
import type { ProductUiV2Session } from "./persist";
import { sourceAllowsV2ProductCreate } from "./source";
import type { ProductUiV2WriteRecord } from "./writes";

export type GuardResult = { ok: true } | { ok: false; reason: string };

function fail(reason: string): GuardResult {
  return { ok: false, reason };
}

export { hasTxId, isFinalizedSuccessful, isTerminalFailure, neverResubmit };

export type ProductUiV2WriteContext = {
  wallet?: string;
  chainId?: number;
  connected: boolean;
};

export function v2ProductWalletReady(ctx: ProductUiV2WriteContext): GuardResult {
  if (!ctx.wallet) {
    return fail(ctx.connected ? "Unlock the connected wallet. Tracking was not cleared." : "Connect a wallet first.");
  }
  if (!ctx.connected) return fail("Connect a wallet first.");
  if (ctx.chainId !== STUDIO_DEV_CHAIN_ID) {
    return fail(`Wrong chain (${ctx.chainId ?? "unknown"}). Switch to Studio-dev ${STUDIO_DEV_CHAIN_ID}.`);
  }
  return { ok: true };
}

export function v2CreateSessionCompatible(session: ProductUiV2Session, funder: string | undefined): GuardResult {
  if (!session.boundFunder) return { ok: true };
  if (!funder) {
    return fail(`Persisted create tracking is bound to funder ${session.boundFunder}. Connect that wallet.`);
  }
  if (!addressesEqual(session.boundFunder, funder)) {
    return fail(
      `Persisted create tracking is bound to funder ${session.boundFunder}. Connected ${funder} is a different account.`,
    );
  }
  return { ok: true };
}

export function createEstimateAllowed(session: ProductUiV2Session, ctx: ProductUiV2WriteContext, form: CreateForm): GuardResult {
  const ready = v2ProductWalletReady(ctx);
  if (!ready.ok) return ready;
  if (hasTxId(session.create)) {
    return fail(`Create already has transaction ID ${session.create.txId}. Resume tracking; do not resubmit.`);
  }
  const source = sourceAllowsV2ProductCreate(session);
  if (!source.ok) return source;
  const translator = form.translator.trim();
  if (!isEoaAddress(translator) || isZeroAddress(translator)) {
    return fail("Enter a valid named translator EOA.");
  }
  if (ctx.wallet && addressesEqual(translator, ctx.wallet)) {
    return fail("Named translator must be a different EOA than the connected funder.");
  }
  const errors = createFormErrors(form, ctx.wallet);
  if (errors.length) return fail(errors[0] ?? "Form is incomplete.");
  return { ok: true };
}

export function createSignAllowed(session: ProductUiV2Session, ctx: ProductUiV2WriteContext, form: CreateForm): GuardResult {
  const estimate = createEstimateAllowed(session, ctx, form);
  if (!estimate.ok) return estimate;
  if (!session.clientNonce) {
    return fail("Estimate first so a client_nonce is bound to this unsubmitted create attempt.");
  }
  if (!session.expectedTaskId || session.submitByUnix == null || session.recoverAfterUnix == null) {
    return fail("Estimate first so deadlines and the nonce-derived task ID are bound before signing.");
  }
  if (session.formFingerprint && session.formFingerprint !== formFingerprint(form)) {
    return fail("Form values changed since the fee quote. Estimate again before signing.");
  }
  return { ok: true };
}

export function unsubmittedCreateNonce(session: ProductUiV2Session): string | undefined {
  if (session.create.txId) return undefined;
  return session.clientNonce;
}

export async function bindCreateEstimateIdentity(
  session: ProductUiV2Session,
  input: { funder: string; nonceFactory?: () => string; nowUnix: number },
): Promise<ProductUiV2Session> {
  if (session.create.txId) return session;
  const clientNonce = unsubmittedCreateNonce(session) ?? (input.nonceFactory ?? freshClientNonce)();
  const deadlines = createDeadlinesFromGenvm(input.nowUnix);
  const expectedTaskIdValue = await expectedTaskId(input.funder, PRODUCT_UI_V2_CONTRACT, clientNonce);
  return {
    ...session,
    clientNonce,
    submitByUnix: deadlines.submitByUnix,
    recoverAfterUnix: deadlines.recoverAfterUnix,
    expectedTaskId: expectedTaskIdValue,
  };
}

export function deadlinesStale(submitByUnix: number | undefined, nowUnix: number): boolean {
  if (submitByUnix == null) return true;
  return nowUnix + DEADLINE_STALE_SECONDS >= submitByUnix;
}

export function needsCreateTxResume(session: ProductUiV2Session): boolean {
  return Boolean(session.create.txId) && !isFinalizedSuccessful(session.create) && !isTerminalFailure(session.create);
}

export function isNamedTranslator(task: ProductV2Task, wallet?: string): boolean {
  return Boolean(wallet && addressesEqual(wallet, task.translator));
}

export function isTaskFunder(task: ProductV2Task, wallet?: string): boolean {
  return Boolean(wallet && addressesEqual(wallet, task.funder));
}

export function showV2Accept(task: ProductV2Task, nowUnix: number): boolean {
  return task.state === STATE_OPEN && task.accepted_at_unix === 0 && task.translation === "" && acceptWindowOpen(task.submit_by_unix, nowUnix);
}

export function showV2Cancel(task: ProductV2Task): boolean {
  return task.state === STATE_OPEN && task.accepted_at_unix === 0 && task.translation === "" && task.decision === DECISION_NONE;
}

export function acceptEstimateAllowed(input: {
  task: ProductV2Task | undefined;
  record: ProductUiV2WriteRecord;
  ctx: ProductUiV2WriteContext;
  nowUnix: number;
}): GuardResult {
  const ready = v2ProductWalletReady(input.ctx);
  if (!ready.ok) return ready;
  if (hasTxId(input.record) && !isTerminalFailure(input.record)) {
    return fail(`accept_task already has transaction ID ${input.record.txId}. Resume tracking; do not resubmit.`);
  }
  const task = input.task;
  if (!task) return fail("get_task has not returned this task. Accept stays disabled.");
  if (!addressesEqual(task.translator, input.ctx.wallet ?? "")) {
    return fail(`Only the named translator ${task.translator} may Estimate and Sign accept_task.`);
  }
  if (task.state !== STATE_OPEN || task.accepted_at_unix !== 0) {
    return fail(`accept_task needs an OPEN unaccepted task. State is ${task.state}, accepted_at_unix=${task.accepted_at_unix}.`);
  }
  if (task.translation !== "") return fail("Task already has a translation.");
  if (!acceptWindowOpen(task.submit_by_unix, input.nowUnix)) {
    return fail(`accept_task is only allowed while now < submit_by_unix (${task.submit_by_unix}). Current clock ${input.nowUnix}.`);
  }
  return { ok: true };
}

export function acceptConfirmStored(task: ProductV2Task | undefined): GuardResult {
  if (!task) return fail("get_task has not matched this accept yet.");
  if (task.state !== STATE_ACCEPTED) {
    return fail(`Task state after accept is ${task.state}, expected ${STATE_ACCEPTED}.`);
  }
  if (task.accepted_at_unix <= 0) {
    return fail("get_task accepted_at_unix is still 0 after accept_task.");
  }
  return { ok: true };
}

export function submitTextReady(text: string): GuardResult {
  const trimmed = text.trim();
  if (!trimmed) return fail("Enter a translation. It is stored on-chain before AI evaluation.");
  if (trimmed.length > MAX_TEXT) return fail(`Translation exceeds MAX_TEXT (${MAX_TEXT}).`);
  return { ok: true };
}

export function submitEstimateAllowed(input: {
  task: ProductV2Task | undefined;
  record: ProductUiV2WriteRecord;
  ctx: ProductUiV2WriteContext;
  translation: string;
  wallUnix?: number;
  genvmUnix?: number;
}): GuardResult {
  const ready = v2ProductWalletReady(input.ctx);
  if (!ready.ok) return ready;
  if (hasTxId(input.record)) {
    return fail(`Submit already has transaction ID ${input.record.txId}. Resume tracking; do not resubmit.`);
  }
  const task = input.task;
  if (!task) return fail("get_task has not returned this task. Submit stays disabled.");
  if (!addressesEqual(task.translator, input.ctx.wallet ?? "")) {
    return fail(`Only the named translator ${task.translator} may estimate or sign submit_translation.`);
  }
  if (task.state !== STATE_ACCEPTED) {
    return fail(`Task state is ${task.state}, expected ${STATE_ACCEPTED}. V2 submit requires accept_task first.`);
  }
  if (task.accepted_at_unix <= 0) return fail("Task is not accepted yet.");
  if (task.translation !== "") return fail("Task already has a stored translation.");
  const now = input.wallUnix ?? Math.floor(Date.now() / 1000);
  if (!submitTranslationWindowOpen(task.submit_by_unix, now)) {
    return fail(
      `submit_translation is allowed only while now <= submit_by_unix (${task.submit_by_unix}). Current clock ${now}.`,
    );
  }
  if (input.genvmUnix != null && input.genvmUnix > task.submit_by_unix) {
    return fail(`Remembered GenVM clock ${input.genvmUnix} is after submit_by_unix ${task.submit_by_unix}.`);
  }
  return submitTextReady(input.translation);
}

export function submitSignAllowed(input: {
  task: ProductV2Task | undefined;
  record: ProductUiV2WriteRecord;
  ctx: ProductUiV2WriteContext;
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

export function submitConfirmStored(
  task: ProductV2Task | undefined,
  boundTranslation: string | undefined,
): GuardResult {
  if (!task) return fail("get_task has not matched this submit yet.");
  if (!boundTranslation) return fail("Bound translation is missing.");
  if (task.translation !== boundTranslation) return fail("On-chain translation does not match the exact signed text.");
  if (task.state !== STATE_SUBMITTED) {
    return fail(`Task state after submit is ${task.state}, expected ${STATE_SUBMITTED}.`);
  }
  return { ok: true };
}

export function evaluateEstimateAllowed(input: {
  task: ProductV2Task | undefined;
  record: ProductUiV2WriteRecord;
  ctx: ProductUiV2WriteContext;
}): GuardResult {
  const ready = v2ProductWalletReady(input.ctx);
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
    return fail(`Task state is ${task.state}, expected ${STATE_SUBMITTED}. evaluate_task is available while submitted.`);
  }
  if (task.decision !== DECISION_NONE) return fail(`Task decision is ${task.decision}. Evaluation is finished.`);
  if (!task.translation) return fail("get_task has an empty translation. Submit is not proven.");
  return { ok: true };
}

export function evaluateSignAllowed(input: {
  task: ProductV2Task | undefined;
  record: ProductUiV2WriteRecord;
  ctx: ProductUiV2WriteContext;
}): GuardResult {
  return evaluateEstimateAllowed(input);
}

export function cancelEstimateAllowed(input: {
  task: ProductV2Task | undefined;
  record: ProductUiV2WriteRecord;
  ctx: ProductUiV2WriteContext;
}): GuardResult {
  const ready = v2ProductWalletReady(input.ctx);
  if (!ready.ok) return ready;
  if (hasTxId(input.record) && !isTerminalFailure(input.record)) {
    return fail(`Cancel already has transaction ID ${input.record.txId}. Resume tracking; do not resubmit.`);
  }
  const task = input.task;
  if (!task) return fail("get_task has not returned this task. Cancel stays disabled.");
  if (!addressesEqual(task.funder, input.ctx.wallet ?? "")) {
    return fail(`Only the funder ${task.funder} may Estimate and Sign cancel_task.`);
  }
  if (task.state !== STATE_OPEN || task.accepted_at_unix !== 0) {
    return fail("Funder cancel is available only while the task is OPEN and unaccepted.");
  }
  if (task.translation !== "") return fail("Cancel is disabled after a stored translation.");
  if (task.decision !== DECISION_NONE) return fail(`Task decision is ${task.decision}. Cancel is disabled.`);
  return { ok: true };
}

export function cancelConfirmStored(task: ProductV2Task | undefined): GuardResult {
  if (!task) return fail("get_task has not matched this cancel yet.");
  if (task.state !== STATE_CANCELLED) {
    return fail(`Task state after cancel is ${task.state}, expected ${STATE_CANCELLED}.`);
  }
  return { ok: true };
}

export function expireEstimateAllowed(input: {
  task: ProductV2Task | undefined;
  record: ProductUiV2WriteRecord;
  ctx: ProductUiV2WriteContext;
  wallUnix?: number;
}): GuardResult {
  const ready = v2ProductWalletReady(input.ctx);
  if (!ready.ok) return ready;
  if (hasTxId(input.record) && !isTerminalFailure(input.record)) {
    return fail(`Expire already has transaction ID ${input.record.txId}. Resume tracking; do not resubmit.`);
  }
  if (hasTxId(input.record) && isTerminalFailure(input.record)) {
    return fail("This expire hash finished without success. Use New attempt for a new estimate. Do not resubmit that hash.");
  }
  const task = input.task;
  if (!task) return fail("Refresh get_task first.");
  if (task.state !== STATE_OPEN && task.state !== STATE_ACCEPTED) {
    return fail(`Task state is ${task.state}; expire_unsubmitted_task needs open or accepted.`);
  }
  if (task.translation !== "") return fail("Task already has a stored translation.");
  if (task.decision !== DECISION_NONE) return fail(`Task decision is ${task.decision}. Expire is finished.`);
  const now = input.wallUnix ?? Math.floor(Date.now() / 1000);
  if (!expireWindowOpen(task.submit_by_unix, now)) {
    return fail(`expire_unsubmitted_task opens only after now > submit_by_unix (${task.submit_by_unix}). Current clock ${now}.`);
  }
  return { ok: true };
}

export function expireSignAllowed(input: {
  task: ProductV2Task | undefined;
  record: ProductUiV2WriteRecord;
  ctx: ProductUiV2WriteContext;
  wallUnix?: number;
}): GuardResult {
  return expireEstimateAllowed(input);
}

export function expireConfirmStored(task: ProductV2Task | undefined): GuardResult {
  if (!task) return fail("get_task has not matched this expire yet.");
  if (task.state !== STATE_EXPIRED) {
    return fail(`Task state after expire is ${task.state}, expected ${STATE_EXPIRED}.`);
  }
  if (task.decision !== STATE_EXPIRED) {
    return fail(`Task decision after expire is ${task.decision}, expected ${STATE_EXPIRED}.`);
  }
  if (task.payment_kind !== KIND_REFUND) {
    return fail(`payment_kind after expire is ${task.payment_kind || "none"}, expected ${KIND_REFUND}.`);
  }
  return { ok: true };
}

export function recoveryWindowOpen(task: ProductV2Task, wallUnix: number): GuardResult {
  const opens = task.recovery_opens_at_unix;
  if (!opens) return fail("get_task did not return recovery_opens_at_unix. Recover stays disabled.");
  if (wallUnix >= opens) return { ok: true };
  return fail(`Recover is disabled until recovery_opens_at_unix=${opens}. wall=${wallUnix}. A remembered quote clock never opens recovery early.`);
}

export function recoverEstimateAllowed(input: {
  task: ProductV2Task | undefined;
  record: ProductUiV2WriteRecord;
  ctx: ProductUiV2WriteContext;
  wallUnix?: number;
  genvmUnix?: number;
}): GuardResult {
  const ready = v2ProductWalletReady(input.ctx);
  if (!ready.ok) return ready;
  if (hasTxId(input.record) && !isTerminalFailure(input.record)) {
    return fail(`Recover already has transaction ID ${input.record.txId}. Resume tracking; do not resubmit.`);
  }
  if (hasTxId(input.record) && isTerminalFailure(input.record)) {
    return fail("This recover hash finished without success. Use New attempt for a new estimate. Do not resubmit that hash.");
  }
  const task = input.task;
  if (!task) return fail("Refresh get_task first.");
  if (task.state !== STATE_SUBMITTED) {
    return fail(`Task state is ${task.state}, expected ${STATE_SUBMITTED}. recover_undecided_task needs submitted.`);
  }
  if (task.decision !== DECISION_NONE) return fail(`Task decision is ${task.decision}. Recovery is finished.`);
  if (!task.translation) return fail("get_task has an empty translation. Submit is not proven.");
  return recoveryWindowOpen(task, input.wallUnix ?? Math.floor(Date.now() / 1000));
}

export function recoverSignAllowed(input: {
  task: ProductV2Task | undefined;
  record: ProductUiV2WriteRecord;
  ctx: ProductUiV2WriteContext;
  wallUnix?: number;
  genvmUnix?: number;
}): GuardResult {
  return recoverEstimateAllowed(input);
}

export function recoverConfirmStored(task: ProductV2Task | undefined): GuardResult {
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

export function needsWriteResume(record: ProductUiV2WriteRecord): boolean {
  return Boolean(record.txId) && !isFinalizedSuccessful(record) && !isTerminalFailure(record);
}

export function failedAcceptStillOpen(
  task: ProductV2Task | undefined,
  record: ProductUiV2WriteRecord,
  nowUnix: number,
): boolean {
  return Boolean(task && isTerminalFailure(record) && showV2Accept(task, nowUnix));
}

export function failedCancelStillUnaccepted(task: ProductV2Task | undefined, record: ProductUiV2WriteRecord): boolean {
  return Boolean(task && isTerminalFailure(record) && showV2Cancel(task));
}

export function failedSubmitStillAccepted(task: ProductV2Task | undefined, record: ProductUiV2WriteRecord): boolean {
  return Boolean(task && task.state === STATE_ACCEPTED && task.translation === "" && isTerminalFailure(record));
}

export function failedEvaluateStillSubmitted(task: ProductV2Task | undefined, record: ProductUiV2WriteRecord): boolean {
  return Boolean(task && task.state === STATE_SUBMITTED && task.decision === DECISION_NONE && isTerminalFailure(record));
}

export function failedExpireStillUnsubmitted(
  task: ProductV2Task | undefined,
  record: ProductUiV2WriteRecord,
  nowUnix: number,
): boolean {
  return Boolean(task && isTerminalFailure(record) && expireEstimateAllowed({
    task,
    record: { ...record, txId: undefined, phase: "idle" },
    ctx: { wallet: record.wallet, chainId: record.chainId, connected: true },
    wallUnix: nowUnix,
  }).ok);
}

export function failedRecoverStillSubmitted(task: ProductV2Task | undefined, record: ProductUiV2WriteRecord): boolean {
  return Boolean(task && task.state === STATE_SUBMITTED && task.decision === DECISION_NONE && isTerminalFailure(record));
}
