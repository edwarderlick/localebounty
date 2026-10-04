import { jsonSafe, jsonStringifySafe } from "../format";
import {
  STUDIO_DEV_CHAIN_ID,
  STUDIO_DEV_EXPLORER,
  STUDIO_DEV_NAME,
  STUDIO_DEV_RPC,
} from "../network";
import { PAYOUT_SUBMITTED_IS_NOT_PAYMENT } from "../product/evidence";
import { matchingChildCredit, matchingOutgoingTo } from "../product/transfers";
import type { ProductTask } from "../product/task";
import {
  PRODUCT_UI_CONTRACT,
  PRODUCT_UI_SOURCE_SHA256,
} from "./constants";
import { loadProductUiSession } from "./persist";
import {
  evaluateFeePayerRole,
  evaluateReceiptFee,
  liveEvaluateSettlement,
} from "./settlement";
import { loadWritesStore, type ProductUiWriteRecord } from "./writes";

export type PublicDecisionEvidenceInput = {
  task: ProductTask;
  record: ProductUiWriteRecord;
  wallet?: string;
  chainId?: number;
};

function relatedCreate(taskId: string) {
  const session = loadProductUiSession();
  const id = taskId.toLowerCase();
  const matchesTask =
    session.createTask?.task_id?.toLowerCase() === id || session.expectedTaskId?.toLowerCase() === id;
  if (!matchesTask || !session.create.txId) return undefined;
  return {
    txId: session.create.txId,
    statusName: session.create.statusName,
    executionName: session.create.executionName,
    parentSuccessful: session.create.parentSuccessful,
  };
}

function relatedSubmit(taskId: string, wallet?: string) {
  const id = taskId.toLowerCase();
  const matches = Object.values(loadWritesStore().records).filter(
    (item) => item.action === "submit" && item.taskId.toLowerCase() === id && Boolean(item.txId),
  );
  if (!matches.length) return undefined;
  const preferred =
    (wallet ? matches.find((item) => item.wallet.toLowerCase() === wallet.toLowerCase()) : undefined) ??
    (matches.length === 1 ? matches[0] : undefined);
  if (preferred?.txId) {
    return {
      txId: preferred.txId,
      wallet: preferred.wallet,
      statusName: preferred.statusName,
      executionName: preferred.executionName,
      parentSuccessful: preferred.parentSuccessful,
    };
  }
  return {
    txIds: matches.map((item) => item.txId as string),
    wallets: matches.map((item) => item.wallet),
  };
}

export function buildPublicDecisionEvidenceObject(input: PublicDecisionEvidenceInput): Record<string, unknown> {
  const { task, record } = input;
  const settled = liveEvaluateSettlement({ task, record });
  const evaluator = record.beforeBalances?.caller || record.wallet;
  const role = evaluateFeePayerRole(task, evaluator);
  const fee = evaluateReceiptFee(record);
  const before = record.beforeBalances ?? record.beforeEvaluate;
  const after = record.afterBalances ?? record.afterEvaluate;
  let namedDelta: string | undefined;
  let funderDelta: string | undefined;
  if (before && after) {
    try {
      namedDelta = (BigInt(after.namedWei) - BigInt(before.namedWei)).toString();
      funderDelta = (BigInt(after.funderWei) - BigInt(before.funderWei)).toString();
    } catch {
      namedDelta = undefined;
      funderDelta = undefined;
    }
  }

  let rewardWei: string | undefined;
  try {
    rewardWei = BigInt(task.rewardWei).toString();
  } catch {
    rewardWei = undefined;
  }

  const outgoing = rewardWei ? matchingOutgoingTo(record.transfer ?? { outgoing: [], children: [], parseOk: false, parseNote: "" }, task.state === "approved" ? task.translator : task.funder, rewardWei) : undefined;
  const child = rewardWei
    ? matchingChildCredit(
        record.transfer ?? { outgoing: [], children: [], parseOk: false, parseNote: "" },
        task.state === "approved" ? task.translator : task.funder,
        rewardWei,
        record.txId,
      )
    : undefined;

  const create = relatedCreate(task.task_id);
  const submit = relatedSubmit(task.task_id, input.wallet ?? record.wallet);

  const payload: Record<string, unknown> = {
    kind: "localebounty.product-ui.decision-evidence.v1",
    live_result: settled.paymentEvidence,
    network: {
      name: STUDIO_DEV_NAME,
      chainIdExpected: STUDIO_DEV_CHAIN_ID,
      chainIdWallet: input.chainId ?? record.chainId ?? null,
      rpc: STUDIO_DEV_RPC,
      explorer: STUDIO_DEV_EXPLORER,
    },
    contract: PRODUCT_UI_CONTRACT,
    sourceSha256Pin: PRODUCT_UI_SOURCE_SHA256,
    taskId: task.task_id,
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
    childCredit: settled.childCredit,
    outgoingRecipient: outgoing?.recipient,
    outgoingValueWei: outgoing?.valueWei,
    feeEquation: settled.feeEquation,
    verdict: settled.paymentEvidence,
    paymentReason: settled.paymentReason,
    balanceEvidence: settled.balanceEvidence,
    namedDeltaWei: namedDelta,
    funderDeltaWei: funderDelta,
    beforeSnapshot: before ? jsonSafe(before) : undefined,
    afterSnapshot: after ? jsonSafe(after) : undefined,
    relatedWritesNote:
      "createTx and submitTx are included only when this browser stored those hashes for this task. Missing keys were not invented.",
  };

  if (create) payload.createTx = create;
  if (submit) payload.submitTx = submit;

  return payload;
}

export function buildPublicDecisionEvidence(input: PublicDecisionEvidenceInput): string {
  return jsonStringifySafe(buildPublicDecisionEvidenceObject(input), 2);
}
