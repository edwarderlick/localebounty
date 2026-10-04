import { parentSuccessIsNotPayment } from "../productB1/evidence";
import { extractFinalizedFee, type FinalizedFee } from "../fees";
import { addressesEqual } from "../format";
import { PAYOUT_SUBMITTED_IS_NOT_PAYMENT } from "../product/evidence";
import { matchingChildCredit, matchingOutgoingTo } from "../product/transfers";
import type { ProductTask } from "../product/task";
import type { Verdict } from "../persist";
import type { EoaBalances } from "../rpc";
import {
  BALANCE_PROOF_UNAVAILABLE,
  DECISION_NONE,
  FEE_PAYER_PROOF_UNAVAILABLE,
  KIND_PAYOUT,
  KIND_REFUND,
  STATE_APPROVED,
  STATE_CANCELLED,
  STATE_REJECTED,
  STATE_SUBMITTED,
  STATE_TIMED_OUT,
} from "./constants";
import { paymentDeliveryView } from "./status";
import type { ProductUiWriteRecord, WriteBalanceSnapshot } from "./writes";
import { cancelConfirmStored, recoverConfirmStored } from "./writeGuards";

export type SettlementView = {
  transactionStatus: string;
  execution: string;
  contractDecision: string;
  transferDelivery: string;
  balanceEvidence: string;
  paymentEvidence: Verdict;
  paymentReason: string;
  outgoingEthSend?: string;
  childCredit?: string;
  receiptFee?: string;
  feeEquation?: string;
};

export type EvaluateFeePayerRole = "translator" | "funder" | "third_party";

export function evaluateFeePayerRole(task: ProductTask, evaluator: string | undefined): EvaluateFeePayerRole {
  if (evaluator && addressesEqual(evaluator, task.translator)) return "translator";
  if (evaluator && addressesEqual(evaluator, task.funder)) return "funder";
  return "third_party";
}

export function evaluateReceiptFee(record: ProductUiWriteRecord): FinalizedFee {
  const fromReceipt = extractFinalizedFee(record.receipt);
  if (fromReceipt.available && fromReceipt.feeWei != null) return fromReceipt;
  if (record.actualFeeAvailable && record.actualFeeWei) {
    return {
      available: true,
      feeWei: BigInt(record.actualFeeWei),
      source: record.actualFeeSource ?? "stored receipt fee",
      reason: `Stored receipt fee ${record.actualFeeWei} wei (${record.actualFeeSource ?? "receipt"}).`,
    };
  }
  return fromReceipt;
}

function evaluatorAddress(record: ProductUiWriteRecord): string {
  return record.beforeBalances?.caller || record.wallet;
}

function snapshotWeiFor(
  snap: WriteBalanceSnapshot | EoaBalances | undefined,
  address: string,
  task: ProductTask,
): string | undefined {
  if (!snap) return undefined;
  const withCaller = snap as WriteBalanceSnapshot;
  if (withCaller.caller && withCaller.callerWei != null && addressesEqual(withCaller.caller, address)) {
    return withCaller.callerWei;
  }
  if (addressesEqual(address, task.funder)) return snap.funderWei;
  if (addressesEqual(address, task.translator)) return snap.namedWei;
  return undefined;
}

function weiDelta(after?: string, before?: string): bigint | null {
  if (after == null || before == null) return null;
  try {
    return BigInt(after) - BigInt(before);
  } catch {
    return null;
  }
}

function hasCallerProof(
  before: WriteBalanceSnapshot | EoaBalances | undefined,
  after: WriteBalanceSnapshot | EoaBalances | undefined,
): boolean {
  const b = before as WriteBalanceSnapshot | undefined;
  const a = after as WriteBalanceSnapshot | undefined;
  return Boolean(b?.caller && b.callerWei != null && a?.caller && a.callerWei != null);
}

