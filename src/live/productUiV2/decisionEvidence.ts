import { jsonSafe, jsonStringifySafe } from "../format";
import { STUDIO_DEV_CHAIN_ID, STUDIO_DEV_EXPLORER, STUDIO_DEV_NAME, STUDIO_DEV_RPC } from "../network";
import { PAYOUT_SUBMITTED_IS_NOT_PAYMENT } from "../product/evidence";
import { matchingChildCredit, matchingOutgoingTo } from "../product/transfers";
import type { ProductV2Task } from "../productV2/task";
import { evaluateFeePayerRole, evaluateReceiptFee, liveEvaluateSettlement } from "../productUi/settlement";
import { PRODUCT_UI_V2_CONTRACT, PRODUCT_UI_V2_SOURCE_SHA256 } from "./constants";
import { loadProductUiV2Session } from "./persist";
import { loadV2WritesStore, type ProductUiV2WriteAction, type ProductUiV2WriteRecord } from "./writes";

export type V2DecisionEvidenceInput = {
  task: ProductV2Task;
  record: ProductUiV2WriteRecord;
  wallet?: string;
  chainId?: number;
};

function actionSummary(record: ProductUiV2WriteRecord) {
  return {
    txId: record.txId,
    wallet: record.wallet,
    statusName: record.statusName,
    executionName: record.executionName,
    parentSuccessful: record.parentSuccessful,
    submittedAt: record.submittedAt,
  };
}

function relatedCreate(taskId: string) {
  const session = loadProductUiV2Session();
  const id = taskId.toLowerCase();
  const matches =
    session.createTask?.task_id?.toLowerCase() === id ||
    session.expectedTaskId?.toLowerCase() === id ||
    session.navigatedTaskId?.toLowerCase() === id ||
    session.lastOpenedTaskId?.toLowerCase() === id;
  if (!matches || !session.create.txId) return undefined;
  return {
    txId: session.create.txId,
    statusName: session.create.statusName,
    executionName: session.create.executionName,
    parentSuccessful: session.create.parentSuccessful,
    expectedTaskId: session.expectedTaskId,
    clientNonce: session.clientNonce,
    boundRewardWei: session.boundRewardWei,
    boundFunder: session.boundFunder,
    boundTranslator: session.boundTranslator,
  };
}

function relatedAction(taskId: string, action: ProductUiV2WriteAction, wallet?: string) {
  const id = taskId.toLowerCase();
  const matches = Object.values(loadV2WritesStore().records).filter(
    (item) => item.action === action && item.taskId.toLowerCase() === id && Boolean(item.txId),
  );
  if (!matches.length) return undefined;
  const preferred =
    (wallet ? matches.find((item) => item.wallet.toLowerCase() === wallet.toLowerCase()) : undefined) ??
    (matches.length === 1 ? matches[0] : undefined);
  if (preferred?.txId) return actionSummary(preferred);
  return {
    ambiguous: true,
    note: `Multiple stored ${action} hashes exist for this task. No hash was inferred as canonical.`,
    records: matches.map(actionSummary),
  };
}

function delta(after?: string, before?: string): string | undefined {
  if (after == null || before == null) return undefined;
  try {
    return (BigInt(after) - BigInt(before)).toString();
  } catch {
    return undefined;
  }
}

