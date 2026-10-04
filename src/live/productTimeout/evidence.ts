import { jsonStringifySafe } from "../format";
import { isFinalizedSuccessful } from "../guards";
import { PAYOUT_SUBMITTED_IS_NOT_PAYMENT } from "../product/evidence";
import { sourceBindingStillValid } from "../product/source";
import { createdTaskMatchesBound } from "../product/task";
import { evaluateSettlement, feeFromAction, parentSuccessIsNotPayment } from "../productB1/evidence";
import { b1SessionRewardWei } from "../productB1/guards";
import { libraryUnchangedForReject } from "../productB1/library";
import {
  DECISION_NONE,
  KIND_REFUND,
  STATE_APPROVED,
  STATE_REJECTED,
  STATE_SUBMITTED,
  STATE_TIMED_OUT,
} from "./constants";
import { asB1Session } from "./guards";
import type { TimeoutSession, Verdict } from "./persist";

export { evaluateSettlement, feeFromAction };

export type TimeoutVerdict = {
  verdict: Verdict;
  reason: string;
};

const storedFlag = () => `UNPROVEN. Stored paymentEvidence is not proof. ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`;

function weiDelta(after?: string, before?: string): bigint | null {
  if (after == null || before == null) return null;
  try {
    return BigInt(after) - BigInt(before);
  } catch {
    return null;
  }
}

export function overallTimeoutVerdict(session: TimeoutSession): TimeoutVerdict {
  const flag = storedFlag();
  if (!sourceBindingStillValid(session, session.localSourceSha256 ?? "")) {
    return { verdict: "UNPROVEN", reason: `Source is not bound to the existing product contract and PRODUCT_SOURCE SHA-256. ${flag}` };
  }
  if (!isFinalizedSuccessful(session.create) || !isFinalizedSuccessful(session.submit)) {
    return { verdict: "UNPROVEN", reason: `Timeout-recovery create/submit writes are incomplete. ${flag}` };
  }
  const b1 = asB1Session(session);
  const rewardWei = b1SessionRewardWei(b1);
  const funder = session.boundFunder;
  const translator = session.boundTranslator;
  if (rewardWei == null || !funder || !translator || !session.clientNonce || !session.expectedTaskId) {
    return { verdict: "UNPROVEN", reason: `Bound create identity is missing. ${flag}` };
  }
  const created = createdTaskMatchesBound({
    task: session.task,
    funder,
    translator,
    rewardWei: rewardWei.toString(),
    clientNonce: session.clientNonce,
    expectedTaskId: session.expectedTaskId,
    submitByUnix: session.submitByUnix ?? 0,
    recoverAfterUnix: session.recoverAfterUnix ?? 0,
  });
  if (!created.ok) {
    return { verdict: "UNPROVEN", reason: `get_task does not match the bound session: ${created.reason} ${flag}` };
  }
  const task = session.task!;
  if (session.boundTranslation && task.translation !== session.boundTranslation) {
    return { verdict: "UNPROVEN", reason: `Stored translation does not match the bound submit text. ${flag}` };
  }

  if (task.state === STATE_APPROVED || task.state === STATE_REJECTED) {
    return {
      verdict: "UNPROVEN",
      reason: `get_task state is ${task.state}. This timeout-recovery test never calls evaluate_task; an evaluate decision is not timeout YES. ${flag}`,
    };
  }

  if (task.state === STATE_SUBMITTED && task.decision === DECISION_NONE) {
    return {
      verdict: "UNPROVEN",
      reason: `Task stays submitted. recovery_opens_at_unix=${task.recovery_opens_at_unix}. Do not call evaluate_task. Wait for that contract time, then the funder Estimates and explicitly Signs recover_undecided_task. Stored create/submit/recover tx IDs are kept and not resubmitted. ${flag}`,
    };
  }

  const timedOut = task.state === STATE_TIMED_OUT && task.decision === STATE_TIMED_OUT && task.payment_kind === KIND_REFUND;
  if (!timedOut) {
    return {
      verdict: "UNPROVEN",
      reason: `Contract state ${task.state} / decision ${task.decision} / payment_kind ${task.payment_kind} is not a timeout refund. ${flag}`,
    };
  }

  const lib = libraryUnchangedForReject({
    countBefore: session.libraryCountBefore,
    countAfter: session.libraryCountAfter,
    entry: session.libraryEntry,
    taskId: task.task_id,
  });
  if (!lib.ok) return { verdict: "UNPROVEN", reason: `${lib.reason} ${flag}` };

  if (!session.recover.txId || !isFinalizedSuccessful(session.recover) || session.recover.executionName !== "FINISHED_WITH_RETURN") {
    return {
      verdict: "UNPROVEN",
      reason: `Recover write is not FINALIZED + FINISHED_WITH_RETURN. ${parentSuccessIsNotPayment(session.recover.statusName, session.recover.executionName, session.recover.parentSuccessful)} ${flag}`,
    };
  }

  const refund = evaluateSettlement({
    parentSuccessful: Boolean(session.recover.parentSuccessful),
    statusName: session.recover.statusName,
    executionName: session.recover.executionName,
    parentTxId: session.recover.txId,
    rewardWei,
    recipient: funder,
    otherParty: translator,
    otherMustNotGain: true,
    transfer: session.transfer,
    before: session.beforeRecover,
    after: session.afterWait ?? session.afterRecover,
    actualFee: feeFromAction(session.recover),
    recipientIsFunder: true,
  });
  if (refund.verdict !== "YES") {
    return { verdict: "UNPROVEN", reason: `${refund.reason} ${flag}` };
  }

  const after = session.afterWait ?? session.afterRecover;
  const translatorDelta = weiDelta(after?.namedWei, session.beforeRecover?.namedWei);
  if (translatorDelta == null) {
    return { verdict: "UNPROVEN", reason: `Translator settlement delta is unread. ${flag}` };
  }
  if (translatorDelta !== 0n) {
    return {
      verdict: "UNPROVEN",
      reason: `Translator settlement delta is ${translatorDelta.toString()} wei; timeout recovery requires zero translator settlement delta. ${flag}`,
    };
  }

  return {
    verdict: "YES",
    reason: `Timeout recovery proven: get_task timed_out/refund, library unchanged and no entry for this task, recover FINALIZED + FINISHED_WITH_RETURN, funder EthSend + child credit for the exact reward, funder delta equals reward minus actual receipt fee, translator settlement delta is zero. ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`,
  };
}

