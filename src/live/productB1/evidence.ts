import { extractFinalizedFee, type FinalizedFee } from "../fees";
import { jsonStringifySafe } from "../format";
import { isFinalizedSuccessful } from "../guards";
import type { EoaBalances } from "../rpc";
import { PAYOUT_SUBMITTED_IS_NOT_PAYMENT } from "../product/evidence";
import { sourceBindingStillValid } from "../product/source";
import { createdTaskMatchesBound } from "../product/task";
import {
  childCreditRequirementNote,
  matchingChildCredit,
  matchingOutgoingTo,
  type TransferEvidence,
} from "../product/transfers";
import {
  DECISION_NONE,
  KIND_PAYOUT,
  KIND_REFUND,
  STATE_APPROVED,
  STATE_REJECTED,
  STATE_SUBMITTED,
  STATE_TIMED_OUT,
} from "./constants";
import { assertNoLibraryForTask, libraryEntryMatchesTask } from "./library";
import { b1SessionRewardWei } from "./guards";
import type { B1Session, Verdict } from "./persist";

function delta(after: string | null | undefined, before: string | null | undefined): bigint | null {
  if (after == null || before == null) return null;
  try {
    return BigInt(after) - BigInt(before);
  } catch {
    return null;
  }
}

export function parentSuccessIsNotPayment(statusName?: string, executionName?: string, parentSuccessful?: boolean): string {
  return `Transaction status ${statusName ?? "unknown"} and execution ${executionName ?? "unknown"} (parentSuccessful=${String(Boolean(parentSuccessful))}) are not transfer delivery and are not balance evidence.`;
}

export function feeFromAction(action: B1Session["evaluate"]): FinalizedFee {
  if (action.actualFeeAvailable && action.actualFeeWei) {
    return {
      available: true,
      feeWei: BigInt(action.actualFeeWei),
      source: action.actualFeeSource,
      reason: `Stored receipt fee ${action.actualFeeWei} wei (${action.actualFeeSource ?? "receipt"}).`,
    };
  }
  return extractFinalizedFee(action.receipt);
}

export function evaluateSettlement(input: {
  parentSuccessful: boolean;
  statusName?: string;
  executionName?: string;
  parentTxId?: string;
  rewardWei: bigint;
  recipient: string;
  otherParty: string;
  otherMustNotGain: boolean;
  transfer: TransferEvidence | undefined;
  before?: EoaBalances;
  after?: EoaBalances;
  actualFee: FinalizedFee;
  recipientIsFunder: boolean;
}): { verdict: Verdict; reason: string; transferLabel: string; balanceLabel: string } {
  const parentNote = parentSuccessIsNotPayment(input.statusName, input.executionName, input.parentSuccessful);
  const transfer = input.transfer ?? {
    outgoing: [],
    children: [],
    parseOk: false,
    parseNote: "No transfer evidence stored.",
  };
  const outgoing = matchingOutgoingTo(transfer, input.recipient, input.rewardWei.toString());
  const child = matchingChildCredit(transfer, input.recipient, input.rewardWei.toString(), input.parentTxId);
  const transferOk = Boolean(outgoing && child);
  const transferLabel = transferOk
    ? `Outgoing EthSend to ${input.recipient} value ${input.rewardWei.toString()} wei; child value_credited true, triggered_by ${child?.triggeredBy}${child?.txId ? ` (${child.txId})` : ""}.`
    : `UNPROVEN. ${childCreditRequirementNote(input.parentTxId)} ${transfer.parseNote} ${parentNote}`;

  const recipientKey = input.recipientIsFunder ? "funderWei" : "namedWei";
  const otherKey = input.recipientIsFunder ? "namedWei" : "funderWei";
  const recipientDelta = delta(input.after?.[recipientKey], input.before?.[recipientKey]);
  const otherDelta = delta(input.after?.[otherKey], input.before?.[otherKey]);
  let balanceLabel = "UNPROVEN. Missing before/after Studio-dev EOA balances.";
  if (recipientDelta != null && otherDelta != null) {
    balanceLabel = `Recipient delta ${recipientDelta.toString()} wei; other party delta ${otherDelta.toString()} wei.`;
  }

  if (!input.parentSuccessful || input.statusName !== "FINALIZED") {
    return {
      verdict: "UNPROVEN",
      reason: `Settlement parent is not FINALIZED + isSuccessful. ${parentNote}`,
      transferLabel,
      balanceLabel,
    };
  }
  if (!transferOk) {
    return {
      verdict: "UNPROVEN",
      reason: `Settlement parent succeeded. ${parentNote} Outgoing EthSend and child value_credited are required before any payout/refund claim. ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`,
      transferLabel,
      balanceLabel,
    };
  }
  if (recipientDelta == null || otherDelta == null || !input.before || !input.after) {
    return {
      verdict: "UNPROVEN",
      reason: `Transfer fields were parsed, but EOA delta is still UNPROVEN. ${parentNote}`,
      transferLabel,
      balanceLabel,
    };
  }
  if (input.otherMustNotGain && otherDelta > 0n) {
    return {
      verdict: "UNPROVEN",
      reason: `Other party delta is ${otherDelta.toString()} wei; this path must not credit that wallet.`,
      transferLabel,
      balanceLabel,
    };
  }

  if (input.recipientIsFunder) {
    if (!input.actualFee.available || input.actualFee.feeWei == null) {
      return {
        verdict: "UNPROVEN",
        reason: `Fee-adjusted funder refund is UNPROVEN. ${input.actualFee.reason} ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`,
        transferLabel,
        balanceLabel,
      };
    }
    const expected = input.rewardWei - input.actualFee.feeWei;
    if (recipientDelta === expected) {
      return {
        verdict: "YES",
        reason: `Refund delivered: funder delta ${recipientDelta.toString()} wei equals reward minus receipt fee ${input.actualFee.feeWei.toString()} wei. ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`,
        transferLabel,
        balanceLabel: `${balanceLabel} Matches reward minus receipt fee.`,
      };
    }
    return {
      verdict: "UNPROVEN",
      reason: `Funder delta ${recipientDelta.toString()} wei does not equal reward minus receipt fee (expected ${expected.toString()}). ${parentNote}`,
      transferLabel,
      balanceLabel,
    };
  }

  if (recipientDelta === input.rewardWei) {
    return {
      verdict: "YES",
      reason: `Payout delivered: translator delta ${recipientDelta.toString()} wei equals the exact reward. ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`,
      transferLabel,
      balanceLabel: `${balanceLabel} Matches exact reward.`,
    };
  }
  return {
    verdict: "UNPROVEN",
    reason: `Translator delta ${recipientDelta.toString()} wei does not equal reward ${input.rewardWei.toString()} wei. ${parentNote}`,
    transferLabel,
    balanceLabel,
  };
}

