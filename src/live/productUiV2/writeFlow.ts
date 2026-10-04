import type { TransactionFeeEstimate } from "genlayer-js/types";
import { extractFinalizedFee } from "../fees";
import { addressesEqual, formatError, jsonSafe } from "../format";
import {
  createReadClient,
  createWriteClient,
  quoteMeetsStudioFloor,
  quoteWrite,
  readProductTask,
  readProductView,
  submitWrite,
  watchTx,
  type TxSummary,
} from "../genlayer";
import { applyTxSummaryToAction } from "../tracking";
import { rememberedGenvmUnix, rememberedLagSeconds } from "../product/clock";
import { collectTransferEvidence, enrichCancelRefundTransfer, preserveEnrichedTransfer } from "../product/transfers";
import { parseLibraryEntry, parseLibraryVersionCount } from "../productB1/library";
import { rpcGetBalance, rpcGetTransaction, rpcGetTransactionsForAddress, readEoaBalances, type EoaBalances } from "../rpc";
import { trackingFailedAfterTxId } from "../productUi/attemptHistory";
import { liveEvaluateSettlement, liveRefundEvidence } from "../productUi/settlement";
import { parseProductV2Task, type ProductV2Task } from "../productV2/task";
import { PRODUCT_UI_V2_CONTRACT, STATE_APPROVED } from "./constants";
import {
  acceptConfirmStored,
  acceptEstimateAllowed,
  cancelConfirmStored,
  cancelEstimateAllowed,
  evaluateEstimateAllowed,
  evaluateSignAllowed,
  expireConfirmStored,
  expireEstimateAllowed,
  expireSignAllowed,
  isFinalizedSuccessful,
  isTerminalFailure,
  neverResubmit,
  needsWriteResume,
  recoverConfirmStored,
  recoverEstimateAllowed,
  recoverSignAllowed,
  submitConfirmStored,
  submitEstimateAllowed,
  submitSignAllowed,
  type ProductUiV2WriteContext,
} from "./guards";
import { loadProductUiV2Session, rememberOpenedV2Task, saveProductUiV2Session } from "./persist";
import { currentV2ProductQuoteBinding, v2ProductQuoteInvalidReason, v2ProductQuoteStillValid } from "./quotes";
import {
  getV2Write,
  persistSubmittedV2Write,
  putV2Write,
  withV2WritePatch,
  type ProductUiV2WriteAction,
  type ProductUiV2WriteRecord,
  type V2WriteBalanceSnapshot,
} from "./writes";

const lastQuotedEstimates = new Map<string, TransactionFeeEstimate>();

function writeCtx(identity: { address: string; chainId: number }): ProductUiV2WriteContext {
  return { wallet: identity.address, chainId: identity.chainId, connected: true };
}

function loadOrEmpty(input: {
  chainId: number;
  taskId: string;
  action: ProductUiV2WriteAction;
  wallet: string;
}): ProductUiV2WriteRecord {
  return getV2Write({ ...input, contract: PRODUCT_UI_V2_CONTRACT });
}

export async function loadV2ProductTask(taskId: string): Promise<ProductV2Task> {
  const raw = jsonSafe(await readProductTask(createReadClient(), PRODUCT_UI_V2_CONTRACT, taskId));
  const task = parseProductV2Task(raw);
  if (!task) throw new Error(`get_task did not return a parseable V2 task for ${taskId}.`);
  saveProductUiV2Session(rememberOpenedV2Task(loadProductUiV2Session(), task.task_id));
  return task;
}

export function writeFunctionName(action: ProductUiV2WriteAction): string {
  if (action === "accept") return "accept_task";
  if (action === "cancel") return "cancel_task";
  if (action === "submit") return "submit_translation";
  if (action === "evaluate") return "evaluate_task";
  if (action === "expire") return "expire_unsubmitted_task";
  return "recover_undecided_task";
}

async function quoteNamedWrite(input: {
  action: ProductUiV2WriteAction;
  taskId: string;
  translation?: string;
  from: `0x${string}`;
}): Promise<TransactionFeeEstimate> {
  return quoteWrite({
    address: PRODUCT_UI_V2_CONTRACT,
    functionName: writeFunctionName(input.action),
    args: input.action === "submit" ? [input.taskId, input.translation ?? ""] : [input.taskId],
    value: 0n,
    from: input.from,
  });
}