export function buildTimeoutEvidencePayload(input: { wallet?: string; chainId?: number; session: TimeoutSession }): string {
  const overall = overallTimeoutVerdict(input.session);
  const task = input.session.task;
  return jsonStringifySafe(
    {
      label: "LocaleBounty Live Product Test — timeout recovery — public evidence",
      intent: "timeout_recovery",
      live_result: overall.verdict,
      live_result_note:
        overall.verdict === "YES"
          ? overall.reason
          : "UNPROVEN until a funded browser wallet creates, submits, waits until recovery_opens_at_unix, and signs recover_undecided_task. This page never calls evaluate_task. No invented receipts.",
      network: {
        name: "GenLayer Studio Devnet",
        chainIdExpected: 61997,
        chainIdWallet: input.chainId ?? null,
        rpc: "https://studio-dev.genlayer.com/api",
      },
      contract: {
        file: "contracts/localebounty.py",
        address: input.session.address,
        reusedExistingDeploy: true,
        localSourceSha256: input.session.localSourceSha256 ?? null,
        deployedSourceSha256: input.session.deployedSourceSha256 ?? null,
        sourceMatch: input.session.sourceMatch,
        sourceVerifyStatus: input.session.sourceVerifyStatus,
        sourceVerifyReason: input.session.sourceVerifyReason,
      },
      connectedWallet: input.wallet ?? null,
      boundFunder: input.session.boundFunder ?? null,
      boundTranslator: input.session.boundTranslator ?? null,
      boundRewardWei: input.session.boundRewardWei ?? null,
      clientNonce: input.session.clientNonce ?? null,
      expectedTaskId: input.session.expectedTaskId ?? null,
      submitByUnix: input.session.submitByUnix ?? null,
      recoverAfterUnix: input.session.recoverAfterUnix ?? null,
      recoveryOpensAtUnix: task?.recovery_opens_at_unix ?? null,
      create: publicAction(input.session.create),
      submit: publicAction(input.session.submit),
      recover: publicAction(input.session.recover),
      evaluateNeverCalled: true,
      task: task ?? null,
      libraryCountBefore: input.session.libraryCountBefore ?? null,
      libraryCountAfter: input.session.libraryCountAfter ?? null,
      libraryEntry: input.session.libraryEntry ?? null,
      transfer: input.session.transfer ?? null,
      balances: {
        beforeCreate: input.session.beforeCreate ?? null,
        afterCreate: input.session.afterCreate ?? null,
        beforeSubmit: input.session.beforeSubmit ?? null,
        afterSubmit: input.session.afterSubmit ?? null,
        beforeRecover: input.session.beforeRecover ?? null,
        afterRecover: input.session.afterRecover ?? null,
        afterWait: input.session.afterWait ?? null,
      },
      transactionStatus: input.session.recover.statusName ?? input.session.submit.statusName ?? input.session.create.statusName ?? null,
      executionResult: input.session.recover.executionName ?? input.session.submit.executionName ?? input.session.create.executionName ?? null,
      contractDecision: task
        ? {
            state: task.state,
            decision: task.decision,
            payment_kind: task.payment_kind,
            payout_submitted: task.payout_submitted,
            recovery_opens_at_unix: task.recovery_opens_at_unix,
          }
        : null,
      payoutSubmittedNote: PAYOUT_SUBMITTED_IS_NOT_PAYMENT,
      transferDelivery: input.session.transfer?.parseNote ?? null,
      paymentEvidence: input.session.paymentEvidence,
      overall,
      note: "No private keys. Wallet confirmation is not GenLayer success. Parent isSuccessful is not payout or refund paid. Public screens at / use a different persist. /demo stays demo. Phase A/B1/B2 evidence use different persist keys. Timeout YES means proven recover_undecided_task refund only. Live timeout remains UNPROVEN until the wallet run finishes.",
    },
    2,
  );
}

function publicAction(action: TimeoutSession["create"]) {
  return {
    txId: action.txId ?? null,
    statusName: action.statusName ?? null,
    executionName: action.executionName ?? null,
    parentSuccessful: action.parentSuccessful ?? null,
    quotedValueWei: action.quotedValueWei ?? null,
    quotedFeeWei: action.quotedFeeWei ?? null,
    actualFeeWei: action.actualFeeWei ?? null,
    actualFeeSource: action.actualFeeSource ?? null,
    receipt: action.receipt ?? null,
    error: action.error ?? null,
  };
}
