import { addressesEqual, isEoaAddress, isZeroAddress } from "../format";
import { hasTxId, isFinalizedSuccessful, isTerminalFailure, neverResubmit } from "../guards";
import { STUDIO_DEV_CHAIN_ID } from "../network";
import { createDeadlinesFromGenvm } from "../product/clock";
import { DEADLINE_STALE_SECONDS } from "../product/constants";
import { sourceBindingStillValid } from "../product/source";
import { createdTaskMatchesBound, genToWei } from "../product/task";
import { expectedTaskId, freshClientNonce } from "../product/taskId";
import {
  B1_CONTRACT_ADDRESS,
  DECISION_NONE,
  STATE_OPEN,
  STATE_SUBMITTED,
  type B1ActionName,
} from "./constants";
import type { B1ActionRecord, B1Session } from "./persist";

export type B1WriteContext = {
  wallet?: string;
  chainId?: number;
  connected: boolean;
};

export type GuardResult = { ok: true } | { ok: false; reason: string };
export type B1Role = "funder" | "translator" | "unbound" | "other";

export { hasTxId, isFinalizedSuccessful, isTerminalFailure, neverResubmit };

function fail(reason: string): GuardResult {
  return { ok: false, reason };
}

export function b1SessionRewardWei(session: B1Session): bigint | null {
  if (session.create.txId) {
    const raw = session.boundRewardWei ?? session.create.quotedValueWei ?? session.task?.rewardWei;
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

export function connectedB1Role(session: B1Session, wallet?: string): B1Role {
  if (!wallet) return session.boundFunder ? "other" : "unbound";
  if (session.boundFunder && addressesEqual(session.boundFunder, wallet)) return "funder";
  if (session.boundTranslator && addressesEqual(session.boundTranslator, wallet)) return "translator";
  if (session.boundFunder) return "other";
  return "unbound";
}

export function studioWalletReady(ctx: B1WriteContext): GuardResult {
  if (!ctx.wallet) {
    return fail(ctx.connected ? "Unlock the connected wallet. Tracking was not cleared." : "Connect a wallet first.");
  }
  if (!ctx.connected) return fail("Connect a wallet first.");
  if (ctx.chainId !== STUDIO_DEV_CHAIN_ID) {
    return fail(`Wrong chain (${ctx.chainId ?? "unknown"}). Switch to Studio-dev ${STUDIO_DEV_CHAIN_ID}.`);
  }
  return { ok: true };
}

export function namedTranslatorReady(translator: string, funder?: string): GuardResult {
  if (!isEoaAddress(translator) || isZeroAddress(translator)) {
    return fail("Enter a valid named translator EOA that you control.");
  }
  if (funder && addressesEqual(translator, funder)) {
    return fail("Named translator must be a second wallet, different from the connected funder.");
  }
  return { ok: true };
}

export function sourceAllowsB1Create(session: B1Session): GuardResult {
  if (!addressesEqual(session.address, B1_CONTRACT_ADDRESS)) {
    return fail(`Phase B1 is pinned to existing contract ${B1_CONTRACT_ADDRESS}.`);
  }
  const hash = session.localSourceSha256 ?? "";
  if (!sourceBindingStillValid(session, hash)) {
    return fail(
      session.sourceVerifyReason ||
        "Deployed source is not bound to this contract address and the current PRODUCT_SOURCE SHA-256. Recheck gen_getContractCode.",
    );
  }
  return { ok: true };
}

export function createEstimateAllowed(session: B1Session, ctx: B1WriteContext): GuardResult {
  const ready = studioWalletReady(ctx);
  if (!ready.ok) return ready;
  const role = connectedB1Role(session, ctx.wallet);
  if (role === "translator") {
    return fail("Connect the funder wallet to estimate create_task. The translator wallet cannot create.");
  }
  if (role === "other") {
    return fail(
      `Persisted Phase B1 evidence is bound to funder ${session.boundFunder} and translator ${session.boundTranslator}. Connect one of those wallets. Do not mix a third account into this session.`,
    );
  }
  if (hasTxId(session.create)) return fail(`Create already has transaction ID ${session.create.txId}. Resume tracking; do not resubmit.`);
  const source = sourceAllowsB1Create(session);
  if (!source.ok) return source;
  const translator = session.boundTranslator ?? session.translator.trim();
  const named = namedTranslatorReady(translator, ctx.wallet);
  if (!named.ok) return named;
  const reward = b1SessionRewardWei(session);
  if (reward == null || reward <= 0n) {
    return fail("Enter a GEN reward greater than zero. This is the attached create value, separate from the protocol fee.");
  }
  return { ok: true };
}

export function createSignAllowed(session: B1Session, ctx: B1WriteContext): GuardResult {
  const estimate = createEstimateAllowed(session, ctx);
  if (!estimate.ok) return estimate;
  if (!session.clientNonce || !session.expectedTaskId || session.submitByUnix == null || session.recoverAfterUnix == null) {
    return fail("Estimate first so a client_nonce, deadlines, and nonce-derived task ID are bound before signing.");
  }
  return { ok: true };
}

export function unsubmittedCreateNonce(session: B1Session): string | undefined {
  if (session.create.txId) return undefined;
  return session.clientNonce;
}

export async function bindB1CreateEstimateIdentity(
  session: B1Session,
  input: { funder: string; nonceFactory?: () => string; nowUnix: number },
): Promise<B1Session> {
  if (session.create.txId) return session;
  const clientNonce = unsubmittedCreateNonce(session) ?? (input.nonceFactory ?? freshClientNonce)();
  const deadlines = createDeadlinesFromGenvm(input.nowUnix);
  const expectedTaskIdValue = await expectedTaskId(input.funder, session.address, clientNonce);
  return {
    ...session,
    clientNonce,
    submitByUnix: deadlines.submitByUnix,
    recoverAfterUnix: deadlines.recoverAfterUnix,
    expectedTaskId: expectedTaskIdValue,
    boundTranslator: session.boundTranslator ?? session.translator.trim(),
  };
}

export function submitEstimateAllowed(session: B1Session, ctx: B1WriteContext): GuardResult {
  const ready = studioWalletReady(ctx);
  if (!ready.ok) return ready;
  if (connectedB1Role(session, ctx.wallet) !== "translator") {
    return fail("Only the named translator wallet may estimate or sign submit_translation. Switch to that account.");
  }
  if (hasTxId(session.submit)) return fail(`Submit already has transaction ID ${session.submit.txId}. Resume tracking; do not resubmit.`);
  if (!isFinalizedSuccessful(session.create)) {
    return fail("Submit is disabled until create_task is FINALIZED and isSuccessful.");
  }
  const reward = b1SessionRewardWei(session);
  if (!session.boundFunder || !session.boundTranslator || !session.clientNonce || !session.expectedTaskId || reward == null) {
    return fail("Session is missing bound create identity. Submit stays disabled.");
  }
  const match = createdTaskMatchesBound({
    task: session.task,
    funder: session.boundFunder,
    translator: session.boundTranslator,
    rewardWei: reward.toString(),
    clientNonce: session.clientNonce,
    expectedTaskId: session.expectedTaskId,
    submitByUnix: session.submitByUnix ?? 0,
    recoverAfterUnix: session.recoverAfterUnix ?? 0,
  });
  if (!match.ok) return fail(`Submit is disabled until get_task matches this session: ${match.reason}`);
  const task = session.task!;
  if (task.state !== STATE_OPEN) return fail(`Task state is ${task.state}, expected ${STATE_OPEN}.`);
  if (task.translation !== "") return fail("Task already has a stored translation.");
  const text = (session.boundTranslation ?? session.translation).trim();
  if (!text) return fail("Enter the Spanish translation to submit. It is stored before AI evaluation.");
  return { ok: true };
}

export function submitSignAllowed(session: B1Session, ctx: B1WriteContext): GuardResult {
  const estimate = submitEstimateAllowed(session, ctx);
  if (!estimate.ok) return estimate;
  if (!session.boundTranslation) return fail("Estimate first so the exact translation text is bound to this quote.");
  if (session.translation.trim() !== session.boundTranslation) {
    return fail("Translation text changed since Estimate. Estimate again.");
  }
  return { ok: true };
}

function submittedTaskReady(session: B1Session): GuardResult {
  if (!isFinalizedSuccessful(session.submit)) {
    return fail("Disabled until submit_translation is FINALIZED and isSuccessful.");
  }
  const task = session.task;
  if (!task) return fail("Refresh get_task first.");
  if (task.state !== STATE_SUBMITTED) {
    return fail(`Task state is ${task.state}, expected ${STATE_SUBMITTED}.`);
  }
  if (task.decision !== DECISION_NONE) {
    return fail(`Task decision is ${task.decision}. Evaluation is finished.`);
  }
  if (session.boundTranslation && task.translation !== session.boundTranslation) {
    return fail("On-chain translation does not match the bound submitted text.");
  }
  if (!task.translation) return fail("get_task has an empty translation. Submit is not proven.");
  return { ok: true };
}

export function evaluateEstimateAllowed(session: B1Session, ctx: B1WriteContext): GuardResult {
  const ready = studioWalletReady(ctx);
  if (!ready.ok) return ready;
  if (connectedB1Role(session, ctx.wallet) !== "funder") {
    return fail("Switch back to the funder wallet to estimate/sign evaluate_task. That wallet pays the evaluation fee.");
  }
  if (hasTxId(session.evaluate) && !isTerminalFailure(session.evaluate)) {
    return fail(`Evaluate already has transaction ID ${session.evaluate.txId}. Resume tracking; do not resubmit.`);
  }
  if (hasTxId(session.evaluate) && isTerminalFailure(session.evaluate)) {
    return fail("This evaluate hash finished without success. Use New attempt for a new estimate. Do not resubmit that hash.");
  }
  return submittedTaskReady(session);
}

export function recoverEstimateAllowed(session: B1Session, ctx: B1WriteContext, nowUnix: number): GuardResult {
  const ready = studioWalletReady(ctx);
  if (!ready.ok) return ready;
  if (connectedB1Role(session, ctx.wallet) !== "funder") {
    return fail("Connect the funder wallet to recover an undecided submitted task.");
  }
  if (hasTxId(session.recover)) {
    return fail(`Recover already has transaction ID ${session.recover.txId}. Resume tracking; do not resubmit.`);
  }
  const submitted = submittedTaskReady(session);
  if (!submitted.ok) return submitted;
  const opens = session.task?.recovery_opens_at_unix ?? 0;
  if (!opens) return fail("get_task did not return recovery_opens_at_unix. Recover stays disabled.");
  if (nowUnix < opens) {
    return fail(
      `Recover is disabled until the contract recovery opening time ${opens}. Current clock ${nowUnix}. The task stays submitted.`,
    );
  }
  return { ok: true };
}

export function b1ActionEstimateAllowed(
  name: B1ActionName,
  session: B1Session,
  ctx: B1WriteContext,
  nowUnix: number,
): GuardResult {
  if (name === "create") return createEstimateAllowed(session, ctx);
  if (name === "submit") return submitEstimateAllowed(session, ctx);
  if (name === "evaluate") return evaluateEstimateAllowed(session, ctx);
  return recoverEstimateAllowed(session, ctx, nowUnix);
}

export function b1ActionSignAllowed(
  name: B1ActionName,
  session: B1Session,
  ctx: B1WriteContext,
  nowUnix: number,
): GuardResult {
  if (name === "create") return createSignAllowed(session, ctx);
  if (name === "submit") return submitSignAllowed(session, ctx);
  if (name === "evaluate") return evaluateEstimateAllowed(session, ctx);
  return recoverEstimateAllowed(session, ctx, nowUnix);
}

export function needsB1TxResume(action: B1ActionRecord): boolean {
  return Boolean(action.txId) && !isFinalizedSuccessful(action) && !isTerminalFailure(action);
}

export function retryFailedB1Action(session: B1Session, name: B1ActionName): B1Session {
  const action = session[name];
  if (!isTerminalFailure(action)) return session;
  const cleared: B1ActionRecord = { phase: "idle" };
  const next: B1Session = { ...session, [name]: cleared };
  if (name === "create") {
    next.clientNonce = undefined;
    next.expectedTaskId = undefined;
    next.submitByUnix = undefined;
    next.recoverAfterUnix = undefined;
    next.task = undefined;
    next.boundRewardWei = undefined;
    next.boundRewardGen = undefined;
  }
  if (name === "submit") {
    next.boundTranslation = undefined;
  }
  if (name === "evaluate" || name === "recover") {
    next.transfer = undefined;
    next.libraryEntry = undefined;
    next.paymentEvidence = "UNPROVEN";
    next.paymentReason = "Previous settlement write failed. New attempt uses a new estimate. The old tx ID is not resubmitted. Task should still be submitted if evaluation failed closed.";
  }
  return next;
}

export function deadlinesStale(submitByUnix: number | undefined, nowUnix: number): boolean {
  if (submitByUnix == null) return true;
  return nowUnix + DEADLINE_STALE_SECONDS >= submitByUnix;
}

export function b1ClearRisk(session: B1Session): {
  blocked: boolean;
  pending: boolean;
  openFundedTask: boolean;
  taskId?: string;
  txIds: { create?: string; submit?: string; evaluate?: string; recover?: string };
  reason: string;
} {
  const pending = (["create", "submit", "evaluate", "recover"] as B1ActionName[]).some((name) => {
    const action = session[name];
    if (action.phase === "quoting" || action.phase === "signing" || action.phase === "submitted" || action.phase === "waiting") {
      return true;
    }
    return Boolean(action.txId) && !isFinalizedSuccessful(action) && !isTerminalFailure(action);
  });
  const settled =
    session.task?.state === "approved" ||
    session.task?.state === "rejected" ||
    session.task?.state === "timed_out" ||
    session.task?.state === "cancelled";
  const openFundedTask = Boolean(session.create.txId && !isTerminalFailure(session.create) && !settled);
  const txIds = {
    create: session.create.txId,
    submit: session.submit.txId,
    evaluate: session.evaluate.txId,
    recover: session.recover.txId,
  };
  const blocked = pending || openFundedTask;
  let reason = "No pending transaction or unsettled funded task.";
  if (blocked) {
    reason =
      "Copy evidence JSON (task ID and tx IDs) before clearing. A pending write or unsettled funded task is still tracked.";
  }
  return { blocked, pending, openFundedTask, taskId: session.expectedTaskId, txIds, reason };
}