async function readWriteBalances(task: ProductV2Task, caller: string): Promise<V2WriteBalanceSnapshot> {
  const eoa = await readEoaBalances({
    funder: task.funder,
    named: task.translator,
    contract: PRODUCT_UI_V2_CONTRACT,
  });
  let callerWei = eoa.funderWei;
  if (addressesEqual(caller, task.funder)) callerWei = eoa.funderWei;
  else if (addressesEqual(caller, task.translator)) callerWei = eoa.namedWei;
  else callerWei = (await rpcGetBalance(caller)).toString();
  return { ...eoa, caller, callerWei };
}

function deriveCallerSnapshot(
  eoa: EoaBalances | undefined,
  wallet: string,
  task: ProductV2Task,
): V2WriteBalanceSnapshot | undefined {
  if (!eoa) return undefined;
  if (addressesEqual(wallet, task.funder)) return { ...eoa, caller: wallet, callerWei: eoa.funderWei };
  if (addressesEqual(wallet, task.translator)) return { ...eoa, caller: wallet, callerWei: eoa.namedWei };
  return undefined;
}

function overlayFetchedReceipt(
  historical: ProductUiV2WriteRecord,
  receipt: unknown,
): Partial<ProductUiV2WriteRecord> {
  const fee = extractFinalizedFee(receipt);
  if (fee.available && fee.feeWei != null) {
    return {
      receipt,
      actualFeeWei: fee.feeWei.toString(),
      actualFeeSource: fee.source,
      actualFeeAvailable: true,
    };
  }
  return {
    receipt: historical.receipt ?? receipt,
    ...(historical.actualFeeAvailable && historical.actualFeeWei
      ? {
          actualFeeWei: historical.actualFeeWei,
          actualFeeSource: historical.actualFeeSource,
          actualFeeAvailable: true,
        }
      : {}),
  };
}

export async function estimateV2Write(input: {
  action: ProductUiV2WriteAction;
  taskId: string;
  translation?: string;
  identity: { address: `0x${string}`; chainId: number };
  nowUnix: number;
}): Promise<{ record: ProductUiV2WriteRecord; task: ProductV2Task }> {
  const task = await loadV2ProductTask(input.taskId);
  let record = loadOrEmpty({
    chainId: input.identity.chainId,
    taskId: task.task_id,
    action: input.action,
    wallet: input.identity.address,
  });
  if (neverResubmit(record) === "resume") {
    return {
      record: putV2Write(
        withV2WritePatch(record, {
          error: `Transaction ID ${record.txId} already exists. Resume tracking; not estimating a resubmit.`,
        }),
      ),
      task,
    };
  }
  const ctx = writeCtx(input.identity);
  const allowed = (() => {
    if (input.action === "accept") return acceptEstimateAllowed({ task, record, ctx, nowUnix: input.nowUnix });
    if (input.action === "cancel") return cancelEstimateAllowed({ task, record, ctx });
    if (input.action === "submit") {
      return submitEstimateAllowed({
        task,
        record,
        ctx,
        translation: input.translation ?? "",
        wallUnix: input.nowUnix,
      });
    }
    if (input.action === "evaluate") return evaluateEstimateAllowed({ task, record, ctx });
    if (input.action === "expire") return expireEstimateAllowed({ task, record, ctx, wallUnix: input.nowUnix });
    return recoverEstimateAllowed({ task, record, ctx, wallUnix: input.nowUnix });
  })();
  if (!allowed.ok) {
    return { record: putV2Write(withV2WritePatch(record, { phase: "idle", error: allowed.reason })), task };
  }
  const boundTranslation = input.action === "submit" ? (input.translation ?? "").trim() : undefined;
  record = putV2Write(
    withV2WritePatch(record, {
      phase: "quoting",
      error: undefined,
      boundTranslation,
      rememberedGenvmUnix: rememberedGenvmUnix(),
      genvmLagSeconds: rememberedLagSeconds(),
    }),
  );
  const estimate = await quoteNamedWrite({
    action: input.action,
    taskId: task.task_id,
    translation: boundTranslation,
    from: input.identity.address,
  });
  lastQuotedEstimates.set(record.key, estimate);
  const binding = currentV2ProductQuoteBinding({
    wallet: input.identity.address,
    chainId: input.identity.chainId,
    contract: PRODUCT_UI_V2_CONTRACT,
    translator: task.translator,
    method: input.action,
    valueWei: "0",
    taskId: task.task_id,
    translation: boundTranslation,
  });
  record = putV2Write(
    withV2WritePatch(record, {
      phase: "quoted",
      quotedValueWei: "0",
      quotedFeeWei: estimate.feeValue.toString(),
      quotedBinding: binding,
      quotedAt: Date.now(),
      boundTranslation,
      error: undefined,
    }),
  );
  return { record, task };
}

