import { addressesEqual, isEoaAddress, isZeroAddress } from "../format";
import { hasTxId, isFinalizedSuccessful, isTerminalFailure, neverResubmit } from "../guards";
import { STUDIO_DEV_CHAIN_ID } from "../network";
import { createDeadlinesFromGenvm } from "./clock";
import { DEADLINE_STALE_SECONDS, STATE_CANCELLED, type ProductActionName } from "./constants";
import type { ProductActionRecord, ProductSession } from "./persist";
import { sourceBindingStillValid } from "./source";
import { sessionRewardWei, taskMatchesOpenCreate } from "./task";
import { expectedTaskId, freshClientNonce } from "./taskId";

export type ProductWriteContext = {
  funder?: string;
  chainId?: number;
  translator: string;
  connected: boolean;
};

export type GuardResult = { ok: true } | { ok: false; reason: string };

function fail(reason: string): GuardResult {
  return { ok: false, reason };
}

export { hasTxId, isFinalizedSuccessful, isTerminalFailure, neverResubmit };

export function productWalletReady(ctx: ProductWriteContext): GuardResult {
  if (!ctx.funder) {
    return fail(ctx.connected ? "Unlock the connected wallet. Tracking was not cleared." : "Connect a wallet first.");
  }
  if (!ctx.connected) return fail("Connect a wallet first.");
  if (ctx.chainId !== STUDIO_DEV_CHAIN_ID) {
    return fail(`Wrong chain (${ctx.chainId ?? "unknown"}). Switch to Studio-dev ${STUDIO_DEV_CHAIN_ID}.`);
  }
  if (!isEoaAddress(ctx.translator) || isZeroAddress(ctx.translator)) {
    return fail("Enter a valid named translator EOA.");
  }
  if (addressesEqual(ctx.translator, ctx.funder)) {
    return fail("Named translator must be a different EOA than the connected funder. A demo role is not wallet authorization.");
  }
  return { ok: true };
}

export function productSessionCompatible(session: ProductSession, funder: string | undefined, translator: string): GuardResult {
  if (!session.boundFunder && !session.boundTranslator) return { ok: true };
  if (session.boundFunder) {
    if (!funder) {
      return fail(`Persisted evidence is bound to funder ${session.boundFunder}. Connect that wallet; do not mix accounts.`);
    }
    if (!addressesEqual(session.boundFunder, funder)) {
      return fail(
        `Persisted evidence is bound to funder ${session.boundFunder}. Connected ${funder} is a different account. Clear tracking or reconnect the original funder.`,
      );
    }
  }
  if (session.boundTranslator && translator) {
    if (!addressesEqual(session.boundTranslator, translator)) {
      return fail(
        `Persisted evidence is bound to translator ${session.boundTranslator}. The edited translator ${translator} would mix sessions. Clear tracking or restore the bound translator.`,
      );
    }
  }
  return { ok: true };
}

export function sourceAllowsCreate(session: ProductSession, currentLocalSha256?: string): GuardResult {
  if (!session.address) return fail("Deploy the product contract first.");
  const hash = currentLocalSha256 ?? session.localSourceSha256 ?? "";
  if (!sourceBindingStillValid(session, hash)) {
    return fail(
      session.sourceVerifyReason ||
        "Deployed source is not bound to this contract address and the current PRODUCT_SOURCE SHA-256. Recheck gen_getContractCode. Create stays disabled.",
    );
  }
  return { ok: true };
}

export function deployWriteAllowed(session: ProductSession, ctx: ProductWriteContext): GuardResult {
  const ready = productWalletReady(ctx);
  if (!ready.ok) return ready;
  if (hasTxId(session.deploy)) return fail(`Deploy already has transaction ID ${session.deploy.txId}. Resume tracking; do not resubmit.`);
  return { ok: true };
}

/** Estimate may start before a nonce exists. The nonce is created during Estimate. */
export function createEstimateAllowed(session: ProductSession, ctx: ProductWriteContext, rewardWei: bigint | null): GuardResult {
  const ready = productWalletReady(ctx);
  if (!ready.ok) return ready;
  if (hasTxId(session.create)) return fail(`Create already has transaction ID ${session.create.txId}. Resume tracking; do not resubmit.`);
  if (!session.address) return fail("Deploy and verify source before create_task.");
  if (!isFinalizedSuccessful(session.deploy)) {
    return fail("Create is disabled until deploy is FINALIZED and isSuccessful.");
  }
  const source = sourceAllowsCreate(session, session.localSourceSha256);
  if (!source.ok) return source;
  if (rewardWei == null || rewardWei <= 0n) {
    return fail("Enter a GEN reward greater than zero. This is the attached create value, separate from the protocol fee.");
  }
  return { ok: true };
}

