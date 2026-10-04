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
import { parseProductTask, type ProductTask } from "../product/task";
import {
  collectTransferEvidence,
  enrichCancelRefundTransfer,
  preserveEnrichedTransfer,
} from "../product/transfers";
import { parseLibraryEntry, parseLibraryVersionCount } from "../productB1/library";
import { rpcGetBalance, rpcGetTransaction, rpcGetTransactionsForAddress, readEoaBalances, type EoaBalances } from "../rpc";
import { STUDIO_DEV_CHAIN_ID } from "../network";
import { PRODUCT_UI_CONTRACT, STATE_APPROVED } from "./constants";
import { liveEvaluateSettlement, liveRefundEvidence } from "./settlement";
import { loadLiveProductTask } from "./taskLoad";
import {
  cancelConfirmStored,
  cancelEstimateAllowed,
  cancelSignAllowed,
  evaluateEstimateAllowed,
  evaluateSignAllowed,
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
  type ProductUiWriteContext,
} from "./writeGuards";
import { currentWriteQuoteBinding, writeQuoteInvalidReason, writeQuoteStillValid } from "./writeQuotes";
import { trackingFailedAfterTxId } from "./attemptHistory";
import {
  emptyWriteRecord,
  getWrite,
  persistSubmittedWrite,
  putWrite,
  withWritePatch,
  type ProductUiWriteAction,
  type ProductUiWriteRecord,
  type WriteBalanceSnapshot,
} from "./writes";

const lastQuotedEstimates = new Map<string, TransactionFeeEstimate>();

export function cachedWriteEstimate(key: string): TransactionFeeEstimate | undefined {
  return lastQuotedEstimates.get(key);
}

function writeCtx(identity: { address: string; chainId: number }): ProductUiWriteContext {
  return { wallet: identity.address, chainId: identity.chainId, connected: true };
}

function loadOrEmpty(input: {
  chainId: number;
  taskId: string;
  action: ProductUiWriteAction;
  wallet: string;
}): ProductUiWriteRecord {
  return getWrite({ ...input, contract: PRODUCT_UI_CONTRACT });
}

async function refreshTask(taskId: string): Promise<ProductTask> {
  const raw = jsonSafe(await readProductTask(createReadClient(), PRODUCT_UI_CONTRACT, taskId));
  const task = parseProductTask(raw);
  if (!task) throw new Error(`get_task did not return a parseable task for ${taskId}.`);
  return task;
}

export function writeFunctionName(action: ProductUiWriteAction): string {
  if (action === "submit") return "submit_translation";
  if (action === "evaluate") return "evaluate_task";
  if (action === "cancel") return "cancel_task";
  return "recover_undecided_task";
}

async function quoteNamedWrite(input: {
  action: ProductUiWriteAction;
  taskId: string;
  translation?: string;
  from: `0x${string}`;
}): Promise<TransactionFeeEstimate> {
  return quoteWrite({
    address: PRODUCT_UI_CONTRACT,
    functionName: writeFunctionName(input.action),
    args: input.action === "submit" ? [input.taskId, input.translation ?? ""] : [input.taskId],
    value: 0n,
    from: input.from,
  });
}

async function readWriteBalances(task: ProductTask, caller: string): Promise<WriteBalanceSnapshot> {
  const eoa = await readEoaBalances({
    funder: task.funder,
    named: task.translator,
    contract: PRODUCT_UI_CONTRACT,
  });
  let callerWei = eoa.funderWei;
  if (addressesEqual(caller, task.funder)) callerWei = eoa.funderWei;
  else if (addressesEqual(caller, task.translator)) callerWei = eoa.namedWei;
  else callerWei = (await rpcGetBalance(caller)).toString();
  return { ...eoa, caller, callerWei };
}

/** Reconstruct evaluator callerWei from funder/named only. Third-party snapshots cannot be inferred. */
export function deriveCallerSnapshot(
  eoa: EoaBalances | undefined,
  wallet: string,
  task: ProductTask,
): WriteBalanceSnapshot | undefined {
  if (!eoa) return undefined;
  if (addressesEqual(wallet, task.funder)) return { ...eoa, caller: wallet, callerWei: eoa.funderWei };
  if (addressesEqual(wallet, task.translator)) return { ...eoa, caller: wallet, callerWei: eoa.namedWei };
  return undefined;
}

