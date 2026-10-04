import { addressesEqual, isEoaAddress, isZeroAddress } from "../format";
import { hasTxId, isFinalizedSuccessful, isTerminalFailure, neverResubmit } from "../guards";
import { STUDIO_DEV_CHAIN_ID } from "../network";
import { MIN_REVIEW_SECONDS } from "../product/constants";
import { expectedTaskId, freshClientNonce } from "../product/taskId";
import { genToWei } from "../product/task";
import { sourceBindingStillValid } from "../product/source";
import {
  DEADLINE_STALE_SECONDS,
  LANE_A_SUBMIT_LEAD_SECONDS,
  LANE_B_SUBMIT_LEAD_SECONDS,
  MAX_RECOVERY_SECONDS,
  STATE_CANCELLED,
  STATE_EXPIRED,
  normalizeLaneBLeadSeconds,
  type ProductV2ActionName,
} from "./constants";
import { acceptWindowOpen, expireWindowOpen } from "./expireClock";
import type { ProductV2ActionRecord, ProductV2Session } from "./persist";
import { laneBCancelUnavailableReason, taskMatchesExpireable, taskMatchesOpenUnaccepted } from "./task";

export type GuardResult = { ok: true } | { ok: false; reason: string };
export type V2Role = "funder" | "translator" | "other" | "unbound";

export { hasTxId, isFinalizedSuccessful, isTerminalFailure, neverResubmit };

function fail(reason: string): GuardResult {
  return { ok: false, reason };
}

export function isFinalizedWithReturn(action: ProductV2ActionRecord): boolean {
  return isFinalizedSuccessful(action) && action.executionName === "FINISHED_WITH_RETURN";
}

export type V2WriteContext = {
  wallet?: string;
  chainId?: number;
  connected: boolean;
};

