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
  KIND_PAYOUT,
  KIND_REFUND,
  STATE_APPROVED,
  STATE_REJECTED,
  STATE_SUBMITTED,
  STATE_TIMED_OUT,
} from "./constants";
import type { B2Session, Verdict } from "./persist";

export { evaluateSettlement, feeFromAction };

export type B2Verdict = {
  verdict: Verdict;
  reason: string;
  unexpectedApproval: boolean;
};

const storedFlag = () => `UNPROVEN. Stored paymentEvidence is not proof. ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`;

export function overallB2Verdict(session: B2Session): B2Verdict {
  const flag = storedFlag();
  if (!sourceBindingStillValid(session, session.localSourceSha256 ?? "")) {
    return { verdict: "UNPROVEN", reason: `Source is not bound to the existing product contract and PRODUCT_SOURCE SHA-256. ${flag}`, unexpectedApproval: false };
  }
  if (!isFinalizedSuccessful(session.create) || !isFinalizedSuccessful(session.submit)) {
    return { verdict: "UNPROVEN", reason: `Phase B2 create/submit writes are incomplete. ${flag}`, unexpectedApproval: false };
  }
  const rewardWei = b1SessionRewardWei(session);
  const funder = session.boundFunder;
  const translator = session.boundTranslator;
  if (rewardWei == null || !funder || !translator || !session.clientNonce || !session.expectedTaskId) {
    return { verdict: "UNPROVEN", reason: `Bound create identity is missing. ${flag}`, unexpectedApproval: false };
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
    return { verdict: "UNPROVEN", reason: `get_task does not match the bound session: ${created.reason} ${flag}`, unexpectedApproval: false };
  }
  const task = session.task!;
  if (session.boundTranslation && task.translation !== session.boundTranslation) {
    return { verdict: "UNPROVEN", reason: `Stored translation does not match the bound submit text. ${flag}`, unexpectedApproval: false };
  }

  const failedClosed =
    (session.evaluate.txId && isFinalizedSuccessful(session.evaluate) === false && task.state === STATE_SUBMITTED) ||
    (session.evaluate.txId && session.evaluate.statusName === "FINALIZED" && !session.evaluate.parentSuccessful && task.state === STATE_SUBMITTED);

  if (task.state === STATE_SUBMITTED && task.decision === DECISION_NONE) {
    return {
      verdict: "UNPROVEN",
      reason: `Task stays submitted. GenLayer did not persist an approved/rejected/timed_out decision. Retry evaluate_task or wait until recovery_opens_at_unix=${task.recovery_opens_at_unix}. Do not assume AI will reject. Stored evaluate tx IDs are kept and not resubmitted. ${failedClosed ? "The last evaluate write finished without isSuccessful." : ""} ${flag}`,
      unexpectedApproval: false,
    };
  }

  const approved = task.state === STATE_APPROVED && task.decision === STATE_APPROVED && task.payment_kind === KIND_PAYOUT;
  const rejected = task.state === STATE_REJECTED && task.decision === STATE_REJECTED && task.payment_kind === KIND_REFUND;
  const timedOut = task.state === STATE_TIMED_OUT && task.decision === STATE_TIMED_OUT && task.payment_kind === KIND_REFUND;

  if (approved) {
    const payout = evaluateSettlement({
      parentSuccessful: Boolean(session.evaluate.parentSuccessful),
      statusName: session.evaluate.statusName,
      executionName: session.evaluate.executionName,
      parentTxId: session.evaluate.txId,
      rewardWei,
      recipient: translator,
      otherParty: funder,
      otherMustNotGain: true,
      transfer: session.transfer,
      before: session.beforeEvaluate,
      after: session.afterWait ?? session.afterEvaluate,
      actualFee: feeFromAction(session.evaluate),
      recipientIsFunder: false,
    });
    return {
      verdict: "UNPROVEN",
      reason: `AI/contract approved this translation. Phase B2 rejection is not proven and is not labeled YES. Actual payout: ${payout.reason} ${payout.transferLabel} ${payout.balanceLabel} ${flag}`,
      unexpectedApproval: true,
    };
  }

  if (timedOut) {
    return {
      verdict: "UNPROVEN",
      reason: `Task timed out via recover_undecided_task. That is not a Phase B2 evaluate rejection. ${flag}`,
      unexpectedApproval: false,
    };
  }

  if (!rejected) {
    return {
      verdict: "UNPROVEN",
      reason: `Contract state ${task.state} / decision ${task.decision} / payment_kind ${task.payment_kind} is not a Phase B2 rejection. ${flag}`,
      unexpectedApproval: false,
    };
  }

  const lib = libraryUnchangedForReject({
    countBefore: session.libraryCountBefore,
    countAfter: session.libraryCountAfter,
    entry: session.libraryEntry,
    taskId: task.task_id,
  });
  if (!lib.ok) return { verdict: "UNPROVEN", reason: `${lib.reason} ${flag}`, unexpectedApproval: false };

  if (!session.evaluate.txId || !isFinalizedSuccessful(session.evaluate) || session.evaluate.executionName !== "FINISHED_WITH_RETURN") {
    return {
      verdict: "UNPROVEN",
      reason: `Evaluate write is not FINALIZED + FINISHED_WITH_RETURN. ${parentSuccessIsNotPayment(session.evaluate.statusName, session.evaluate.executionName, session.evaluate.parentSuccessful)} ${flag}`,
      unexpectedApproval: false,
    };
  }

  const refund = evaluateSettlement({
    parentSuccessful: Boolean(session.evaluate.parentSuccessful),
    statusName: session.evaluate.statusName,
    executionName: session.evaluate.executionName,
    parentTxId: session.evaluate.txId,
    rewardWei,
    recipient: funder,
    otherParty: translator,
    otherMustNotGain: true,
    transfer: session.transfer,
    before: session.beforeEvaluate,
    after: session.afterWait ?? session.afterEvaluate,
    actualFee: feeFromAction(session.evaluate),
    recipientIsFunder: true,
  });
  if (refund.verdict !== "YES") {
    return { verdict: "UNPROVEN", reason: `${refund.reason} ${flag}`, unexpectedApproval: false };
  }
  return {
    verdict: "YES",
    reason: `Phase B2 evaluate rejection proven: get_task rejected/refund, library version count unchanged and no entry for this task, evaluate FINALIZED + FINISHED_WITH_RETURN, funder EthSend + child credit for the exact reward, funder delta equals reward minus actual receipt fee, translator did not gain from settlement. ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`,
    unexpectedApproval: false,
  };
}