export function createWriteAllowed(session: ProductSession, ctx: ProductWriteContext, rewardWei: bigint | null): GuardResult {
  return createEstimateAllowed(session, ctx, rewardWei);
}

export function createSignAllowed(session: ProductSession, ctx: ProductWriteContext, rewardWei: bigint | null): GuardResult {
  const estimate = createEstimateAllowed(session, ctx, rewardWei);
  if (!estimate.ok) return estimate;
  if (!session.clientNonce) {
    return fail("Estimate first so a client_nonce is bound to this unsubmitted create attempt.");
  }
  if (!session.expectedTaskId || session.submitByUnix == null || session.recoverAfterUnix == null) {
    return fail("Estimate first so deadlines and the nonce-derived task ID are bound before signing.");
  }
  return { ok: true };
}

/** Keep one nonce for an unsubmitted create attempt. Never reuse after a submitted create tx. */
export function unsubmittedCreateNonce(session: ProductSession): string | undefined {
  if (session.create.txId) return undefined;
  return session.clientNonce;
}

export async function bindCreateEstimateIdentity(
  session: ProductSession,
  input: { funder: string; nonceFactory?: () => string; nowUnix: number },
): Promise<ProductSession> {
  if (session.create.txId) return session;
  const clientNonce = unsubmittedCreateNonce(session) ?? (input.nonceFactory ?? freshClientNonce)();
  const deadlines = buildCreateDeadlines(input.nowUnix);
  let expectedTaskIdValue = session.expectedTaskId;
  if (session.address && clientNonce) {
    expectedTaskIdValue = await expectedTaskId(input.funder, session.address, clientNonce);
  }
  return {
    ...session,
    clientNonce,
    submitByUnix: deadlines.submitByUnix,
    recoverAfterUnix: deadlines.recoverAfterUnix,
    expectedTaskId: expectedTaskIdValue,
  };
}

export function cancelWriteAllowed(session: ProductSession, ctx: ProductWriteContext, rewardWei: bigint | null): GuardResult {
  const ready = productWalletReady(ctx);
  if (!ready.ok) return ready;
  if (hasTxId(session.cancel)) {
    return fail(`Cancel already has transaction ID ${session.cancel.txId}. Resume tracking; do not resubmit.`);
  }
  if (!session.address) return fail("Need the product contract address.");
  if (!session.create.txId) return fail("Cancel is disabled until this session records a create_task transaction.");
  if (isTerminalFailure(session.create)) {
    return fail(
      `Create ${session.create.txId} is FINALIZED with ${session.create.executionName ?? "error"} (isSuccessful false). No open task was stored, so there is nothing to cancel. Use New attempt on create; do not resubmit that hash.`,
    );
  }
  if (!isFinalizedSuccessful(session.create)) {
    return fail(
      `Cancel is disabled until create ${session.create.txId} is FINALIZED and isSuccessful (status=${session.create.statusName ?? "unknown"}, execution=${session.create.executionName ?? "unknown"}).`,
    );
  }
  if (!ctx.funder) return fail("Connect the funder wallet.");
  const lockedReward = sessionRewardWei(session) ?? rewardWei;
  if (lockedReward == null || lockedReward <= 0n) return fail("Session reward is missing. Cancel uses the reward bound to the create transaction.");
  if (!session.clientNonce || !session.expectedTaskId || session.submitByUnix == null || session.recoverAfterUnix == null) {
    return fail("Session is missing nonce-derived task ID or deadlines. Cancel stays disabled.");
  }
  const match = taskMatchesOpenCreate({
    task: session.createTask,
    funder: ctx.funder,
    translator: ctx.translator,
    contract: session.address,
    rewardWei: lockedReward.toString(),
    clientNonce: session.clientNonce,
    expectedTaskId: session.expectedTaskId,
    submitByUnix: session.submitByUnix,
    recoverAfterUnix: session.recoverAfterUnix,
  });
  if (!match.ok) return fail(`Cancel is disabled until get_task matches this session: ${match.reason}`);
  return { ok: true };
}

export function productActionWriteAllowed(
  name: ProductActionName,
  session: ProductSession,
  ctx: ProductWriteContext,
  rewardWei: bigint | null,
): GuardResult {
  return productActionEstimateAllowed(name, session, ctx, rewardWei);
}