export async function signV2WriteBlocker(input: {
  action: ProductUiV2WriteAction;
  taskId: string;
  translation?: string;
  identity: { address: `0x${string}`; chainId: number };
  nowUnix: number;
}): Promise<
  | { ok: true; record: ProductUiV2WriteRecord; task: ProductV2Task; estimate: TransactionFeeEstimate }
  | { ok: false; record: ProductUiV2WriteRecord; task?: ProductV2Task }
> {
  const task = await loadV2ProductTask(input.taskId);
  let record = loadOrEmpty({
    chainId: input.identity.chainId,
    taskId: task.task_id,
    action: input.action,
    wallet: input.identity.address,
  });
  if (neverResubmit(record) === "resume") {
    return {
      ok: false,
      task,
      record: putV2Write(
        withV2WritePatch(record, {
          error: `Transaction ID ${record.txId} already exists. Resume tracking; do not resubmit.`,
        }),
      ),
    };
  }
  const ctx = writeCtx(input.identity);
  const allowed = (() => {
    if (input.action === "accept") return acceptEstimateAllowed({ task, record, ctx, nowUnix: input.nowUnix });
    if (input.action === "cancel") return cancelEstimateAllowed({ task, record, ctx });
    if (input.action === "submit") {
      return submitSignAllowed({
        task,
        record,
        ctx,
        translation: input.translation ?? "",
        wallUnix: input.nowUnix,
      });
    }
    if (input.action === "evaluate") return evaluateSignAllowed({ task, record, ctx });
    if (input.action === "expire") return expireSignAllowed({ task, record, ctx, wallUnix: input.nowUnix });
    return recoverSignAllowed({ task, record, ctx, wallUnix: input.nowUnix });
  })();
  if (!allowed.ok) {
    return { ok: false, task, record: putV2Write(withV2WritePatch(record, { error: allowed.reason })) };
  }
  const boundTranslation = input.action === "submit" ? (input.translation ?? "").trim() : undefined;
  const currentBinding = currentV2ProductQuoteBinding({
    wallet: input.identity.address,
    chainId: input.identity.chainId,
    contract: PRODUCT_UI_V2_CONTRACT,
    translator: task.translator,
    method: input.action,
    valueWei: "0",
    taskId: task.task_id,
    translation: boundTranslation,
  });
  if (!v2ProductQuoteStillValid(record.quotedBinding, currentBinding)) {
    return {
      ok: false,
      task,
      record: putV2Write(
        withV2WritePatch(record, {
          phase: "idle",
          quotedBinding: undefined,
          quotedFeeWei: undefined,
          error: v2ProductQuoteInvalidReason(record.quotedBinding, currentBinding),
        }),
      ),
    };
  }
  const estimate = lastQuotedEstimates.get(record.key);
  if (!estimate || estimate.feeValue.toString() !== record.quotedFeeWei) {
    return {
      ok: false,
      task,
      record: putV2Write(
        withV2WritePatch(record, {
          phase: "idle",
          quotedBinding: undefined,
          quotedFeeWei: undefined,
          error: "The in-memory fee quote was lost (reload). Estimate again before signing. The previous hash was not submitted.",
        }),
      ),
    };
  }
  const floor = quoteMeetsStudioFloor(estimate);
  if (!floor.ok) {
    lastQuotedEstimates.delete(record.key);
    return {
      ok: false,
      task,
      record: putV2Write(
        withV2WritePatch(record, {
          phase: "idle",
          quotedBinding: undefined,
          quotedFeeWei: undefined,
          error: floor.reason,
        }),
      ),
    };
  }
  return { ok: true, record, task, estimate };
}