export function buildB2EvidencePayload(input: { wallet?: string; chainId?: number; session: B2Session }): string {
  const overall = overallB2Verdict(input.session);
  const task = input.session.task;
  return jsonStringifySafe(
    {
      label: "LocaleBounty Live Product Test Phase B2 — public evidence",
      intent: "evaluate_rejection",
      live_result: overall.verdict,
      live_result_note:
        overall.verdict === "YES"
          ? overall.reason
          : overall.unexpectedApproval
            ? overall.reason
            : "UNPROVEN until a funded browser wallet completes this page. No invented receipts, fees, or rejections. GenLayer AI is not assumed to reject.",
      unexpectedApproval: overall.unexpectedApproval,
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
      create: publicAction(input.session.create),
      submit: publicAction(input.session.submit),
      evaluate: publicAction(input.session.evaluate),
      recover: publicAction(input.session.recover),
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
        beforeEvaluate: input.session.beforeEvaluate ?? null,
        afterEvaluate: input.session.afterEvaluate ?? null,
        beforeRecover: input.session.beforeRecover ?? null,
        afterRecover: input.session.afterRecover ?? null,
        afterWait: input.session.afterWait ?? null,
      },
      transactionStatus: input.session.recover.statusName ?? input.session.evaluate.statusName ?? input.session.submit.statusName ?? input.session.create.statusName ?? null,
      executionResult: input.session.recover.executionName ?? input.session.evaluate.executionName ?? input.session.submit.executionName ?? input.session.create.executionName ?? null,
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
      note: "No private keys. Wallet confirmation is not GenLayer success. Parent isSuccessful is not payout or refund paid. Public screens at / use a different persist. /demo stays demo. Phase A and Phase B1 evidence use different persist keys. Phase B2 YES means proven evaluate rejection only.",
    },
    2,
  );
}

function publicAction(action: B2Session["create"]) {
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