export function productActionEstimateAllowed(
  name: ProductActionName,
  session: ProductSession,
  ctx: ProductWriteContext,
  rewardWei: bigint | null,
): GuardResult {
  if (name === "deploy") return deployWriteAllowed(session, ctx);
  if (name === "create") return createEstimateAllowed(session, ctx, rewardWei);
  return cancelWriteAllowed(session, ctx, rewardWei);
}

export function productActionSignAllowed(
  name: ProductActionName,
  session: ProductSession,
  ctx: ProductWriteContext,
  rewardWei: bigint | null,
): GuardResult {
  if (name === "deploy") return deployWriteAllowed(session, ctx);
  if (name === "create") return createSignAllowed(session, ctx, rewardWei);
  return cancelWriteAllowed(session, ctx, rewardWei);
}

export function needsProductTxResume(action: ProductActionRecord): boolean {
  return Boolean(action.txId) && !isFinalizedSuccessful(action) && !isTerminalFailure(action);
}

export function needsProductPaymentResume(session: ProductSession): boolean {
  return isFinalizedSuccessful(session.cancel);
}

export function retryFailedProductAction(session: ProductSession, name: ProductActionName): ProductSession {
  const action = session[name];
  if (!isTerminalFailure(action)) return session;
  const cleared: ProductActionRecord = { phase: "idle" };
  const next: ProductSession = { ...session, [name]: cleared };
  if (name === "deploy") {
    next.address = undefined;
    next.sourceMatch = false;
    next.sourceVerifyStatus = "idle";
    next.sourceVerifyReason = "Source must be rechecked after a new deploy.";
    next.deployedSourceSha256 = null;
    next.sourceVerifiedAddress = undefined;
    next.sourceVerifiedLocalSha256 = undefined;
  }
  if (name === "create") {
    next.clientNonce = undefined;
    next.expectedTaskId = undefined;
    next.submitByUnix = undefined;
    next.recoverAfterUnix = undefined;
    next.createTask = undefined;
    next.boundRewardWei = undefined;
    next.boundRewardGen = undefined;
  }
  if (name === "cancel") {
    next.cancelTask = undefined;
    next.transfer = undefined;
    next.paymentEvidence = "UNPROVEN";
    next.paymentReason = "Previous cancel failed. New attempt will use a new estimate. The old tx ID is not resubmitted.";
  }
  return next;
}

export function deadlinesStale(submitByUnix: number | undefined, nowUnix: number): boolean {
  if (submitByUnix == null) return true;
  return nowUnix + DEADLINE_STALE_SECONDS >= submitByUnix;
}

export function buildCreateDeadlines(nowUnix: number): { submitByUnix: number; recoverAfterUnix: number } {
  return createDeadlinesFromGenvm(nowUnix);
}

function actionPending(action: ProductActionRecord): boolean {
  if (action.phase === "quoting" || action.phase === "signing" || action.phase === "submitted" || action.phase === "waiting") {
    return true;
  }
  return Boolean(action.txId) && !isFinalizedSuccessful(action) && !isTerminalFailure(action);
}

export type ProductClearRisk = {
  blocked: boolean;
  pending: boolean;
  uncancelledFundedTask: boolean;
  taskId?: string;
  txIds: { deploy?: string; create?: string; cancel?: string };
  reason: string;
};

export function productClearRisk(session: ProductSession): ProductClearRisk {
  const pending = actionPending(session.deploy) || actionPending(session.create) || actionPending(session.cancel);
  const cancelSettled =
    isFinalizedSuccessful(session.cancel) &&
    (session.cancelTask?.state === STATE_CANCELLED || session.createTask?.state === STATE_CANCELLED);
  const uncancelledFundedTask = Boolean(
    session.create.txId && !isTerminalFailure(session.create) && !cancelSettled,
  );
  const txIds = {
    deploy: session.deploy.txId,
    create: session.create.txId,
    cancel: session.cancel.txId,
  };
  const blocked = pending || uncancelledFundedTask;
  let reason = "No pending transaction or uncancelled funded task.";
  if (pending && uncancelledFundedTask) {
    reason =
      "A transaction is still pending, and this session has an uncancelled funded task. Copy evidence JSON (task ID and tx IDs) before clearing.";
  } else if (pending) {
    reason = "A transaction is still pending. Copy evidence JSON (task ID and tx IDs) before clearing.";
  } else if (uncancelledFundedTask) {
    reason =
      "This session has an uncancelled funded task. Copy evidence JSON (task ID and tx IDs) before clearing local tracking.";
  }
  return {
    blocked,
    pending,
    uncancelledFundedTask,
    taskId: session.expectedTaskId,
    txIds,
    reason,
  };
}