export function evaluateFeeEquation(input: {
  approved: boolean;
  role: EvaluateFeePayerRole;
  rewardWei: bigint;
  feeWei?: bigint;
}): string {
  const reward = input.rewardWei.toString();
  const fee = input.feeWei != null ? input.feeWei.toString() : "UNPROVEN receipt fee";
  const net = input.feeWei != null ? (input.rewardWei - input.feeWei).toString() : "UNPROVEN";
  if (input.approved) {
    if (input.role === "translator") {
      return `Approval, evaluator = translator: expected translator net delta = reward − actual receipt fee = ${reward} − ${fee} = ${net} wei.`;
    }
    if (input.role === "funder") {
      return `Approval, evaluator = funder: translator gains reward ${reward} wei; funder pays actual receipt fee ${fee} wei (funder_delta = −${fee}).`;
    }
    return `Approval, third-party evaluator: translator gains reward ${reward} wei; evaluator pays actual receipt fee ${fee} wei (evaluator_delta = −${fee}).`;
  }
  if (input.role === "funder") {
    return `Rejection refund, evaluator = funder: expected funder net delta = reward − actual receipt fee = ${reward} − ${fee} = ${net} wei.`;
  }
  if (input.role === "translator") {
    return `Rejection refund, evaluator = translator: funder gains reward ${reward} wei; translator pays actual receipt fee ${fee} wei (translator_delta = −${fee}).`;
  }
  return `Rejection refund, third-party evaluator: funder gains reward ${reward} wei; evaluator pays actual receipt fee ${fee} wei (evaluator_delta = −${fee}).`;
}

export function decisionLabel(task: ProductTask): string {
  return `state ${task.state} · decision ${task.decision} · payment_kind ${task.payment_kind || "none"} · payment_status ${task.payment_status || "none"}`;
}

