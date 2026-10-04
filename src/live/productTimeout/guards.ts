/** Reuse Phase B1 write guards. Same contract and never-resubmit rules. This page never estimates evaluate_task. */
export {
  b1ActionEstimateAllowed,
  b1ActionSignAllowed,
  b1ClearRisk,
  b1SessionRewardWei,
  bindB1CreateEstimateIdentity,
  connectedB1Role,
  createEstimateAllowed,
  deadlinesStale,
  hasTxId,
  isFinalizedSuccessful,
  isTerminalFailure,
  needsB1TxResume,
  neverResubmit,
  recoverEstimateAllowed,
  retryFailedB1Action,
  submitEstimateAllowed,
  type B1WriteContext,
} from "../productB1/guards";
import {
  b1ActionEstimateAllowed,
  b1ActionSignAllowed,
  b1ClearRisk,
  recoverEstimateAllowed,
  retryFailedB1Action,
  type B1WriteContext,
} from "../productB1/guards";
import type { B1Session } from "../productB1/persist";
import type { TimeoutActionName } from "./constants";
import type { TimeoutSession } from "./persist";

export function asB1Session(session: TimeoutSession): B1Session {
  return {
    ...session,
    evaluate: { phase: "idle" },
  };
}

export function timeoutActionEstimateAllowed(
  name: TimeoutActionName,
  session: TimeoutSession,
  ctx: B1WriteContext,
  nowUnix: number,
) {
  if (name === "recover") return recoverEstimateAllowed(asB1Session(session), ctx, nowUnix);
  return b1ActionEstimateAllowed(name, asB1Session(session), ctx, nowUnix);
}

export function timeoutActionSignAllowed(
  name: TimeoutActionName,
  session: TimeoutSession,
  ctx: B1WriteContext,
  nowUnix: number,
) {
  if (name === "recover") return recoverEstimateAllowed(asB1Session(session), ctx, nowUnix);
  return b1ActionSignAllowed(name, asB1Session(session), ctx, nowUnix);
}

export function retryFailedTimeoutAction(session: TimeoutSession, name: TimeoutActionName): TimeoutSession {
  const next = retryFailedB1Action(asB1Session(session), name);
  return {
    ...session,
    create: next.create,
    submit: next.submit,
    recover: next.recover,
    clientNonce: next.clientNonce,
    expectedTaskId: next.expectedTaskId,
    submitByUnix: next.submitByUnix,
    recoverAfterUnix: next.recoverAfterUnix,
    task: next.task,
    boundRewardWei: next.boundRewardWei,
    boundRewardGen: next.boundRewardGen,
    boundTranslation: next.boundTranslation,
    transfer: next.transfer,
    libraryEntry: next.libraryEntry,
    paymentEvidence: next.paymentEvidence,
    paymentReason: next.paymentReason,
  };
}

export function timeoutClearRisk(session: TimeoutSession) {
  const risk = b1ClearRisk(asB1Session(session));
  return {
    ...risk,
    txIds: { create: risk.txIds.create, submit: risk.txIds.submit, recover: risk.txIds.recover },
  };
}