export function overallB1Verdict(session: B1Session): { verdict: Verdict; reason: string } {
  const storedFlag = `UNPROVEN. Stored paymentEvidence is not proof. ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`;
  if (!sourceBindingStillValid(session, session.localSourceSha256 ?? "")) {
    return { verdict: "UNPROVEN", reason: `Source is not bound to the existing product contract and PRODUCT_SOURCE SHA-256. ${storedFlag}` };
  }
  if (!isFinalizedSuccessful(session.create) || !isFinalizedSuccessful(session.submit)) {
    return { verdict: "UNPROVEN", reason: `Phase B1 create/submit writes are incomplete. ${storedFlag}` };
  }
  const rewardWei = b1SessionRewardWei(session);
  const funder = session.boundFunder;
  const translator = session.boundTranslator;
  if (rewardWei == null || !funder || !translator || !session.clientNonce || !session.expectedTaskId) {
    return { verdict: "UNPROVEN", reason: `Bound create identity is missing. ${storedFlag}` };
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
    return { verdict: "UNPROVEN", reason: `get_task does not match the bound session: ${created.reason} ${storedFlag}` };
  }
  const task = session.task!;
  if (session.boundTranslation && task.translation !== session.boundTranslation) {
    return { verdict: "UNPROVEN", reason: `Stored translation does not match the bound submit text. ${storedFlag}` };
  }

  const settleAction = isFinalizedSuccessful(session.recover)
    ? session.recover
    : session.evaluate;
  const settleTxId = settleAction.txId;
  const failedClosed =
    (session.evaluate.txId && isFinalizedSuccessful(session.evaluate) === false && task.state === STATE_SUBMITTED) ||
    (session.evaluate.txId && session.evaluate.statusName === "FINALIZED" && !session.evaluate.parentSuccessful && task.state === STATE_SUBMITTED);

  if (task.state === STATE_SUBMITTED && task.decision === DECISION_NONE) {
    return {
      verdict: "UNPROVEN",
      reason: `Task stays submitted. GenLayer did not persist an approved/rejected/timed_out decision. Retry evaluate_task or wait until recovery_opens_at_unix=${task.recovery_opens_at_unix}. Do not assume AI will approve. ${failedClosed ? "The last evaluate write finished without isSuccessful." : ""} ${storedFlag}`,
    };
  }

  const approved = task.state === STATE_APPROVED && task.decision === STATE_APPROVED && task.payment_kind === KIND_PAYOUT;
  const rejected = task.state === STATE_REJECTED && task.decision === STATE_REJECTED && task.payment_kind === KIND_REFUND;
  const timedOut = task.state === STATE_TIMED_OUT && task.decision === STATE_TIMED_OUT && task.payment_kind === KIND_REFUND;
  if (!approved && !rejected && !timedOut) {
    return {
      verdict: "UNPROVEN",
      reason: `Contract state ${task.state} / decision ${task.decision} / payment_kind ${task.payment_kind} is not a finished Phase B1 settlement. ${storedFlag}`,
    };
  }

  if (approved) {
    const lib = libraryEntryMatchesTask({
      entry: session.libraryEntry,
      taskId: task.task_id,
      translation: task.translation,
      stringKey: task.string_key,
      locale: task.target_locale,
    });
    if (!lib.ok) return { verdict: "UNPROVEN", reason: `${lib.reason} ${storedFlag}` };
  } else {
    const none = assertNoLibraryForTask({
      count: session.libraryCountAfter,
      entry: session.libraryEntry,
      taskId: task.task_id,
    });
    if (!none.ok) return { verdict: "UNPROVEN", reason: `${none.reason} ${storedFlag}` };
  }

  if (!settleTxId || !isFinalizedSuccessful(settleAction) || settleAction.executionName !== "FINISHED_WITH_RETURN") {
    return {
      verdict: "UNPROVEN",
      reason: `Settlement write is not FINALIZED + FINISHED_WITH_RETURN. ${storedFlag}`,
    };
  }

  const evalResult = evaluateSettlement({
    parentSuccessful: Boolean(settleAction.parentSuccessful),
    statusName: settleAction.statusName,
    executionName: settleAction.executionName,
    parentTxId: settleTxId,
    rewardWei,
    recipient: approved ? translator : funder,
    otherParty: approved ? funder : translator,
    otherMustNotGain: true,
    transfer: session.transfer,
    before: session.beforeRecover && timedOut ? session.beforeRecover : session.beforeEvaluate,
    after: session.afterWait ?? session.afterRecover ?? session.afterEvaluate,
    actualFee: feeFromAction(settleAction),
    recipientIsFunder: !approved,
  });
  if (evalResult.verdict !== "YES") {
    return { verdict: "UNPROVEN", reason: `${evalResult.reason} ${storedFlag}` };
  }
  return {
    verdict: "YES",
    reason: approved
      ? `Phase B1 create, submit, evaluate approval, task-linked library entry, translator EthSend, child credit, and translator delta are proven from live evidence. ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`
      : `Phase B1 create, submit, ${timedOut ? "timeout recovery" : "evaluate rejection"}, no library entry for this task, funder refund EthSend, child credit, and fee-adjusted funder delta are proven from live evidence. ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`,
  };
}