export function liveEvaluateSettlement(input: {
  task: ProductTask;
  record: ProductUiWriteRecord;
}): SettlementView {
  const { task, record } = input;
  const transactionStatus = record.statusName ?? "No parent transaction on this browser for this wallet.";
  const execution = `${record.executionName ?? "unread"} · parentSuccessful=${String(Boolean(record.parentSuccessful))}`;
  const contractDecision = decisionLabel(task);
  const parentNote = parentSuccessIsNotPayment(record.statusName, record.executionName, record.parentSuccessful);
  const payoutFlag = paymentDeliveryView(task);
  const evaluator = evaluatorAddress(record);
  const role = evaluateFeePayerRole(task, evaluator);
  const fee = evaluateReceiptFee(record);
  const receiptFee =
    fee.available && fee.feeWei != null
      ? `${fee.feeWei.toString()} wei (${fee.source ?? "receipt"})`
      : `UNPROVEN. ${fee.reason} Balance shortfall is not a receipt fee.`;

  let rewardWei = 0n;
  try {
    rewardWei = BigInt(task.rewardWei);
  } catch {
    rewardWei = 0n;
  }
  const closedApproved = task.state === STATE_APPROVED && task.decision === STATE_APPROVED && task.payment_kind === KIND_PAYOUT;
  const feeEquation =
    task.state === STATE_SUBMITTED && task.decision === DECISION_NONE
      ? `Fee payer is ${role} evaluator ${evaluator}. Receipt fee is shown separately; no payout/refund equation until get_task closes.`
      : evaluateFeeEquation({
          approved: closedApproved,
          role,
          rewardWei,
          feeWei: fee.available ? fee.feeWei : undefined,
        });

  const transfer = record.transfer ?? {
    outgoing: [],
    children: [],
    parseOk: false,
    parseNote: "No transfer evidence stored.",
  };

  if (task.state === STATE_SUBMITTED && task.decision === DECISION_NONE) {
    const failed = record.txId && record.statusName === "FINALIZED" && record.parentSuccessful === false;
    return {
      transactionStatus,
      execution,
      contractDecision,
      transferDelivery: `No settlement transfer. Task stays submitted.${failed ? " Last evaluate finished without isSuccessful. New attempt is allowed." : ""} ${parentNote}`,
      outgoingEthSend: "No settlement EthSend while the task stays submitted.",
      childCredit: "No settlement child credit while the task stays submitted.",
      receiptFee,
      feeEquation,
      balanceEvidence: record.beforeEvaluate || record.beforeBalances
        ? "Evaluate did not close the task; no payout/refund delta is claimed."
        : BALANCE_PROOF_UNAVAILABLE,
      paymentEvidence: "UNPROVEN",
      paymentReason: failed
        ? `Evaluate ${record.txId} is FINALIZED without successful execution. The stored translation is unchanged. Do not assume approval. ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`
        : `GenLayer has not persisted an approved/rejected/timed_out decision. ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`,
    };
  }

  const approved = closedApproved;
  const rejected = task.state === STATE_REJECTED && task.decision === STATE_REJECTED && task.payment_kind === KIND_REFUND;
  const timedOut = task.state === STATE_TIMED_OUT && task.decision === STATE_TIMED_OUT && task.payment_kind === KIND_REFUND;
  const recipient = approved ? task.translator : task.funder;
  const recipientRole = approved ? "translator" : "funder";
  const outgoing = matchingOutgoingTo(transfer, recipient, rewardWei.toString());
  const child = matchingChildCredit(transfer, recipient, rewardWei.toString(), record.txId);
  const outgoingEthSend = outgoing
    ? `Outgoing EthSend to ${recipientRole} ${recipient} value ${rewardWei.toString()} wei.`
    : `UNPROVEN. No outgoing EthSend to the ${recipientRole} for the exact reward. ${transfer.parseNote}`;
  const childCredit = child
    ? `Child value_credited true, recipient ${child.to}, value ${child.valueWei} wei, triggered_by ${child.triggeredBy}${child.txId ? ` (${child.txId})` : ""}.`
    : `UNPROVEN. Child credit requires value_credited=true, exact ${recipientRole} recipient, exact reward, and triggered_by the parent tx ID${record.txId ? ` ${record.txId}` : ""}.`;
  const transferDelivery = `${outgoingEthSend} ${childCredit} ${payoutFlag.hint}`;

  const before = record.beforeBalances ?? record.beforeEvaluate;
  const after = record.afterBalances ?? record.afterEvaluate;
  const missingSnapshot = !before;
  const namedDelta = weiDelta(after?.namedWei, before?.namedWei);
  const funderDelta = weiDelta(after?.funderWei, before?.funderWei);
  const evaluatorDelta = weiDelta(snapshotWeiFor(after, evaluator, task), snapshotWeiFor(before, evaluator, task));
  const callerProof = hasCallerProof(record.beforeBalances, record.afterBalances);
  const feePayerUnproven = role === "third_party" && !callerProof;

  let balanceEvidence = missingSnapshot ? BALANCE_PROOF_UNAVAILABLE : "UNPROVEN. Missing after snapshot.";
  if (!missingSnapshot && namedDelta != null && funderDelta != null) {
    balanceEvidence = `Translator delta ${namedDelta.toString()} wei; funder delta ${funderDelta.toString()} wei; evaluator ${evaluator} (${role}) delta ${evaluatorDelta?.toString() ?? "unread"} wei.`;
    if (feePayerUnproven) balanceEvidence = `${balanceEvidence} ${FEE_PAYER_PROOF_UNAVAILABLE}`;
  } else if (feePayerUnproven && !missingSnapshot) {
    balanceEvidence = FEE_PAYER_PROOF_UNAVAILABLE;
  }

  const closed = approved || rejected || timedOut;
  let paymentEvidence: Verdict = "UNPROVEN";
  let paymentReason = `${feeEquation} ${parentNote} ${payoutFlag.hint}`;

  const otherMustNotGain = (delta: bigint | null, partyIsFeePayer: boolean, partyIsRecipient: boolean): string | undefined => {
    if (partyIsFeePayer || partyIsRecipient) return undefined;
    if (delta != null && delta > 0n) {
      return `Non-recipient non-fee-payer delta is ${delta.toString()} wei; this path must not credit that wallet.`;
    }
    return undefined;
  };

  if (!closed) {
    paymentReason = `Contract state is not a finished payout or refund. ${feeEquation} ${payoutFlag.hint}`;
  } else if (!record.parentSuccessful || record.statusName !== "FINALIZED") {
    paymentReason = `Parent is not FINALIZED + isSuccessful. ${feeEquation} ${parentNote} ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`;
  } else if (!outgoing || !child) {
    paymentReason = `Outgoing EthSend and matching child value_credited are required before any payout/refund claim. ${feeEquation} ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`;
  } else if (missingSnapshot) {
    paymentReason = `${BALANCE_PROOF_UNAVAILABLE} Transfer fields stay separate. ${feeEquation} ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`;
  } else if (namedDelta == null || funderDelta == null || !after) {
    paymentReason = `${BALANCE_PROOF_UNAVAILABLE} ${feeEquation} ${parentNote}`;
  } else if (!fee.available || fee.feeWei == null) {
    paymentReason = `Receipt fee is UNPROVEN. ${fee.reason} Do not treat a balance shortfall as a receipt. ${feeEquation} ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`;
  } else if (feePayerUnproven) {
    paymentEvidence = "UNPROVEN";
    paymentReason = `${FEE_PAYER_PROOF_UNAVAILABLE} ${feeEquation} Transfer fields stay separate. ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`;
  } else {
    const leak = approved
      ? otherMustNotGain(funderDelta, role === "funder", false) ??
        otherMustNotGain(namedDelta, role === "translator", true)
      : otherMustNotGain(namedDelta, role === "translator", false) ??
        otherMustNotGain(funderDelta, role === "funder", true);
    if (leak) {
      paymentReason = `${leak} ${feeEquation}`;
    } else if (approved && role === "translator") {
      const expected = rewardWei - fee.feeWei;
      if (namedDelta === expected) {
        paymentEvidence = "YES";
        paymentReason = `${feeEquation} Observed translator delta ${namedDelta.toString()} wei. ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`;
        balanceEvidence = `${balanceEvidence} Matches reward minus receipt fee.`;
      } else {
        paymentReason = `${feeEquation} Observed translator delta ${namedDelta.toString()} wei does not equal expected ${expected.toString()} wei. ${parentNote}`;
      }
    } else if (approved && role === "funder") {
      if (namedDelta === rewardWei && funderDelta === -fee.feeWei) {
        paymentEvidence = "YES";
        paymentReason = `${feeEquation} Observed translator delta ${namedDelta.toString()} wei; funder delta ${funderDelta.toString()} wei. ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`;
        balanceEvidence = `${balanceEvidence} Translator matches reward; funder matches minus receipt fee.`;
      } else {
        paymentReason = `${feeEquation} Observed translator delta ${namedDelta.toString()} wei (expected ${rewardWei.toString()}); funder delta ${funderDelta.toString()} wei (expected −${fee.feeWei.toString()}). ${parentNote}`;
      }
    } else if (approved && role === "third_party") {
      if (namedDelta === rewardWei && evaluatorDelta === -fee.feeWei) {
        paymentEvidence = "YES";
        paymentReason = `${feeEquation} Observed translator delta ${namedDelta.toString()} wei; evaluator delta ${evaluatorDelta.toString()} wei. ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`;
        balanceEvidence = `${balanceEvidence} Translator matches reward; evaluator matches minus receipt fee.`;
      } else {
        paymentReason = `${feeEquation} Observed translator delta ${namedDelta.toString()} wei (expected ${rewardWei.toString()}); evaluator delta ${evaluatorDelta?.toString() ?? "unread"} wei (expected −${fee.feeWei.toString()}). ${parentNote}`;
      }
    } else if (!approved && role === "funder") {
      const expected = rewardWei - fee.feeWei;
      if (funderDelta === expected) {
        paymentEvidence = "YES";
        paymentReason = `${feeEquation} Observed funder delta ${funderDelta.toString()} wei. ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`;
        balanceEvidence = `${balanceEvidence} Matches reward minus receipt fee.`;
      } else {
        paymentReason = `${feeEquation} Observed funder delta ${funderDelta.toString()} wei does not equal expected ${expected.toString()} wei. ${parentNote}`;
      }
    } else if (!approved && role === "translator") {
      if (funderDelta === rewardWei && namedDelta === -fee.feeWei) {
        paymentEvidence = "YES";
        paymentReason = `${feeEquation} Observed funder delta ${funderDelta.toString()} wei; translator delta ${namedDelta.toString()} wei. ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`;
        balanceEvidence = `${balanceEvidence} Funder matches reward; translator matches minus receipt fee.`;
      } else {
        paymentReason = `${feeEquation} Observed funder delta ${funderDelta.toString()} wei (expected ${rewardWei.toString()}); translator delta ${namedDelta.toString()} wei (expected −${fee.feeWei.toString()}). ${parentNote}`;
      }
    } else if (!approved && role === "third_party") {
      if (funderDelta === rewardWei && evaluatorDelta === -fee.feeWei) {
        paymentEvidence = "YES";
        paymentReason = `${feeEquation} Observed funder delta ${funderDelta.toString()} wei; evaluator delta ${evaluatorDelta.toString()} wei. ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`;
        balanceEvidence = `${balanceEvidence} Funder matches reward; evaluator matches minus receipt fee.`;
      } else {
        paymentReason = `${feeEquation} Observed funder delta ${funderDelta.toString()} wei (expected ${rewardWei.toString()}); evaluator delta ${evaluatorDelta?.toString() ?? "unread"} wei (expected −${fee.feeWei.toString()}). ${parentNote}`;
      }
    }
  }

  return {
    transactionStatus,
    execution,
    contractDecision,
    transferDelivery,
    outgoingEthSend,
    childCredit,
    receiptFee,
    feeEquation,
    balanceEvidence,
    paymentEvidence,
    paymentReason,
  };
}