export async function submitV2WriteTx(input: {
  record: ProductUiV2WriteRecord;
  identity: { address: `0x${string}`; chainId: number };
  provider: Parameters<typeof createWriteClient>[1];
  estimate: TransactionFeeEstimate;
  task: ProductV2Task;
}): Promise<{ txId: string; record: ProductUiV2WriteRecord }> {
  const needsBalanceSnapshot =
    input.record.action === "evaluate" || input.record.action === "cancel" || input.record.action === "expire" || input.record.action === "recover";
  const before = needsBalanceSnapshot ? await readWriteBalances(input.task, input.identity.address) : undefined;
  let libraryCountBefore: number | undefined;
  if (input.record.action === "evaluate") {
    try {
      const countRaw = await readProductView(createReadClient(), PRODUCT_UI_V2_CONTRACT, "library_version_count", [
        input.task.string_key,
        input.task.target_locale,
      ]);
      libraryCountBefore = parseLibraryVersionCount(countRaw);
    } catch {
      libraryCountBefore = undefined;
    }
  }
  putV2Write(withV2WritePatch(input.record, { phase: "signing", beforeBalances: before, error: undefined }));
  const txId = await submitWrite(createWriteClient(input.identity.address, input.provider), {
    address: PRODUCT_UI_V2_CONTRACT,
    functionName: writeFunctionName(input.record.action),
    args:
      input.record.action === "submit"
        ? [input.record.taskId, input.record.boundTranslation ?? ""]
        : [input.record.taskId],
    value: 0n,
    estimate: input.estimate,
  });
  const next = persistSubmittedV2Write(input.record, txId, {
    beforeBalances: before,
    beforeEvaluate: input.record.action === "evaluate" ? before : undefined,
    libraryCountBefore,
  });
  return { txId, record: next };
}

async function refreshLibraryForTask(task: ProductV2Task) {
  try {
    const countRaw = await readProductView(createReadClient(), PRODUCT_UI_V2_CONTRACT, "library_version_count", [
      task.string_key,
      task.target_locale,
    ]);
    const count = parseLibraryVersionCount(countRaw);
    let entry = undefined;
    if (count && count > 0) {
      const raw = jsonSafe(
        await readProductView(createReadClient(), PRODUCT_UI_V2_CONTRACT, "get_library_entry", [
          task.string_key,
          task.target_locale,
          count,
        ]),
      );
      entry = parseLibraryEntry(raw);
    }
    return { count, entry };
  } catch {
    return { count: undefined, entry: undefined };
  }
}

async function enrichSettlementTransfer(task: ProductV2Task, txId: string, receipt: unknown) {
  const recipient = task.state === STATE_APPROVED ? task.translator : task.funder;
  try {
    return await enrichCancelRefundTransfer({
      parentReceipt: receipt,
      parentTxId: txId,
      contract: PRODUCT_UI_V2_CONTRACT,
      funder: recipient,
      rewardWei: task.rewardWei,
      fetchTx: rpcGetTransaction,
      listAddressTxs: rpcGetTransactionsForAddress,
    });
  } catch {
    return collectTransferEvidence(receipt, txId, task.rewardWei);
  }
}