export function buildB1EvidencePayload(input: { wallet?: string; chainId?: number; session: B1Session }): string {
  const overall = overallB1Verdict(input.session);
  const task = input.session.task;
  return jsonStringifySafe(
    {
      label: "LocaleBounty Live Product Test Phase B1 — public evidence",
      live_result: overall.verdict,
      live_result_note:
        overall.verdict === "YES"
          ? overall.reason
          : "UNPROVEN until a funded browser wallet completes this page. No invented receipts, fees, or payouts. GenLayer AI is not assumed to approve.",
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
      contractDecision: task ? { state: task.state, decision: task.decision, payment_kind: task.payment_kind, payout_submitted: task.payout_submitted, recovery_opens_at_unix: task.recovery_opens_at_unix } : null,
      payoutSubmittedNote: PAYOUT_SUBMITTED_IS_NOT_PAYMENT,
      transferDelivery: input.session.transfer?.parseNote ?? null,
      paymentEvidence: input.session.paymentEvidence,
      overall,
      note: "No private keys. Wallet confirmation is not GenLayer success. Parent isSuccessful is not payout or refund paid. Public screens at / use a different persist. /demo stays demo. Phase A evidence is a different persist key.",
    },
    2,
  );
}

function publicAction(action: B1Session["create"]) {
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