export function studioWalletReady(ctx: V2WriteContext): GuardResult {
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

export function connectedV2Role(session: ProductV2Session, wallet?: string): V2Role {
  if (!wallet) return session.boundFunder ? "other" : "unbound";
  if (session.boundFunder && addressesEqual(session.boundFunder, wallet)) return "funder";
  if (session.boundTranslator && addressesEqual(session.boundTranslator, wallet)) return "translator";
  if (session.boundFunder) return "other";
  return "unbound";
}

export function sourceAllowsV2Create(session: ProductV2Session, currentLocalSha256?: string): GuardResult {
  if (!session.address) return fail("Deploy localebounty_v2.py first.");
  const hash = currentLocalSha256 ?? session.localSourceSha256 ?? "";
  if (!sourceBindingStillValid(session, hash)) {
    return fail(
      `Deployed source is not bound to this contract address and the current localebounty_v2.py SHA-256. Recheck gen_getContractCode. Create stays disabled. ${session.sourceVerifyReason}`,
    );
  }
  return { ok: true };
}

export function deployWriteAllowed(session: ProductV2Session, ctx: V2WriteContext): GuardResult {
  const ready = studioWalletReady(ctx);
  if (!ready.ok) return ready;
  if (hasTxId(session.deploy)) return fail(`Deploy already has transaction ID ${session.deploy.txId}. Resume tracking; do not resubmit.`);
  return { ok: true };
}

export function laneRewardWei(session: ProductV2Session, lane: "A" | "B"): bigint | null {
  const create = lane === "A" ? session.createA : session.createB;
  const bound = lane === "A" ? session.boundRewardAWei : session.boundRewardBWei;
  const task = lane === "A" ? session.taskA : session.taskB;
  if (create.txId) {
    const raw = bound ?? create.quotedValueWei ?? task?.rewardWei;
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

function createEstimateBase(
  session: ProductV2Session,
  ctx: V2WriteContext,
  lane: "A" | "B",
  currentLocalSha256?: string,
): GuardResult {
  const ready = studioWalletReady(ctx);
  if (!ready.ok) return ready;
  const named = namedTranslatorReady(session.translator.trim(), ctx.wallet);
  if (!named.ok) return named;
  const create = lane === "A" ? session.createA : session.createB;
  if (hasTxId(create)) return fail(`Create already has transaction ID ${create.txId}. Resume tracking; do not resubmit.`);
  if (!session.address) return fail("Deploy and verify localebounty_v2.py before create_task.");
  if (!isFinalizedWithReturn(session.deploy)) {
    return fail("Create is disabled until deploy is FINALIZED with FINISHED_WITH_RETURN.");
  }
  const source = sourceAllowsV2Create(session, currentLocalSha256 ?? session.localSourceSha256);
  if (!source.ok) return source;
  if (session.boundFunder && ctx.wallet && !addressesEqual(session.boundFunder, ctx.wallet)) {
    return fail(`Lane ${lane} create must be signed by bound funder ${session.boundFunder}.`);
  }
  const reward = laneRewardWei(session, lane);
  if (reward == null || reward <= 0n) {
    return fail("Enter a GEN reward greater than zero. This is the attached create value, separate from the protocol fee.");
  }
  return { ok: true };
}

export function createAEstimateAllowed(session: ProductV2Session, ctx: V2WriteContext, currentLocalSha256?: string): GuardResult {
  return createEstimateBase(session, ctx, "A", currentLocalSha256);
}

export function createBEstimateAllowed(session: ProductV2Session, ctx: V2WriteContext, currentLocalSha256?: string): GuardResult {
  return createEstimateBase(session, ctx, "B", currentLocalSha256);
}

export function createASignAllowed(session: ProductV2Session, ctx: V2WriteContext, currentLocalSha256?: string): GuardResult {
  const estimate = createAEstimateAllowed(session, ctx, currentLocalSha256);
  if (!estimate.ok) return estimate;
  if (!session.nonceA || !session.taskIdA || session.submitA == null || session.recoverA == null) {
    return fail("Estimate lane A first so a client_nonce, task ID, and deadlines are bound.");
  }
  return { ok: true };
}

export function createBSignAllowed(session: ProductV2Session, ctx: V2WriteContext, currentLocalSha256?: string): GuardResult {
  const estimate = createBEstimateAllowed(session, ctx, currentLocalSha256);
  if (!estimate.ok) return estimate;
  if (!session.nonceB || !session.taskIdB || session.submitB == null || session.recoverB == null) {
    return fail("Estimate lane B first so a client_nonce, task ID, and selectable submission window are bound.");
  }
  return { ok: true };
}

export function unsubmittedNonce(session: ProductV2Session, lane: "A" | "B"): string | undefined {
  const create = lane === "A" ? session.createA : session.createB;
  if (create.txId) return undefined;
  return lane === "A" ? session.nonceA : session.nonceB;
}

export function createDeadlinesForLane(
  nowUnix: number,
  lane: "A" | "B",
  leadOverride?: number,
): { submitByUnix: number; recoverAfterUnix: number; leadSeconds: number } {
  const leadSeconds =
    lane === "A" ? LANE_A_SUBMIT_LEAD_SECONDS : normalizeLaneBLeadSeconds(leadOverride ?? LANE_B_SUBMIT_LEAD_SECONDS);
  const submitByUnix = nowUnix + leadSeconds;
  const recoverAfterUnix = submitByUnix + MIN_REVIEW_SECONDS;
  if (recoverAfterUnix - nowUnix > MAX_RECOVERY_SECONDS) {
    throw new Error("Internal deadline window exceeds MAX_RECOVERY_SECONDS.");
  }
  return { submitByUnix, recoverAfterUnix, leadSeconds };
}

export async function bindLaneCreateIdentity(
  session: ProductV2Session,
  input: { funder: string; lane: "A" | "B"; nonceFactory?: () => string; nowUnix: number },
): Promise<ProductV2Session> {
  const create = input.lane === "A" ? session.createA : session.createB;
  if (create.txId) return session;
  const clientNonce = unsubmittedNonce(session, input.lane) ?? (input.nonceFactory ?? freshClientNonce)();
  const deadlines = createDeadlinesForLane(
    input.nowUnix,
    input.lane,
    input.lane === "B" ? session.laneBLeadSeconds : undefined,
  );
  let expected = input.lane === "A" ? session.taskIdA : session.taskIdB;
  if (session.address && clientNonce) {
    expected = await expectedTaskId(input.funder, session.address, clientNonce);
  }
  if (input.lane === "A") {
    return { ...session, nonceA: clientNonce, submitA: deadlines.submitByUnix, recoverA: deadlines.recoverAfterUnix, taskIdA: expected };
  }
  return { ...session, nonceB: clientNonce, submitB: deadlines.submitByUnix, recoverB: deadlines.recoverAfterUnix, taskIdB: expected };
}

function boundTaskInput(session: ProductV2Session, lane: "A" | "B", funder: string, translator: string, rewardWei: bigint) {
  return {
    task: lane === "A" ? session.taskA : session.taskB,
    funder,
    translator,
    rewardWei: rewardWei.toString(),
    clientNonce: (lane === "A" ? session.nonceA : session.nonceB) ?? "",
    expectedTaskId: (lane === "A" ? session.taskIdA : session.taskIdB) ?? "",
    submitByUnix: (lane === "A" ? session.submitA : session.submitB) ?? 0,
    recoverAfterUnix: (lane === "A" ? session.recoverA : session.recoverB) ?? 0,
  };
}

export function cancelAAllowed(session: ProductV2Session, ctx: V2WriteContext): GuardResult {
  const ready = studioWalletReady(ctx);
  if (!ready.ok) return ready;
  if (hasTxId(session.cancelA)) return fail(`Cancel already has transaction ID ${session.cancelA.txId}. Resume tracking; do not resubmit.`);
  if (!session.address) return fail("Need the V2 contract address.");
  if (!session.createA.txId) return fail("Lane A cancel is disabled until this session records a create_task transaction.");
  if (isTerminalFailure(session.createA)) {
    return fail(
      `Create ${session.createA.txId} is FINALIZED without success. No open task was stored. Use New attempt on create; do not resubmit that hash.`,
    );
  }
  if (!isFinalizedWithReturn(session.createA)) {
    return fail(`Cancel is disabled until create ${session.createA.txId} is FINALIZED with FINISHED_WITH_RETURN.`);
  }
  if (!ctx.wallet) return fail("Connect the funder wallet.");
  if (session.boundFunder && !addressesEqual(session.boundFunder, ctx.wallet)) {
    return fail(`Lane A cancel must be signed by funder ${session.boundFunder}.`);
  }
  const reward = laneRewardWei(session, "A");
  if (reward == null || reward <= 0n) return fail("Session reward is missing. Cancel uses the reward bound to the create transaction.");
  if (!session.nonceA || !session.taskIdA || session.submitA == null || session.recoverA == null) {
    return fail("Session is missing nonce-derived task ID or deadlines. Cancel stays disabled.");
  }
  const translator = session.boundTranslator ?? session.translator.trim();
  const match = taskMatchesOpenUnaccepted(boundTaskInput(session, "A", ctx.wallet, translator, reward));
  if (!match.ok) return fail(`Cancel is disabled until get_task matches this unaccepted open task: ${match.reason}`);
  return { ok: true };
}

export function acceptBAllowed(session: ProductV2Session, ctx: V2WriteContext, nowUnix: number): GuardResult {
  const ready = studioWalletReady(ctx);
  if (!ready.ok) return ready;
  if (hasTxId(session.acceptB)) return fail(`accept_task already has transaction ID ${session.acceptB.txId}. Resume tracking; do not resubmit.`);
  if (!isFinalizedWithReturn(session.createB)) {
    return fail("accept_task is disabled until lane B create is FINALIZED with FINISHED_WITH_RETURN.");
  }
  const translator = session.boundTranslator ?? session.translator.trim();
  if (!ctx.wallet || !addressesEqual(ctx.wallet, translator)) {
    return fail(`Connect the named translator ${translator} to Estimate and Sign accept_task. No GEN is attached; you pay only the write fee.`);
  }
  const reward = laneRewardWei(session, "B");
  if (reward == null) return fail("Lane B reward is missing.");
  const funder = session.boundFunder ?? session.taskB?.funder ?? "";
  if (!funder) return fail("Bound funder is missing.");
  const match = taskMatchesOpenUnaccepted(boundTaskInput(session, "B", funder, translator, reward));
  if (!match.ok) return fail(`accept_task needs an OPEN unaccepted task: ${match.reason}`);
  if (!acceptWindowOpen(session.submitB, nowUnix)) {
    return fail(
      `accept_task is only allowed while now < submit_by_unix (${session.submitB ?? "unset"}). Current clock ${nowUnix}.`,
    );
  }
  return { ok: true };
}

export function funderCancelAfterAcceptBlocked(session: ProductV2Session): { ok: false; reason: string } {
  return { ok: false, reason: laneBCancelUnavailableReason(session.taskB) };
}

export function cancelBAllowed(session: ProductV2Session, ctx: V2WriteContext): GuardResult {
  const ready = studioWalletReady(ctx);
  if (!ready.ok) return ready;
  if (hasTxId(session.cancelB)) {
    return fail(`Lane B cancel already has transaction ID ${session.cancelB.txId}. Resume tracking; do not resubmit.`);
  }
  if (hasTxId(session.expireB)) {
    return fail(
      `expire_unsubmitted_task already has transaction ID ${session.expireB.txId}. Resume that recovery; funder cancel stays disabled.`,
    );
  }
  if (isFinalizedWithReturn(session.acceptB) || (session.taskB?.accepted_at_unix ?? 0) > 0) {
    return fail(laneBCancelUnavailableReason(session.taskB));
  }
  if (hasTxId(session.acceptB) && !isTerminalFailure(session.acceptB)) {
    return fail(
      `accept_task already has transaction ID ${session.acceptB.txId}. Resume tracking; funder cancel stays disabled while accept is in flight or succeeded.`,
    );
  }
  if (!session.address) return fail("Need the V2 contract address.");
  if (!session.createB.txId) return fail("Lane B cancel is disabled until this session records a create_task transaction.");
  if (isTerminalFailure(session.createB)) {
    return fail(
      `Create ${session.createB.txId} is FINALIZED without success. No open task was stored. Use New attempt on create; do not resubmit that hash.`,
    );
  }
  if (!isFinalizedWithReturn(session.createB)) {
    return fail(`Cancel is disabled until create ${session.createB.txId} is FINALIZED with FINISHED_WITH_RETURN.`);
  }
  if (!ctx.wallet) return fail("Connect the funder wallet.");
  if (session.boundFunder && !addressesEqual(session.boundFunder, ctx.wallet)) {
    return fail(`Lane B cancel must be signed by funder ${session.boundFunder}.`);
  }
  const reward = laneRewardWei(session, "B");
  if (reward == null || reward <= 0n) return fail("Session reward is missing. Cancel uses the reward bound to the create transaction.");
  if (!session.nonceB || !session.taskIdB || session.submitB == null || session.recoverB == null) {
    return fail("Session is missing nonce-derived task ID or deadlines. Cancel stays disabled.");
  }
  const translator = session.boundTranslator ?? session.translator.trim();
  const match = taskMatchesOpenUnaccepted(boundTaskInput(session, "B", ctx.wallet, translator, reward));
  if (!match.ok) return fail(`Cancel is disabled until get_task matches this unaccepted open task: ${match.reason}`);
  return { ok: true };
}

export function expireBAllowed(session: ProductV2Session, ctx: V2WriteContext, nowUnix: number): GuardResult {
  const ready = studioWalletReady(ctx);
  if (!ready.ok) return ready;
  if (hasTxId(session.expireB)) {
    return fail(`expire_unsubmitted_task already has transaction ID ${session.expireB.txId}. Resume tracking; do not resubmit.`);
  }
  if (hasTxId(session.cancelB)) {
    return fail(
      `Lane B funder cancel already has transaction ID ${session.cancelB.txId}. Resume that recovery; expire stays disabled.`,
    );
  }
  if (!isFinalizedWithReturn(session.createB)) {
    return fail("expire_unsubmitted_task is disabled until lane B create is FINALIZED with FINISHED_WITH_RETURN.");
  }
  const reward = laneRewardWei(session, "B");
  if (reward == null) return fail("Lane B reward is missing.");
  const funder = session.boundFunder ?? session.taskB?.funder ?? "";
  const translator = session.boundTranslator ?? session.translator.trim();
  if (!funder) return fail("Stored funder is missing.");
  const expireable = taskMatchesExpireable(boundTaskInput(session, "B", funder, translator, reward));
  if (!expireable.ok) {
    return fail(`expire_unsubmitted_task needs an OPEN or ACCEPTED task with no translation: ${expireable.reason}`);
  }
  if (!expireWindowOpen(session.submitB, nowUnix)) {
    return fail(
      `expire_unsubmitted_task is only allowed when now > submit_by_unix (${session.submitB ?? "unset"}). Current clock ${nowUnix}. The inclusive submit instant does not overlap expire.`,
    );
  }
  return { ok: true };
}

export function v2ActionEstimateAllowed(
  name: ProductV2ActionName,
  session: ProductV2Session,
  ctx: V2WriteContext,
  nowUnix: number,
  currentLocalSha256?: string,
): GuardResult {
  if (name === "deploy") return deployWriteAllowed(session, ctx);
  if (name === "createA") return createAEstimateAllowed(session, ctx, currentLocalSha256);
  if (name === "createB") return createBEstimateAllowed(session, ctx, currentLocalSha256);
  if (name === "cancelA") return cancelAAllowed(session, ctx);
  if (name === "cancelB") return cancelBAllowed(session, ctx);
  if (name === "acceptB") return acceptBAllowed(session, ctx, nowUnix);
  return expireBAllowed(session, ctx, nowUnix);
}

export function v2ActionSignAllowed(
  name: ProductV2ActionName,
  session: ProductV2Session,
  ctx: V2WriteContext,
  nowUnix: number,
  currentLocalSha256?: string,
): GuardResult {
  if (name === "createA") return createASignAllowed(session, ctx, currentLocalSha256);
  if (name === "createB") return createBSignAllowed(session, ctx, currentLocalSha256);
  return v2ActionEstimateAllowed(name, session, ctx, nowUnix, currentLocalSha256);
}

export function needsV2TxResume(action: ProductV2ActionRecord): boolean {
  return Boolean(action.txId) && !isFinalizedSuccessful(action) && !isTerminalFailure(action);
}

export function deadlinesStale(submitByUnix: number | undefined, nowUnix: number): boolean {
  if (submitByUnix == null) return true;
  return nowUnix + DEADLINE_STALE_SECONDS >= submitByUnix;
}

function actionPending(action: ProductV2ActionRecord): boolean {
  if (action.phase === "quoting" || action.phase === "signing" || action.phase === "submitted" || action.phase === "waiting") {
    return true;
  }
  return Boolean(action.txId) && !isFinalizedSuccessful(action) && !isTerminalFailure(action);
}

export function retryFailedV2Action(session: ProductV2Session, name: ProductV2ActionName): ProductV2Session {
  const action = session[name];
  if (!isTerminalFailure(action)) return session;
  const cleared: ProductV2ActionRecord = { phase: "idle" };
  const next: ProductV2Session = { ...session, [name]: cleared };
  if (name === "deploy") {
    next.address = undefined;
    next.sourceMatch = false;
    next.sourceVerifyStatus = "idle";
    next.sourceVerifyReason = "Source must be rechecked after a new deploy.";
    next.deployedSourceSha256 = null;
    next.sourceVerifiedAddress = undefined;
    next.sourceVerifiedLocalSha256 = undefined;
  }
  if (name === "createA") {
    next.nonceA = undefined;
    next.taskIdA = undefined;
    next.submitA = undefined;
    next.recoverA = undefined;
    next.taskA = undefined;
    next.boundRewardAWei = undefined;
  }
  if (name === "createB") {
    next.nonceB = undefined;
    next.taskIdB = undefined;
    next.submitB = undefined;
    next.recoverB = undefined;
    next.taskB = undefined;
    next.boundRewardBWei = undefined;
  }
  if (name === "cancelA") {
    next.transferA = undefined;
    next.paymentA = "UNPROVEN";
    next.paymentAReason = "Previous cancel failed. New attempt will use a new estimate. The old tx ID is not resubmitted.";
  }
  if (name === "cancelB") {
    next.transferCancelB = undefined;
    next.paymentBRecovery = "UNPROVEN";
    next.paymentBRecoveryKind = "none";
    next.paymentBRecoveryReason =
      "Previous unaccepted cancel failed. New attempt will use a new estimate. The old tx ID is not resubmitted. Unaccepted recovery is never Lane B YES.";
  }
  if (name === "expireB") {
    next.transferB = undefined;
    next.paymentB = "UNPROVEN";
    next.paymentBReason = "Previous expire failed. New attempt will use a new estimate. The old tx ID is not resubmitted.";
    next.expireCaller = undefined;
    if (session.paymentBRecoveryKind === "unaccepted_expire") {
      next.paymentBRecovery = "UNPROVEN";
      next.paymentBRecoveryKind = "none";
      next.paymentBRecoveryReason =
        "Previous unaccepted expire failed. New attempt will use a new estimate. The old tx ID is not resubmitted. Unaccepted recovery is never Lane B YES.";
    }
  }
  return next;
}

export type V2ClearRisk = {
  blocked: boolean;
  pending: boolean;
  uncancelledFundedTask: boolean;
  taskIdA?: string;
  taskIdB?: string;
  txIds: Partial<Record<ProductV2ActionName, string>>;
  reason: string;
};

export function v2ClearRisk(session: ProductV2Session): V2ClearRisk {
  const pending =
    actionPending(session.deploy) ||
    actionPending(session.createA) ||
    actionPending(session.cancelA) ||
    actionPending(session.createB) ||
    actionPending(session.cancelB) ||
    actionPending(session.acceptB) ||
    actionPending(session.expireB);
  const aSettled =
    isFinalizedSuccessful(session.cancelA) &&
    (session.taskA?.state === STATE_CANCELLED || session.cancelA.executionName === "FINISHED_WITH_RETURN");
  const bSettled =
    (isFinalizedSuccessful(session.expireB) && session.taskB?.state === STATE_EXPIRED) ||
    (isFinalizedSuccessful(session.cancelB) && session.taskB?.state === STATE_CANCELLED);
  const uncancelledFundedTask = Boolean(
    (session.createA.txId && !isTerminalFailure(session.createA) && !aSettled) ||
      (session.createB.txId && !isTerminalFailure(session.createB) && !bSettled),
  );
  const txIds = {
    deploy: session.deploy.txId,
    createA: session.createA.txId,
    cancelA: session.cancelA.txId,
    createB: session.createB.txId,
    cancelB: session.cancelB.txId,
    acceptB: session.acceptB.txId,
    expireB: session.expireB.txId,
  };
  const blocked = pending || uncancelledFundedTask;
  let reason = "No pending transaction or unsettled funded task.";
  if (pending && uncancelledFundedTask) {
    reason = "A transaction is still pending, and this session has an unsettled funded task. Copy evidence JSON before clearing.";
  } else if (pending) {
    reason = "A transaction is still pending. Copy evidence JSON (task IDs and tx IDs) before clearing.";
  } else if (uncancelledFundedTask) {
    reason = "This session has an unsettled funded task. Copy evidence JSON before clearing local tracking.";
  }
  return {
    blocked,
    pending,
    uncancelledFundedTask,
    taskIdA: session.taskIdA,
    taskIdB: session.taskIdB,
    txIds,
    reason,
  };
}