export function buildV2DecisionEvidenceObject(input: V2DecisionEvidenceInput): Record<string, unknown> {
  const { task, record } = input;
  const settled = liveEvaluateSettlement({ task, record: record as never });
  const evaluator = record.beforeBalances?.caller || record.wallet;
  const role = evaluateFeePayerRole(task, evaluator);
  const fee = evaluateReceiptFee(record as never);
  const before = record.beforeBalances ?? record.beforeEvaluate;
  const after = record.afterBalances ?? record.afterEvaluate;
  const rewardWei = (() => {
    try {
      return BigInt(task.rewardWei).toString();
    } catch {
      return undefined;
    }
  })();
  const recipient = task.state === "approved" ? task.translator : task.funder;
  const transfer = record.transfer ?? { outgoing: [], children: [], parseOk: false, parseNote: "No transfer evidence stored." };
  const outgoing = rewardWei ? matchingOutgoingTo(transfer, recipient, rewardWei) : undefined;
  const child = rewardWei ? matchingChildCredit(transfer, recipient, rewardWei, record.txId) : undefined;
  const create = relatedCreate(task.task_id);
  const accept = relatedAction(task.task_id, "accept", task.translator);
  const submit = relatedAction(task.task_id, "submit", task.translator);
  const evaluate = record.txId ? actionSummary(record) : relatedAction(task.task_id, "evaluate", input.wallet ?? record.wallet);

  return {
    kind: "localebounty.product-ui-v2.decision-evidence.v1",
    live_result: settled.paymentEvidence,
    network: {
      name: STUDIO_DEV_NAME,
      chainIdExpected: STUDIO_DEV_CHAIN_ID,
      chainIdWallet: input.chainId ?? record.chainId ?? null,
      rpc: STUDIO_DEV_RPC,
      explorer: STUDIO_DEV_EXPLORER,
    },
    contract: PRODUCT_UI_V2_CONTRACT,
    sourceSha256Pin: PRODUCT_UI_V2_SOURCE_SHA256,
    taskId: task.task_id,
    createTx: create,
    acceptTx: accept,
    submitTx: submit,
    evaluateTx: evaluate,
    funder: task.funder,
    translator: task.translator,
    evaluator,
    feePayerRole: role,
    source_locale: task.source_locale,
    target_locale: task.target_locale,
    string_key: task.string_key,
    source_text: task.source_text,
    translation: task.translation || undefined,
    rewardWei,
    quotedFeeDepositWei: record.quotedFeeWei,
    actualReceiptFeeWei: fee.available && fee.feeWei != null ? fee.feeWei.toString() : undefined,
    actualReceiptFeeSource: fee.available ? fee.source : undefined,
    actualReceiptFeeNote: fee.reason,
    finalizedParentReceipt: record.receipt ? jsonSafe(record.receipt) : undefined,
    parentTxId: record.txId,
    childTxId: child?.txId,
    transactionStatus: settled.transactionStatus,
    execution: settled.execution,
    contractDecision: settled.contractDecision,
    state: task.state,
    decision: task.decision,
    payment_kind: task.payment_kind || undefined,
    payment_status: task.payment_status || undefined,
    payout_submitted: task.payout_submitted,
    payoutSubmittedNote: PAYOUT_SUBMITTED_IS_NOT_PAYMENT,
    outgoingEthSend: settled.outgoingEthSend,
    exactOutgoing: outgoing ? jsonSafe(outgoing) : undefined,
    childCredit: settled.childCredit,
    matchingChildCredit: child ? jsonSafe(child) : undefined,
    libraryCountBefore: record.libraryCountBefore,
    libraryCountAfter: record.libraryCountAfter,
    libraryEntry: record.libraryEntry ? jsonSafe(record.libraryEntry) : undefined,
    libraryEntryLinkedToTask: record.libraryEntry?.task_id === task.task_id ? true : record.libraryEntry ? false : undefined,
    feeEquation: settled.feeEquation,
    verdict: settled.paymentEvidence,
    paymentReason: settled.paymentReason,
    balanceEvidence: settled.balanceEvidence,
    translatorDeltaWei: delta(after?.namedWei, before?.namedWei),
    funderDeltaWei: delta(after?.funderWei, before?.funderWei),
    evaluatorDeltaWei: delta(record.afterBalances?.callerWei, record.beforeBalances?.callerWei),
    beforeSnapshot: before ? jsonSafe(before) : undefined,
    afterSnapshot: after ? jsonSafe(after) : undefined,
    relatedWritesNote:
      "Hashes are included only when this browser stored them for this task. Missing hashes, receipts, and snapshots are not inferred from list order or contract state.",
  };
}

export function buildV2DecisionEvidence(input: V2DecisionEvidenceInput): string {
  return jsonStringifySafe(buildV2DecisionEvidenceObject(input), 2);
}