export type RefundEvidenceView = SettlementView & {
  outgoingEthSend: string;
  childCredit: string;
  receiptFee: string;
};

export function liveRefundEvidence(input: {
  task: ProductTask;
  record: ProductUiWriteRecord;
  expected: "cancel" | "recover" | "expire";
}): RefundEvidenceView {
  const { task, record } = input;
  const confirm =
    input.expected === "cancel"
      ? cancelConfirmStored(task)
      : input.expected === "recover"
        ? recoverConfirmStored(task)
        : task.state === "expired" && task.decision === "expired" && task.payment_kind === KIND_REFUND
          ? { ok: true as const }
          : { ok: false as const, reason: `Task state after expire is ${task.state}, decision ${task.decision}, payment_kind ${task.payment_kind || "none"}; expected expired refund.` };
  const expectedState = input.expected === "cancel" ? STATE_CANCELLED : input.expected === "recover" ? STATE_TIMED_OUT : "expired";
  const transactionStatus = record.statusName ?? "No parent transaction on this browser for this wallet.";
  const execution = `${record.executionName ?? "unread"} · parentSuccessful=${String(Boolean(record.parentSuccessful))}`;
  const contractDecision = decisionLabel(task);
  const parentNote = parentSuccessIsNotPayment(record.statusName, record.executionName, record.parentSuccessful);
  const payoutFlag = paymentDeliveryView(task);
  const fee = record.actualFeeAvailable && record.actualFeeWei
    ? { available: true as const, feeWei: BigInt(record.actualFeeWei), source: record.actualFeeSource, reason: `Stored receipt fee ${record.actualFeeWei} wei.` }
    : extractFinalizedFee(record.receipt);
  const receiptFee = fee.available && fee.feeWei != null
    ? `${fee.feeWei.toString()} wei (${fee.source ?? "receipt"})`
    : `UNPROVEN. ${fee.reason}`;

  let rewardWei = 0n;
  try {
    rewardWei = BigInt(task.rewardWei);
  } catch {
    rewardWei = 0n;
  }

  const transfer = record.transfer ?? {
    outgoing: [],
    children: [],
    parseOk: false,
    parseNote: "No transfer evidence stored.",
  };
  const outgoing = matchingOutgoingTo(transfer, task.funder, rewardWei.toString());
  const child = matchingChildCredit(transfer, task.funder, rewardWei.toString(), record.txId);
  const outgoingEthSend = outgoing
    ? `Outgoing EthSend to funder ${task.funder} value ${rewardWei.toString()} wei.`
    : `UNPROVEN. No outgoing EthSend to the funder for the exact reward. ${transfer.parseNote}`;
  const childCredit = child
    ? `Child value_credited true, recipient ${child.to}, value ${child.valueWei} wei, triggered_by ${child.triggeredBy}${child.txId ? ` (${child.txId})` : ""}.`
    : `UNPROVEN. Child credit requires value_credited=true, exact funder recipient, exact reward, and triggered_by the parent tx ID${record.txId ? ` ${record.txId}` : ""}.`;

  const before = record.beforeBalances ?? record.beforeEvaluate;
  const after = record.afterBalances ?? record.afterEvaluate;
  const missingSnapshot = !before;
  const funderDelta = weiDelta(after?.funderWei, before?.funderWei);
  const namedDelta = weiDelta(after?.namedWei, before?.namedWei);
  const caller = record.beforeBalances?.caller ?? record.wallet;
  const callerDelta = weiDelta(record.afterBalances?.callerWei, record.beforeBalances?.callerWei);
  const callerIsFunder = Boolean(caller && addressesEqual(caller, task.funder));

  let balanceEvidence = missingSnapshot ? BALANCE_PROOF_UNAVAILABLE : "UNPROVEN. Missing after snapshot.";
  if (!missingSnapshot && funderDelta != null && namedDelta != null) {
    balanceEvidence = callerIsFunder
      ? `Funder/caller delta ${funderDelta.toString()} wei; translator delta ${namedDelta.toString()} wei. Funder-caller net should equal reward minus receipt fee.`
      : `Funder delta ${funderDelta.toString()} wei (should equal reward); caller ${caller} delta ${callerDelta?.toString() ?? "unread"} wei (should equal minus receipt fee); translator delta ${namedDelta.toString()} wei.`;
  }

  const failed = record.txId && record.statusName === "FINALIZED" && record.parentSuccessful === false;
  if (failed || task.state !== expectedState) {
    return {
      transactionStatus,
      execution,
      contractDecision,
      transferDelivery: `${outgoingEthSend} ${childCredit}`,
      outgoingEthSend,
      childCredit,
      receiptFee,
      balanceEvidence: missingSnapshot ? BALANCE_PROOF_UNAVAILABLE : balanceEvidence,
      paymentEvidence: "UNPROVEN",
      paymentReason: failed
        ? `${input.expected} ${record.txId} is FINALIZED without successful execution. Task state is ${task.state}. Do not infer a refund. Use New attempt. ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`
        : confirm.ok
          ? parentNote
          : `${confirm.reason} ${parentNote} ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`,
    };
  }

  let paymentEvidence: Verdict = "UNPROVEN";
  let paymentReason = `${parentNote} ${payoutFlag.hint}`;
  if (!record.parentSuccessful || record.statusName !== "FINALIZED") {
    paymentReason = `Parent is not FINALIZED + isSuccessful. ${parentNote} ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`;
  } else if (!outgoing || !child) {
    paymentReason = `Outgoing EthSend and matching child value_credited are required before any refund claim. ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`;
  } else if (missingSnapshot) {
    paymentReason = `${BALANCE_PROOF_UNAVAILABLE} Transfer fields stay separate. ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`;
  } else if (funderDelta == null || namedDelta == null || !after) {
    paymentReason = `${BALANCE_PROOF_UNAVAILABLE} ${parentNote}`;
  } else if (!fee.available || fee.feeWei == null) {
    paymentReason = `Receipt fee is UNPROVEN. ${fee.reason} ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`;
  } else if (callerIsFunder) {
    const expected = rewardWei - fee.feeWei;
    if (namedDelta > 0n) {
      paymentReason = `Translator delta is ${namedDelta.toString()} wei; this refund must not credit the translator.`;
    } else if (funderDelta === expected) {
      paymentEvidence = "YES";
      paymentReason = `Funder-caller refund: funder delta ${funderDelta.toString()} wei equals reward minus receipt fee ${fee.feeWei.toString()} wei. ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`;
      balanceEvidence = `${balanceEvidence} Matches reward minus receipt fee.`;
    } else {
      paymentReason = `Funder-caller delta ${funderDelta.toString()} wei does not equal reward minus receipt fee (expected ${expected.toString()}). ${parentNote}`;
    }
  } else {
    if (namedDelta > 0n && !(caller && addressesEqual(caller, task.translator))) {
      paymentReason = `Translator delta is ${namedDelta.toString()} wei; this refund must not credit the translator.`;
    } else if (funderDelta !== rewardWei) {
      paymentReason = `Third-party recover: funder delta ${funderDelta.toString()} wei does not equal the exact reward ${rewardWei.toString()} wei. The caller pays the fee separately. ${parentNote}`;
    } else if (callerDelta == null) {
      paymentReason = `${BALANCE_PROOF_UNAVAILABLE} Caller ${caller} fee delta was not snapshotted. Funder received the reward field; fee proof stays separate.`;
      balanceEvidence = BALANCE_PROOF_UNAVAILABLE;
    } else if (callerDelta !== -fee.feeWei) {
      paymentReason = `Caller ${caller} delta ${callerDelta.toString()} wei does not equal minus receipt fee ${fee.feeWei.toString()} wei. Funder delta matches reward. ${parentNote}`;
    } else {
      paymentEvidence = "YES";
      paymentReason = `Third-party recover: funder gained the exact reward ${rewardWei.toString()} wei; caller ${caller} paid receipt fee ${fee.feeWei.toString()} wei. ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`;
      balanceEvidence = `${balanceEvidence} Funder matches reward; caller matches minus receipt fee.`;
    }
  }

  return {
    transactionStatus,
    execution,
    contractDecision,
    transferDelivery: `${outgoingEthSend} ${childCredit} ${payoutFlag.hint}`,
    outgoingEthSend,
    childCredit,
    receiptFee,
    balanceEvidence,
    paymentEvidence,
    paymentReason,
  };
}