export async function trackV2WriteTx(
  record: ProductUiV2WriteRecord,
  txId: string,
  onUpdate: (next: ProductUiV2WriteRecord, task?: ProductV2Task) => void,
): Promise<{ record: ProductUiV2WriteRecord; task?: ProductV2Task }> {
  let current = putV2Write(withV2WritePatch(record, { phase: "waiting", txId, error: undefined }));
  onUpdate(current);
  try {
    const apply = (summary: TxSummary) => {
      current = putV2Write(withV2WritePatch(current, applyTxSummaryToAction(current, summary)));
      onUpdate(current);
      return current;
    };
    const summary = await watchTx(createReadClient(), txId, apply);
    current = apply(summary);
    let task: ProductV2Task | undefined;
    try {
      task = await loadV2ProductTask(current.taskId);
    } catch (err) {
      current = putV2Write(
        withV2WritePatch(current, {
          error: `get_task after ${current.action}: ${formatError(err)} Existing tx ID is kept. Not resubmitting.`,
        }),
      );
      onUpdate(current);
    }
    if (summary.parentSuccessful && summary.statusName === "FINALIZED" && current.action === "cancel") {
      let parentReceipt = summary.receipt;
      try {
        parentReceipt = await rpcGetTransaction(txId);
      } catch {
        parentReceipt = summary.receipt;
      }
      const fee = extractFinalizedFee(parentReceipt);
      const collected = collectTransferEvidence(parentReceipt, txId);
      const transfer = preserveEnrichedTransfer(
        current.transfer,
        task
          ? await enrichCancelRefundTransfer({
              parentReceipt,
              parentTxId: txId,
              contract: PRODUCT_UI_V2_CONTRACT,
              funder: task.funder,
              rewardWei: task.rewardWei,
              fetchTx: rpcGetTransaction,
              listAddressTxs: rpcGetTransactionsForAddress,
            })
          : collected,
      );
      let after = current.afterBalances;
      if (task) {
        after = await readWriteBalances(task, current.wallet);
      }
      current = putV2Write(
        withV2WritePatch(current, {
          receipt: parentReceipt ?? current.receipt,
          transfer,
          afterBalances: after,
          ...(fee.available
            ? { actualFeeWei: fee.feeWei?.toString(), actualFeeSource: fee.source, actualFeeAvailable: true }
            : {}),
        }),
      );
      onUpdate(current, task);
    }
    if (task && current.action === "accept" && isFinalizedSuccessful(current)) {
      const confirm = acceptConfirmStored(task);
      if (!confirm.ok) {
        current = putV2Write(withV2WritePatch(current, { error: confirm.reason }));
        onUpdate(current, task);
      }
    }
    if (task && current.action === "submit" && isFinalizedSuccessful(current)) {
      const confirm = submitConfirmStored(task, current.boundTranslation);
      current = putV2Write(
        withV2WritePatch(current, {
          error: confirm.ok ? undefined : `${confirm.reason} Existing tx ID is kept. Not resubmitting.`,
        }),
      );
      onUpdate(current, task);
    }
    if (task && current.action === "evaluate") {
      const library = await refreshLibraryForTask(task);
      const historical = {
        ...current,
        beforeEvaluate: record.beforeEvaluate ?? current.beforeEvaluate,
        beforeBalances: record.beforeBalances ?? current.beforeBalances,
        afterEvaluate: record.afterEvaluate ?? current.afterEvaluate,
        afterBalances: record.afterBalances ?? current.afterBalances,
        actualFeeWei: record.actualFeeWei ?? current.actualFeeWei,
        actualFeeSource: record.actualFeeSource ?? current.actualFeeSource,
        actualFeeAvailable: record.actualFeeAvailable || current.actualFeeAvailable,
        receipt: record.receipt ?? current.receipt,
        transfer: record.transfer ?? current.transfer,
      };
      let capturedAfter: V2WriteBalanceSnapshot | undefined;
      if (record.statusName !== "FINALIZED" && !historical.afterBalances) {
        try {
          capturedAfter = await readWriteBalances(task, current.wallet);
        } catch {
          capturedAfter = undefined;
        }
      }
      let fetchedReceipt: unknown = summary.receipt ?? historical.receipt;
      try {
        fetchedReceipt = await rpcGetTransaction(txId);
      } catch {
        fetchedReceipt = summary.receipt ?? historical.receipt;
      }
      const transfer = preserveEnrichedTransfer(
        historical.transfer,
        await enrichSettlementTransfer(task, txId, fetchedReceipt),
      );
      current = putV2Write(
        withV2WritePatch(current, {
          beforeEvaluate: historical.beforeEvaluate,
          beforeBalances: historical.beforeBalances ?? deriveCallerSnapshot(historical.beforeEvaluate, current.wallet, task),
          afterEvaluate: historical.afterEvaluate ?? capturedAfter,
          afterBalances:
            historical.afterBalances ??
            capturedAfter ??
            deriveCallerSnapshot(historical.afterEvaluate, current.wallet, task),
          transfer,
          libraryCountAfter: current.libraryCountAfter ?? library.count,
          libraryEntry: current.libraryEntry ?? library.entry,
          ...overlayFetchedReceipt(historical, fetchedReceipt),
        }),
      );
      const settled = liveEvaluateSettlement({ task, record: current as never });
      current = putV2Write(
        withV2WritePatch(current, {
          paymentEvidence: settled.paymentEvidence,
          paymentReason: settled.paymentReason,
          transferLabel: settled.transferDelivery,
          balanceLabel: settled.balanceEvidence,
          error: isTerminalFailure(current)
            ? `Evaluate ${txId} is FINALIZED without successful execution. Task state is ${task.state}. Do not assume approval. Do not resubmit this hash.`
            : current.error,
        }),
      );
      onUpdate(current, task);
    }
    if (task && current.action === "cancel" && isFinalizedSuccessful(current)) {
      const confirm = cancelConfirmStored(task);
      if (!confirm.ok) {
        current = putV2Write(withV2WritePatch(current, { error: confirm.reason }));
        onUpdate(current, task);
      }
    }
    if (task && (current.action === "cancel" || current.action === "expire" || current.action === "recover")) {
      let fetchedReceipt: unknown = summary.receipt ?? current.receipt;
      try {
        fetchedReceipt = await rpcGetTransaction(txId);
      } catch {
        fetchedReceipt = summary.receipt ?? current.receipt;
      }
      let after = record.afterBalances ?? current.afterBalances;
      if (record.statusName !== "FINALIZED" && !after) {
        try {
          after = await readWriteBalances(task, current.wallet);
        } catch {
          after = record.afterBalances ?? current.afterBalances;
        }
      }
      const transfer = preserveEnrichedTransfer(
        current.transfer,
        await enrichSettlementTransfer(task, txId, fetchedReceipt),
      );
      current = putV2Write(
        withV2WritePatch(current, {
          afterBalances: after,
          transfer,
          ...overlayFetchedReceipt(current, fetchedReceipt),
        }),
      );
      const expected = current.action === "recover" ? "recover" : current.action === "expire" ? "expire" : "cancel";
      const settled = liveRefundEvidence({ task, record: current as never, expected });
      const confirm =
        current.action === "cancel"
          ? cancelConfirmStored(task)
          : current.action === "expire"
            ? expireConfirmStored(task)
            : recoverConfirmStored(task);
      current = putV2Write(
        withV2WritePatch(current, {
          paymentEvidence: settled.paymentEvidence,
          paymentReason: settled.paymentReason,
          transferLabel: settled.transferDelivery,
          balanceLabel: settled.balanceEvidence,
          error: isTerminalFailure(current)
            ? `${current.action} ${txId} is FINALIZED without successful execution. Task state is ${task.state}. Do not infer a refund. Do not resubmit this hash.`
            : confirm.ok
              ? current.error
              : `${confirm.reason} Existing tx ID is kept. Not resubmitting.`,
        }),
      );
      onUpdate(current, task);
    }
    return { record: current, task };
  } catch (err) {
    current = putV2Write(
      withV2WritePatch(current, {
        phase: isTerminalFailure(current) ? current.phase : "waiting",
        txId,
        error: trackingFailedAfterTxId(txId, err),
      }),
    );
    onUpdate(current);
    return { record: current };
  }
}

export { needsWriteResume };

export function peekLastQuotedWriteEstimate(key: string): TransactionFeeEstimate | undefined {
  return lastQuotedEstimates.get(key);
}

export function setLastQuotedWriteEstimateForTests(key: string, estimate: TransactionFeeEstimate | undefined): void {
  if (estimate) lastQuotedEstimates.set(key, estimate);
  else lastQuotedEstimates.delete(key);
}