export function shouldCaptureEvaluateAfter(historical: ProductUiWriteRecord): boolean {
  return historical.statusName !== "FINALIZED" && !historical.afterEvaluate && !historical.afterBalances;
}

/** Historical before snapshots are never replaced with a live eth_getBalance. */
export function keepEvaluateSnapshots(
  historical: ProductUiWriteRecord,
  task: ProductTask,
  capturedAfter?: WriteBalanceSnapshot,
): Pick<ProductUiWriteRecord, "beforeEvaluate" | "afterEvaluate" | "beforeBalances" | "afterBalances"> {
  const beforeEvaluate = historical.beforeEvaluate;
  const beforeBalances = historical.beforeBalances ?? deriveCallerSnapshot(beforeEvaluate, historical.wallet, task);
  const afterEvaluate = historical.afterEvaluate ?? capturedAfter;
  const afterBalances =
    historical.afterBalances ?? capturedAfter ?? deriveCallerSnapshot(afterEvaluate, historical.wallet, task);
  return { beforeEvaluate, afterEvaluate, beforeBalances, afterBalances };
}

function overlayFetchedReceipt(
  historical: ProductUiWriteRecord,
  receipt: unknown,
): Partial<ProductUiWriteRecord> {
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

export async function estimateSubmit(input: {
  taskId: string;
  translation: string;
  identity: { address: `0x${string}`; chainId: number };
}): Promise<{ record: ProductUiWriteRecord; task: ProductTask }> {
  const task = await loadLiveProductTask(input.taskId);
  let record = loadOrEmpty({
    chainId: input.identity.chainId,
    taskId: task.task_id,
    action: "submit",
    wallet: input.identity.address,
  });
  if (neverResubmit(record) === "resume") {
    return {
      record: putWrite(
        withWritePatch(record, {
          error: `Transaction ID ${record.txId} already exists. Resume tracking; not estimating a resubmit.`,
        }),
      ),
      task,
    };
  }
  const allowed = submitEstimateAllowed({
    task,
    record,
    ctx: writeCtx(input.identity),
    translation: input.translation,
  });
  if (!allowed.ok) {
    return { record: putWrite(withWritePatch(record, { phase: "idle", error: allowed.reason })), task };
  }
  const boundTranslation = input.translation.trim();
  const genvm = rememberedGenvmUnix();
  record = putWrite(
    withWritePatch(record, {
      phase: "quoting",
      error: undefined,
      boundTranslation,
      rememberedGenvmUnix: genvm,
      genvmLagSeconds: rememberedLagSeconds(),
    }),
  );
  const estimate = await quoteNamedWrite({
    action: "submit",
    taskId: task.task_id,
    translation: boundTranslation,
    from: input.identity.address,
  });
  lastQuotedEstimates.set(record.key, estimate);
  const binding = currentWriteQuoteBinding({
    wallet: input.identity.address,
    chainId: input.identity.chainId,
    contract: PRODUCT_UI_CONTRACT,
    method: "submit",
    valueWei: "0",
    taskId: task.task_id,
    translation: boundTranslation,
  });
  record = putWrite(
    withWritePatch(record, {
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

export async function signSubmitBlocker(input: {
  taskId: string;
  translation: string;
  identity: { address: `0x${string}`; chainId: number };
}): Promise<
  | { ok: true; record: ProductUiWriteRecord; task: ProductTask; estimate: TransactionFeeEstimate }
  | { ok: false; record: ProductUiWriteRecord; task?: ProductTask }
> {
  const task = await refreshTask(input.taskId);
  let record = loadOrEmpty({
    chainId: input.identity.chainId,
    taskId: task.task_id,
    action: "submit",
    wallet: input.identity.address,
  });
  if (neverResubmit(record) === "resume") {
    return {
      ok: false,
      task,
      record: putWrite(
        withWritePatch(record, {
          error: `Transaction ID ${record.txId} already exists. Resume tracking; do not resubmit.`,
        }),
      ),
    };
  }
  const allowed = submitSignAllowed({
    task,
    record,
    ctx: writeCtx(input.identity),
    translation: input.translation,
  });
  if (!allowed.ok) return { ok: false, task, record: putWrite(withWritePatch(record, { error: allowed.reason })) };
  const binding = currentWriteQuoteBinding({
    wallet: input.identity.address,
    chainId: input.identity.chainId,
    contract: PRODUCT_UI_CONTRACT,
    method: "submit",
    valueWei: "0",
    taskId: task.task_id,
    translation: input.translation.trim(),
  });
  if (!writeQuoteStillValid(record.quotedBinding, binding)) {
    lastQuotedEstimates.delete(record.key);
    return {
      ok: false,
      task,
      record: putWrite(
        withWritePatch(record, {
          phase: "idle",
          quotedBinding: undefined,
          quotedFeeWei: undefined,
          error: writeQuoteInvalidReason(record.quotedBinding, binding),
        }),
      ),
    };
  }
  const cached = lastQuotedEstimates.get(record.key);
  if (!cached || cached.feeValue.toString() !== record.quotedFeeWei) {
    return {
      ok: false,
      task,
      record: putWrite(
        withWritePatch(record, {
          phase: "idle",
          quotedBinding: undefined,
          quotedFeeWei: undefined,
          error: "The in-memory fee quote was lost (reload). Estimate again before signing. The previous hash was not submitted.",
        }),
      ),
    };
  }
  const floor = quoteMeetsStudioFloor(cached);
  if (!floor.ok) {
    lastQuotedEstimates.delete(record.key);
    return {
      ok: false,
      task,
      record: putWrite(
        withWritePatch(record, {
          phase: "idle",
          quotedBinding: undefined,
          quotedFeeWei: undefined,
          error: floor.reason,
        }),
      ),
    };
  }
  return { ok: true, record, task, estimate: cached };
}

export async function submitSubmitTx(input: {
  record: ProductUiWriteRecord;
  task: ProductTask;
  identity: { address: `0x${string}`; chainId: number };
  provider: Parameters<typeof createWriteClient>[1];
  estimate: TransactionFeeEstimate;
}): Promise<{ txId: string; record: ProductUiWriteRecord }> {
  const translation = input.record.boundTranslation ?? "";
  const txId = await submitWrite(createWriteClient(input.identity.address, input.provider), {
    address: PRODUCT_UI_CONTRACT,
    functionName: "submit_translation",
    args: [input.task.task_id, translation],
    value: 0n,
    estimate: input.estimate,
  });
  const record = persistSubmittedWrite(input.record, txId, { quotedValueWei: "0" });
  return { txId, record };
}

export async function estimateEvaluate(input: {
  taskId: string;
  identity: { address: `0x${string}`; chainId: number };
}): Promise<{ record: ProductUiWriteRecord; task: ProductTask }> {
  const task = await loadLiveProductTask(input.taskId);
  let record = loadOrEmpty({
    chainId: input.identity.chainId,
    taskId: task.task_id,
    action: "evaluate",
    wallet: input.identity.address,
  });
  if (neverResubmit(record) === "resume" && !isTerminalFailure(record)) {
    return {
      record: putWrite(
        withWritePatch(record, {
          error: `Transaction ID ${record.txId} already exists. Resume tracking; not estimating a resubmit.`,
        }),
      ),
      task,
    };
  }
  const allowed = evaluateEstimateAllowed({ task, record, ctx: writeCtx(input.identity) });
  if (!allowed.ok) {
    return { record: putWrite(withWritePatch(record, { phase: "idle", error: allowed.reason })), task };
  }
  record = putWrite(withWritePatch(record, { phase: "quoting", error: undefined }));
  const estimate = await quoteNamedWrite({
    action: "evaluate",
    taskId: task.task_id,
    from: input.identity.address,
  });
  lastQuotedEstimates.set(record.key, estimate);
  const binding = currentWriteQuoteBinding({
    wallet: input.identity.address,
    chainId: input.identity.chainId,
    contract: PRODUCT_UI_CONTRACT,
    method: "evaluate",
    valueWei: "0",
    taskId: task.task_id,
  });
  record = putWrite(
    withWritePatch(record, {
      phase: "quoted",
      quotedValueWei: "0",
      quotedFeeWei: estimate.feeValue.toString(),
      quotedBinding: binding,
      quotedAt: Date.now(),
      error: undefined,
    }),
  );
  return { record, task };
}

export async function signEvaluateBlocker(input: {
  taskId: string;
  identity: { address: `0x${string}`; chainId: number };
}): Promise<
  | { ok: true; record: ProductUiWriteRecord; task: ProductTask; estimate: TransactionFeeEstimate }
  | { ok: false; record: ProductUiWriteRecord; task?: ProductTask }
> {
  const task = await refreshTask(input.taskId);
  let record = loadOrEmpty({
    chainId: input.identity.chainId,
    taskId: task.task_id,
    action: "evaluate",
    wallet: input.identity.address,
  });
  if (neverResubmit(record) === "resume" && !isTerminalFailure(record)) {
    return {
      ok: false,
      task,
      record: putWrite(
        withWritePatch(record, {
          error: `Transaction ID ${record.txId} already exists. Resume tracking; do not resubmit.`,
        }),
      ),
    };
  }
  const allowed = evaluateSignAllowed({ task, record, ctx: writeCtx(input.identity) });
  if (!allowed.ok) return { ok: false, task, record: putWrite(withWritePatch(record, { error: allowed.reason })) };
  const binding = currentWriteQuoteBinding({
    wallet: input.identity.address,
    chainId: input.identity.chainId,
    contract: PRODUCT_UI_CONTRACT,
    method: "evaluate",
    valueWei: "0",
    taskId: task.task_id,
  });
  if (!writeQuoteStillValid(record.quotedBinding, binding)) {
    lastQuotedEstimates.delete(record.key);
    return {
      ok: false,
      task,
      record: putWrite(
        withWritePatch(record, {
          phase: "idle",
          quotedBinding: undefined,
          quotedFeeWei: undefined,
          error: writeQuoteInvalidReason(record.quotedBinding, binding),
        }),
      ),
    };
  }
  const cached = lastQuotedEstimates.get(record.key);
  if (!cached || cached.feeValue.toString() !== record.quotedFeeWei) {
    return {
      ok: false,
      task,
      record: putWrite(
        withWritePatch(record, {
          phase: "idle",
          quotedBinding: undefined,
          quotedFeeWei: undefined,
          error: "The in-memory fee quote was lost (reload). Estimate again before signing. The previous hash was not submitted.",
        }),
      ),
    };
  }
  const floor = quoteMeetsStudioFloor(cached);
  if (!floor.ok) {
    lastQuotedEstimates.delete(record.key);
    return {
      ok: false,
      task,
      record: putWrite(
        withWritePatch(record, {
          phase: "idle",
          quotedBinding: undefined,
          quotedFeeWei: undefined,
          error: floor.reason,
        }),
      ),
    };
  }
  return { ok: true, record, task, estimate: cached };
}

export async function submitEvaluateTx(input: {
  record: ProductUiWriteRecord;
  task: ProductTask;
  identity: { address: `0x${string}`; chainId: number };
  provider: Parameters<typeof createWriteClient>[1];
  estimate: TransactionFeeEstimate;
}): Promise<{ txId: string; record: ProductUiWriteRecord }> {
  const before = await readWriteBalances(input.task, input.identity.address);
  let libraryCountBefore: number | undefined;
  try {
    const countRaw = await readProductView(createReadClient(), PRODUCT_UI_CONTRACT, "library_version_count", [
      input.task.string_key,
      input.task.target_locale,
    ]);
    libraryCountBefore = parseLibraryVersionCount(countRaw);
  } catch {
    libraryCountBefore = undefined;
  }
  const txId = await submitWrite(createWriteClient(input.identity.address, input.provider), {
    address: PRODUCT_UI_CONTRACT,
    functionName: "evaluate_task",
    args: [input.task.task_id],
    value: 0n,
    estimate: input.estimate,
  });
  const record = persistSubmittedWrite(input.record, txId, {
    quotedValueWei: "0",
    beforeEvaluate: before,
    beforeBalances: before,
    libraryCountBefore,
  });
  return { txId, record };
}

async function estimateZeroValueWrite(input: {
  action: "evaluate" | "cancel" | "recover";
  taskId: string;
  identity: { address: `0x${string}`; chainId: number };
  allowed: (task: ProductTask, record: ProductUiWriteRecord) => ReturnType<typeof cancelEstimateAllowed>;
}): Promise<{ record: ProductUiWriteRecord; task: ProductTask }> {
  const task = await loadLiveProductTask(input.taskId);
  let record = loadOrEmpty({
    chainId: input.identity.chainId,
    taskId: task.task_id,
    action: input.action,
    wallet: input.identity.address,
  });
  if (neverResubmit(record) === "resume" && !isTerminalFailure(record)) {
    return {
      record: putWrite(
        withWritePatch(record, {
          error: `Transaction ID ${record.txId} already exists. Resume tracking; not estimating a resubmit.`,
        }),
      ),
      task,
    };
  }
  const allowed = input.allowed(task, record);
  if (!allowed.ok) {
    return { record: putWrite(withWritePatch(record, { phase: "idle", error: allowed.reason })), task };
  }
  record = putWrite(
    withWritePatch(record, {
      phase: "quoting",
      error: undefined,
      rememberedGenvmUnix: rememberedGenvmUnix(),
      genvmLagSeconds: rememberedLagSeconds(),
    }),
  );
  const estimate = await quoteNamedWrite({
    action: input.action,
    taskId: task.task_id,
    from: input.identity.address,
  });
  lastQuotedEstimates.set(record.key, estimate);
  const binding = currentWriteQuoteBinding({
    wallet: input.identity.address,
    chainId: input.identity.chainId,
    contract: PRODUCT_UI_CONTRACT,
    method: input.action,
    valueWei: "0",
    taskId: task.task_id,
  });
  record = putWrite(
    withWritePatch(record, {
      phase: "quoted",
      quotedValueWei: "0",
      quotedFeeWei: estimate.feeValue.toString(),
      quotedBinding: binding,
      quotedAt: Date.now(),
      error: undefined,
    }),
  );
  return { record, task };
}

async function signZeroValueBlocker(input: {
  action: "evaluate" | "cancel" | "recover";
  taskId: string;
  identity: { address: `0x${string}`; chainId: number };
  allowed: (task: ProductTask, record: ProductUiWriteRecord) => ReturnType<typeof cancelEstimateAllowed>;
}): Promise<
  | { ok: true; record: ProductUiWriteRecord; task: ProductTask; estimate: TransactionFeeEstimate }
  | { ok: false; record: ProductUiWriteRecord; task?: ProductTask }
> {
  const task = await refreshTask(input.taskId);
  let record = loadOrEmpty({
    chainId: input.identity.chainId,
    taskId: task.task_id,
    action: input.action,
    wallet: input.identity.address,
  });
  if (neverResubmit(record) === "resume" && !isTerminalFailure(record)) {
    return {
      ok: false,
      task,
      record: putWrite(
        withWritePatch(record, {
          error: `Transaction ID ${record.txId} already exists. Resume tracking; do not resubmit.`,
        }),
      ),
    };
  }
  const allowed = input.allowed(task, record);
  if (!allowed.ok) return { ok: false, task, record: putWrite(withWritePatch(record, { error: allowed.reason })) };
  const binding = currentWriteQuoteBinding({
    wallet: input.identity.address,
    chainId: input.identity.chainId,
    contract: PRODUCT_UI_CONTRACT,
    method: input.action,
    valueWei: "0",
    taskId: task.task_id,
  });
  if (!writeQuoteStillValid(record.quotedBinding, binding)) {
    lastQuotedEstimates.delete(record.key);
    return {
      ok: false,
      task,
      record: putWrite(
        withWritePatch(record, {
          phase: "idle",
          quotedBinding: undefined,
          quotedFeeWei: undefined,
          error: writeQuoteInvalidReason(record.quotedBinding, binding),
        }),
      ),
    };
  }
  const cached = lastQuotedEstimates.get(record.key);
  if (!cached || cached.feeValue.toString() !== record.quotedFeeWei) {
    return {
      ok: false,
      task,
      record: putWrite(
        withWritePatch(record, {
          phase: "idle",
          quotedBinding: undefined,
          quotedFeeWei: undefined,
          error: "The in-memory fee quote was lost (reload). Estimate again before signing. The previous hash was not submitted.",
        }),
      ),
    };
  }
  const floor = quoteMeetsStudioFloor(cached);
  if (!floor.ok) {
    lastQuotedEstimates.delete(record.key);
    return {
      ok: false,
      task,
      record: putWrite(
        withWritePatch(record, {
          phase: "idle",
          quotedBinding: undefined,
          quotedFeeWei: undefined,
          error: floor.reason,
        }),
      ),
    };
  }
  return { ok: true, record, task, estimate: cached };
}

export async function estimateCancel(input: {
  taskId: string;
  identity: { address: `0x${string}`; chainId: number };
}): Promise<{ record: ProductUiWriteRecord; task: ProductTask }> {
  return estimateZeroValueWrite({
    action: "cancel",
    taskId: input.taskId,
    identity: input.identity,
    allowed: (task, record) => cancelEstimateAllowed({ task, record, ctx: writeCtx(input.identity) }),
  });
}

export async function signCancelBlocker(input: {
  taskId: string;
  identity: { address: `0x${string}`; chainId: number };
}) {
  return signZeroValueBlocker({
    action: "cancel",
    taskId: input.taskId,
    identity: input.identity,
    allowed: (task, record) => cancelSignAllowed({ task, record, ctx: writeCtx(input.identity) }),
  });
}

export async function estimateRecover(input: {
  taskId: string;
  identity: { address: `0x${string}`; chainId: number };
}): Promise<{ record: ProductUiWriteRecord; task: ProductTask }> {
  return estimateZeroValueWrite({
    action: "recover",
    taskId: input.taskId,
    identity: input.identity,
    allowed: (task, record) => recoverEstimateAllowed({ task, record, ctx: writeCtx(input.identity) }),
  });
}

export async function signRecoverBlocker(input: {
  taskId: string;
  identity: { address: `0x${string}`; chainId: number };
}) {
  return signZeroValueBlocker({
    action: "recover",
    taskId: input.taskId,
    identity: input.identity,
    allowed: (task, record) => recoverSignAllowed({ task, record, ctx: writeCtx(input.identity) }),
  });
}

export async function submitSettlementTx(input: {
  action: "cancel" | "recover";
  record: ProductUiWriteRecord;
  task: ProductTask;
  identity: { address: `0x${string}`; chainId: number };
  provider: Parameters<typeof createWriteClient>[1];
  estimate: TransactionFeeEstimate;
}): Promise<{ txId: string; record: ProductUiWriteRecord }> {
  const before = await readWriteBalances(input.task, input.identity.address);
  const txId = await submitWrite(createWriteClient(input.identity.address, input.provider), {
    address: PRODUCT_UI_CONTRACT,
    functionName: writeFunctionName(input.action),
    args: [input.task.task_id],
    value: 0n,
    estimate: input.estimate,
  });
  const record = persistSubmittedWrite(input.record, txId, {
    quotedValueWei: "0",
    beforeBalances: before,
  });
  return { txId, record };
}

async function refreshLibraryForTask(task: ProductTask) {
  try {
    const countRaw = await readProductView(createReadClient(), PRODUCT_UI_CONTRACT, "library_version_count", [
      task.string_key,
      task.target_locale,
    ]);
    const count = parseLibraryVersionCount(countRaw);
    let entry = undefined;
    if (count && count > 0) {
      const raw = jsonSafe(
        await readProductView(createReadClient(), PRODUCT_UI_CONTRACT, "get_library_entry", [
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

async function enrichEvaluateTransfer(task: ProductTask, txId: string, receipt: unknown) {
  const recipient = task.state === STATE_APPROVED ? task.translator : task.funder;
  try {
    return await enrichCancelRefundTransfer({
      parentReceipt: receipt,
      parentTxId: txId,
      contract: PRODUCT_UI_CONTRACT,
      funder: recipient,
      rewardWei: task.rewardWei,
      fetchTx: rpcGetTransaction,
      listAddressTxs: rpcGetTransactionsForAddress,
    });
  } catch {
    return collectTransferEvidence(receipt, txId, task.rewardWei);
  }
}

function latestWrite(record: ProductUiWriteRecord): ProductUiWriteRecord {
  return getWrite({
    chainId: record.chainId,
    contract: record.contract,
    taskId: record.taskId,
    action: record.action,
    wallet: record.wallet,
  });
}

export function retainWriteAfterTrackingFailure(
  record: ProductUiWriteRecord,
  txId: string,
  err: unknown,
  onUpdate: (next: ProductUiWriteRecord, task?: ProductTask) => void,
): ProductUiWriteRecord {
  const live = latestWrite(record);
  const next = putWrite(
    withWritePatch(live.txId ? live : { ...live, ...record, txId }, {
      txId,
      phase: live.statusName === "FINALIZED" ? live.phase : "waiting",
      error: trackingFailedAfterTxId(txId, err),
    }),
  );
  onUpdate(next);
  return next;
}

export async function trackWriteTx(
  record: ProductUiWriteRecord,
  txId: string,
  onUpdate: (next: ProductUiWriteRecord, task?: ProductTask) => void,
): Promise<{ record: ProductUiWriteRecord; task?: ProductTask }> {
  let current = putWrite(withWritePatch(record, { phase: "waiting", txId, error: undefined }));
  onUpdate(current);
  try {
  const apply = (summary: TxSummary) => {
    current = putWrite({ ...current, ...applyTxSummaryToAction(current, summary) });
    onUpdate(current);
    return current;
  };
  const summary = await watchTx(createReadClient(), txId, apply);
  current = apply(summary);
  let task: ProductTask | undefined;
  try {
    task = await refreshTask(current.taskId);
  } catch (err) {
    current = putWrite(
      withWritePatch(current, {
        error: `get_task after ${current.action}: ${formatError(err)} Existing tx ID is kept. Not resubmitting. Resume tracking.`,
      }),
    );
    onUpdate(current, task);
    return { record: current, task };
  }

  if (current.action === "submit" && isFinalizedSuccessful(current)) {
    const match = submitConfirmStored(task, current.boundTranslation);
    current = putWrite(
      withWritePatch(current, {
        error: match.ok ? undefined : `${match.reason} Existing tx ID is kept. Not resubmitting.`,
      }),
    );
    onUpdate(current, task);
    return { record: current, task };
  }

  if (current.action === "evaluate") {
    const library = await refreshLibraryForTask(task);
    const historical: ProductUiWriteRecord = {
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
    let capturedAfter: WriteBalanceSnapshot | undefined;
    if (shouldCaptureEvaluateAfter(record)) {
      try {
        capturedAfter = await readWriteBalances(task, current.wallet);
      } catch {
        capturedAfter = undefined;
      }
    }
    const snaps = keepEvaluateSnapshots(historical, task, capturedAfter);
    let fetchedReceipt: unknown = summary.receipt ?? historical.receipt;
    try {
      fetchedReceipt = await rpcGetTransaction(txId);
    } catch {
      fetchedReceipt = summary.receipt ?? historical.receipt;
    }
    const transfer = preserveEnrichedTransfer(
      historical.transfer,
      await enrichEvaluateTransfer(task, txId, fetchedReceipt),
    );
    current = putWrite(
      withWritePatch(current, {
        ...snaps,
        transfer,
        libraryCountAfter: current.libraryCountAfter ?? library.count,
        libraryEntry: current.libraryEntry ?? library.entry,
        ...overlayFetchedReceipt(historical, fetchedReceipt),
      }),
    );
    const settled = liveEvaluateSettlement({ task, record: current });
    current = putWrite(
      withWritePatch(current, {
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
    return { record: current, task };
  }

  if (current.action === "cancel" || current.action === "recover") {
    const settlementAction = current.action;
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
      await enrichEvaluateTransfer(task, txId, summary.receipt),
    );
    const fee = extractFinalizedFee(summary.receipt);
    current = putWrite(
      withWritePatch(current, {
        afterBalances: after,
        transfer,
        ...(fee.available
          ? { actualFeeWei: fee.feeWei?.toString(), actualFeeSource: fee.source, actualFeeAvailable: true }
          : {}),
      }),
    );
    const settled = liveRefundEvidence({
      task,
      record: current,
      expected: settlementAction,
    });
    const confirm = settlementAction === "cancel" ? cancelConfirmStored(task) : recoverConfirmStored(task);
    current = putWrite(
      withWritePatch(current, {
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
    return { record: current, task };
  }

  onUpdate(current, task);
  return { record: current, task };
  } catch (err) {
    return { record: retainWriteAfterTrackingFailure(current, txId, err, onUpdate) };
  }
}

export function writeIdentityOrEmpty(input: {
  wallet?: string;
  chainId?: number;
  taskId: string;
  action: ProductUiWriteAction;
}): ProductUiWriteRecord {
  if (!input.wallet || input.chainId == null) {
    return emptyWriteRecord({
      chainId: input.chainId ?? STUDIO_DEV_CHAIN_ID,
      taskId: input.taskId,
      action: input.action,
      wallet: input.wallet ?? "0x0000000000000000000000000000000000000000",
    });
  }
  return loadOrEmpty({
    chainId: input.chainId,
    taskId: input.taskId,
    action: input.action,
    wallet: input.wallet,
  });
}

export { needsWriteResume };
