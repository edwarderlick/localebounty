import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TransactionFeeEstimate } from "genlayer-js/types";
import { CopyButton } from "../components/CopyButton";
import { useWallet } from "../live/WalletContext";
import { WalletCard } from "../live/WalletCard";
import { isUserRejection } from "../live/eip1193";
import { extractFinalizedFee, type FinalizedFee } from "../live/fees";
import { explorerAddress, explorerTx, feeDepositFigures, formatError, formatGen, isEoaAddress, jsonSafe } from "../live/format";
import {
  PRODUCT_SOURCE,
  createReadClient,
  createWriteClient,
  describeDeployBlocker,
  quoteDeploy,
  quoteMeetsStudioFloor,
  quoteWrite,
  readProductTask,
  submitProductDeploy,
  submitWrite,
  watchTx,
  type TxSummary,
} from "../live/genlayer";
import {
  EXTERNAL_POLL_MS,
  EXTERNAL_WAIT_MS,
  STUDIO_DEV_CHAIN_ID,
  STUDIO_DEV_EXPLORER,
  STUDIO_DEV_FAUCET,
  STUDIO_DEV_RPC,
  STUDIO_DEV_STUDIO,
} from "../live/network";
import {
  readEoaBalances,
  rpcGetContractCode,
  rpcGetTransaction,
  rpcGetTransactionsForAddress,
  type EoaBalances,
} from "../live/rpc";
import { applyTxSummaryToAction, consensusLayer } from "../live/tracking";
import {
  HISTORICAL_PROBE_PAYOUT_FEE_NOTE,
  TEST_APP_CONTEXT,
  TEST_INTENDED_MEANING,
  TEST_SEMANTIC_CRITERIA,
  TEST_SOURCE_LOCALE,
  TEST_SOURCE_TEXT,
  TEST_STRING_KEY,
  TEST_TARGET_LOCALE,
  type ProductActionName,
} from "../live/product/constants";
import {
  PAYOUT_SUBMITTED_IS_NOT_PAYMENT,
  buildProductEvidencePayload,
  evaluateCancelRefund,
  overallProductVerdict,
} from "../live/product/evidence";
import {
  cachedGenvmUnix,
  clearRememberedGenvmLag,
  createDeadlinesFromGenvm,
  createSignNowUnix,
  discoverGenvmUnix,
  genvmNowForSession,
  rememberGenvmLag,
} from "../live/product/clock";
import { deadlineStatusFromError, makeCreateDeadlineProbe } from "../live/product/createClock";
import { errorAfterSuccessfulRefresh } from "../live/product/staleErrors";
import {
  bindCreateEstimateIdentity,
  cancelWriteAllowed,
  createEstimateAllowed,
  createSignAllowed,
  deadlinesStale,
  deployWriteAllowed,
  hasTxId,
  isFinalizedSuccessful,
  isTerminalFailure,
  needsProductTxResume,
  neverResubmit,
  productActionEstimateAllowed,
  productActionSignAllowed,
  productClearRisk,
  productSessionCompatible,
  retryFailedProductAction,
  type ProductWriteContext,
} from "../live/product/guards";
import {
  bindProductSession,
  clearProductSession,
  invalidateProductUnsignedQuotes,
  loadProductSession,
  resetProductTransientPhases,
  saveProductSession,
  withProductAction,
  type ProductActionRecord,
  type ProductSession,
} from "../live/product/persist";
import { currentProductQuoteBinding, productQuoteInvalidReason, productQuoteStillValid } from "../live/product/quotes";
import { applySourceComparison, compareLocalToDeployed, invalidateStaleSourceMatch, unverifiedSource } from "../live/product/source";
import { createTaskArgs, genRewardError, parseProductTask, sessionRewardWei } from "../live/product/task";
import { sha256Utf8 } from "../live/product/taskId";
import {
  collectTransferEvidence,
  enrichCancelRefundTransfer,
  preserveEnrichedTransfer,
} from "../live/product/transfers";

type QuoteMap = Partial<Record<ProductActionName, TransactionFeeEstimate>>;

function receiptStatusName(receipt: unknown, fallback?: string): string | undefined {
  if (!receipt || typeof receipt !== "object") return fallback;
  const rec = receipt as Record<string, unknown>;
  if (typeof rec.statusName === "string") return rec.statusName;
  if (typeof rec.status === "string") return rec.status;
  return fallback;
}

function receiptExecutionName(receipt: unknown, fallback?: string): string | undefined {
  if (!receipt || typeof receipt !== "object") return fallback;
  const rec = receipt as Record<string, unknown>;
  if (typeof rec.txExecutionResultName === "string") return rec.txExecutionResultName;
  if (typeof rec.executionName === "string") return rec.executionName;
  return fallback;
}

function feeFromCancel(session: ProductSession): FinalizedFee {
  if (session.cancel.actualFeeAvailable && session.cancel.actualFeeWei) {
    return {
      available: true,
      feeWei: BigInt(session.cancel.actualFeeWei),
      source: session.cancel.actualFeeSource,
      reason: `Stored receipt fee ${session.cancel.actualFeeWei} wei (${session.cancel.actualFeeSource ?? "receipt"}).`,
    };
  }
  return extractFinalizedFee(session.cancel.receipt);
}

function createArgsFromSession(session: ProductSession, translator: string) {
  return createTaskArgs({
    clientNonce: session.clientNonce ?? "",
    translator,
    submitByUnix: session.submitByUnix ?? 0,
    recoverAfterUnix: session.recoverAfterUnix ?? 0,
    sourceText: TEST_SOURCE_TEXT,
    sourceLocale: TEST_SOURCE_LOCALE,
    targetLocale: TEST_TARGET_LOCALE,
    stringKey: TEST_STRING_KEY,
    appContext: TEST_APP_CONTEXT,
    intendedMeaning: TEST_INTENDED_MEANING,
    semanticCriteria: TEST_SEMANTIC_CRITERIA,
  });
}

async function bindCreateClockAndNonce(
  session: ProductSession,
  input: {
    funder: string;
    translator: string;
    address: string;
    value: bigint;
    from: `0x${string}`;
    forceDiscover?: boolean;
  },
): Promise<ProductSession> {
  let genvmNow = input.forceDiscover ? undefined : cachedGenvmUnix(session);
  if (genvmNow == null) {
    genvmNow = await discoverGenvmUnix(
      makeCreateDeadlineProbe({
        address: input.address as `0x${string}`,
        translator: input.translator,
        value: input.value,
        from: input.from,
      }),
    );
  }
  const wallUnix = Math.floor(Date.now() / 1000);
  const lag = wallUnix - genvmNow;
  rememberGenvmLag(lag);
  const signNow = createSignNowUnix(genvmNow, wallUnix);
  const bound = await bindCreateEstimateIdentity(session, { funder: input.funder, nowUnix: signNow.nowUnix });
  return { ...bound, genvmLagSeconds: lag, createDeadlineClock: signNow.clock };
}

async function quoteNamedWrite(name: ProductActionName, from: `0x${string}`, value: bigint): Promise<TransactionFeeEstimate> {
  if (name === "deploy") return quoteDeploy();
  const latest = loadProductSession();
  if (!latest.address) throw new Error("Deploy the product contract first.");
  let args: unknown[];
  if (name === "cancel") {
    args = [latest.expectedTaskId];
  } else if (latest.createDeadlineClock === "utc") {
    const genvmNow = cachedGenvmUnix(latest) ?? genvmNowForSession(latest);
    const sim = createDeadlinesFromGenvm(genvmNow);
    args = createTaskArgs({
      clientNonce: latest.clientNonce ?? `fee-sim-${sim.submitByUnix}`,
      translator: latest.translator.trim(),
      submitByUnix: sim.submitByUnix,
      recoverAfterUnix: sim.recoverAfterUnix,
      sourceText: TEST_SOURCE_TEXT,
      sourceLocale: TEST_SOURCE_LOCALE,
      targetLocale: TEST_TARGET_LOCALE,
      stringKey: TEST_STRING_KEY,
      appContext: TEST_APP_CONTEXT,
      intendedMeaning: TEST_INTENDED_MEANING,
      semanticCriteria: TEST_SEMANTIC_CRITERIA,
    });
  } else {
    args = createArgsFromSession(latest, latest.translator.trim());
  }
  return quoteWrite({
    address: latest.address as `0x${string}`,
    functionName: name === "create" ? "create_task" : "cancel_task",
    args,
    value,
    from,
  });
}

export function LiveProductTest() {
  const wallet = useWallet();
  const [session, setSession] = useState<ProductSession>(() => resetProductTransientPhases(loadProductSession()));
  const quotes = useRef<QuoteMap>({});
  const resumeOnce = useRef(false);
  const [sourceRechecked, setSourceRechecked] = useState(false);
  const [clearPrompt, setClearPrompt] = useState(false);
  const [evidenceExported, setEvidenceExported] = useState(false);

  const persist = useCallback((next: ProductSession) => {
    saveProductSession(next);
    setSession(next);
    return next;
  }, []);

  const update = useCallback((updater: (current: ProductSession) => ProductSession) => {
    setSession((current) => {
      const next = updater(current);
      saveProductSession(next);
      return next;
    });
  }, []);

  const translator = session.translator.trim();
  const rewardWei = sessionRewardWei(session);
  const rewardInputError = session.create.txId ? undefined : genRewardError(session.rewardGen);
  const writeCtx: ProductWriteContext = {
    funder: wallet.address,
    chainId: wallet.chainId,
    translator,
    connected: wallet.connected,
  };
  const compat = productSessionCompatible(session, wallet.address, translator);
  const overall = useMemo(() => overallProductVerdict(session), [session]);
  const evidence = useMemo(() => {
    try {
      return buildProductEvidencePayload({ funder: wallet.address, chainId: wallet.chainId, session });
    } catch (err) {
      return JSON.stringify({ error: formatError(err), boundFunder: session.boundFunder ?? null, live_result: "UNPROVEN" }, null, 2);
    }
  }, [wallet.address, wallet.chainId, session]);

  useEffect(() => {
    let cancelled = false;
    setSession((current) => {
      const next = resetProductTransientPhases(current);
      saveProductSession(next);
      return next;
    });
    void sha256Utf8(PRODUCT_SOURCE).then((hash) => {
      if (cancelled) return;
      update((current) => invalidateStaleSourceMatch(current, hash));
    });
    return () => {
      cancelled = true;
    };
  }, [update]);

  useEffect(() => {
    setSession((current) => {
      const next = invalidateProductUnsignedQuotes(current);
      if (
        next.deploy.quotedBinding === current.deploy.quotedBinding &&
        next.create.quotedBinding === current.create.quotedBinding &&
        next.cancel.quotedBinding === current.cancel.quotedBinding
      ) {
        return current;
      }
      quotes.current = {};
      saveProductSession(next);
      return next;
    });
  }, [wallet.address, wallet.chainId, translator, session.address, session.rewardGen, session.clientNonce]);

  const applySummary = useCallback(
    (name: ProductActionName, summary: TxSummary) => {
      update((current) => {
        const nextAction = applyTxSummaryToAction(current[name], summary);
        let next: ProductSession = { ...current, [name]: nextAction };
        if (name === "deploy") {
          if (summary.parentSuccessful && summary.contractAddress) {
            next = { ...next, address: summary.contractAddress };
          } else if (summary.statusName === "FINALIZED" && !summary.parentSuccessful) {
            next = { ...next, address: undefined, sourceMatch: false };
          }
        }
        return next;
      });
    },
    [update],
  );

  const verifySource = useCallback(async (address: string) => {
    const localSha256 = await sha256Utf8(PRODUCT_SOURCE);
    try {
      const raw = await rpcGetContractCode(address);
      const compared = await compareLocalToDeployed(PRODUCT_SOURCE, raw);
      update((current) => applySourceComparison(current, compared, address));
      return compared;
    } catch (err) {
      const failed = unverifiedSource(
        localSha256,
        `Source match is UNPROVEN: ${formatError(err)} Create stays disabled until gen_getContractCode returns LocaleBounty source that hashes to the local file.`,
      );
      update((current) => applySourceComparison(current, failed, address));
      return failed;
    }
  }, [update]);

  const refreshCreateTask = useCallback(async () => {
    const stored = loadProductSession();
    if (!stored.address || !stored.expectedTaskId) return undefined;
    try {
      const raw = jsonSafe(await readProductTask(createReadClient(), stored.address, stored.expectedTaskId));
      const parsed = parseProductTask(raw);
      update((current) => ({
        ...current,
        createTask: parsed,
        create: { ...current.create, snapshot: raw, error: undefined },
      }));
      return parsed;
    } catch (err) {
      update((current) => ({
        ...current,
        create: { ...current.create, error: `get_task failed: ${formatError(err)}` },
      }));
      return undefined;
    }
  }, [update]);

  const enrichCancelTransfer = useCallback(
    async (parentReceipt: unknown, txId: string) => {
      const stored = loadProductSession();
      const reward = sessionRewardWei(stored);
      const funder = stored.boundFunder ?? wallet.address ?? "";
      const contract = stored.address;
      if (!contract || !funder || reward == null) {
        return collectTransferEvidence(parentReceipt, txId);
      }
      return enrichCancelRefundTransfer({
        parentReceipt,
        parentTxId: txId,
        contract,
        funder,
        rewardWei: reward.toString(),
        fetchTx: rpcGetTransaction,
        listAddressTxs: rpcGetTransactionsForAddress,
      });
    },
    [wallet.address],
  );

  const refreshCancelReceipts = useCallback(async () => {
    const stored = loadProductSession();
    const txId = stored.cancel.txId;
    if (!txId) return;
    let parentReceipt = stored.cancel.receipt;
    let receiptError: string | undefined;
    try {
      parentReceipt = await rpcGetTransaction(txId);
    } catch (err) {
      receiptError = `eth_getTransactionByHash failed while refreshing cancel ${txId}: ${formatError(err)} Existing tx ID is kept. Not resubmitting.`;
    }
    const transfer = await enrichCancelTransfer(parentReceipt, txId);
    let cancelTask = stored.cancelTask;
    let getTaskError: string | undefined;
    let getTaskOk = false;
    if (stored.address && stored.expectedTaskId) {
      try {
        const raw = jsonSafe(await readProductTask(createReadClient(), stored.address, stored.expectedTaskId));
        cancelTask = parseProductTask(raw);
        getTaskOk = true;
      } catch (err) {
        getTaskError = `get_task after cancel: ${formatError(err)}`;
      }
    }
    const fee = extractFinalizedFee(parentReceipt);
    update((current) => ({
      ...current,
      transfer,
      cancelTask,
      cancel: {
        ...current.cancel,
        txId,
        receipt: parentReceipt ?? current.cancel.receipt,
        statusName: receiptStatusName(parentReceipt, current.cancel.statusName),
        executionName: receiptExecutionName(parentReceipt, current.cancel.executionName),
        parentSuccessful:
          current.cancel.parentSuccessful ||
          (receiptStatusName(parentReceipt) === "FINALIZED" &&
            receiptExecutionName(parentReceipt) === "FINISHED_WITH_RETURN"),
        error: errorAfterSuccessfulRefresh({ receiptError, getTaskOk, getTaskError }),
        ...(fee.available
          ? {
              actualFeeWei: fee.feeWei?.toString(),
              actualFeeSource: fee.source,
              actualFeeAvailable: true,
            }
          : {}),
      },
    }));
  }, [enrichCancelTransfer, update]);

  const trackExisting = useCallback(
    async (name: ProductActionName, txId: string) => {
      update((current) => withProductAction(current, name, { phase: "waiting", txId, error: undefined }));
      try {
        const summary = await watchTx(createReadClient(), txId, (partial) => applySummary(name, partial));
        applySummary(name, summary);
        if (name === "deploy" && summary.parentSuccessful && (summary.contractAddress || loadProductSession().address)) {
          const address = summary.contractAddress ?? loadProductSession().address;
          if (address) await verifySource(address);
        }
        if (name === "create" && summary.parentSuccessful) {
          await refreshCreateTask();
        }
        if (name === "cancel") {
          const stored = loadProductSession();
          const transfer = await enrichCancelTransfer(summary.receipt, txId);
          let cancelTask = stored.cancelTask;
          let getTaskOk = false;
          let getTaskError: string | undefined;
          if (stored.address && stored.expectedTaskId) {
            try {
              const raw = jsonSafe(await readProductTask(createReadClient(), stored.address, stored.expectedTaskId));
              cancelTask = parseProductTask(raw);
              getTaskOk = true;
            } catch (err) {
              getTaskError = `get_task after cancel: ${formatError(err)}`;
            }
          }
          update((current) => ({
            ...current,
            transfer,
            cancelTask,
            cancel: {
              ...current.cancel,
              error: errorAfterSuccessfulRefresh({
                getTaskOk,
                getTaskError: getTaskError ?? current.cancel.error,
              }),
            },
          }));
        }
        return summary;
      } catch (err) {
        update((current) =>
          withProductAction(current, name, {
            phase: "waiting",
            txId,
            error: `Wait timed out or RPC failed while tracking ${txId}. Not resubmitting. ${formatError(err)}`,
          }),
        );
        return null;
      }
    },
    [applySummary, enrichCancelTransfer, refreshCreateTask, update, verifySource],
  );

  const pollPayment = useCallback(async () => {
    await refreshCancelReceipts();
    const stored = loadProductSession();
    const named = stored.boundTranslator ?? stored.translator;
    const funder = stored.boundFunder ?? wallet.address;
    const contract = stored.address;
    const reward = sessionRewardWei(stored);
    if (!funder || !contract || !isEoaAddress(named) || reward == null) return;
    const before = stored.beforeCancel;
    if (!before) {
      update((current) => ({
        ...current,
        paymentEvidence: "UNPROVEN",
        paymentReason: `Cannot prove an EOA delta: no before-cancel balances were stored. Parent success is not payment. ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`,
      }));
      return;
    }
    const deadline = Date.now() + EXTERNAL_WAIT_MS;
    const samples: EoaBalances[] = [];
    let last = await readEoaBalances({ funder, named, contract });
    samples.push(last);
    while (true) {
      const live = loadProductSession();
      const evalResult = evaluateCancelRefund({
        parentSuccessful: Boolean(live.cancel.parentSuccessful),
        statusName: live.cancel.statusName,
        executionName: live.cancel.executionName,
        parentTxId: live.cancel.txId,
        rewardWei: reward,
        funder,
        named,
        transfer: live.transfer,
        before,
        after: last,
        actualFee: feeFromCancel(live),
      });
      if (evalResult.verdict === "YES") {
        update((current) => ({
          ...current,
          afterWait: last,
          waitSamples: samples,
          paymentEvidence: "YES",
          paymentReason: `${evalResult.reason} ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`,
        }));
        return;
      }
      if (Date.now() >= deadline) {
        update((current) => ({
          ...current,
          afterWait: last,
          waitSamples: samples,
          paymentEvidence: "UNPROVEN",
          paymentReason: `${evalResult.reason} payout_submitted=${String(live.cancelTask?.payout_submitted ?? false)}. ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`,
        }));
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, EXTERNAL_POLL_MS));
      last = await readEoaBalances({ funder, named, contract });
      samples.push(last);
    }
  }, [refreshCancelReceipts, update, wallet.address]);

  const resumeAll = useCallback(async () => {
    const stored = loadProductSession();
    for (const name of ["deploy", "create"] as ProductActionName[]) {
      const action = stored[name];
      if (action.txId && (needsProductTxResume(action) || (name === "create" && !action.snapshot))) {
        await trackExisting(name, action.txId);
      }
    }
    if (stored.cancel.txId && needsProductTxResume(stored.cancel)) {
      await trackExisting("cancel", stored.cancel.txId);
    }
    const after = loadProductSession();
    if (after.address) {
      await verifySource(after.address);
    }
    if (isFinalizedSuccessful(after.create) && !after.createTask) {
      await refreshCreateTask();
    }
    if (after.cancel.txId) {
      await pollPayment();
    }
    setSourceRechecked(true);
  }, [pollPayment, refreshCreateTask, trackExisting, verifySource]);

  useEffect(() => {
    if (resumeOnce.current) return;
    resumeOnce.current = true;
    void resumeAll();
  }, [resumeAll]);

  async function prepareAction(name: ProductActionName) {
    const failOnCard = (error: string) => {
      update((current) => withProductAction(current, name, { phase: "idle", error }));
    };
    try {
      const live = loadProductSession();
      if (hasTxId(live[name])) {
        failOnCard(`Transaction ID ${live[name].txId} already exists. Resume tracking; not estimating a resubmit.`);
        return;
      }
      const identity = await wallet.verifyBeforeWrite();
      const ctx: ProductWriteContext = {
        funder: identity.address,
        chainId: identity.chainId,
        translator: loadProductSession().translator.trim(),
        connected: true,
      };
      const bound = productSessionCompatible(loadProductSession(), ctx.funder, ctx.translator);
      if (!bound.ok) {
        failOnCard(bound.reason);
        return;
      }
      let working = loadProductSession();
      const reward = sessionRewardWei(working);
      const allowed = productActionEstimateAllowed(name, working, ctx, reward);
      if (!allowed.ok) {
        failOnCard(allowed.reason);
        return;
      }
      const value = name === "create" ? reward ?? 0n : 0n;
      update((current) => withProductAction(current, name, { phase: "quoting", error: undefined }));
      if (name === "create") {
        const address = working.address;
        if (!address) throw new Error("Deploy the product contract first.");
        working = persist(
          await bindCreateClockAndNonce(working, {
            funder: identity.address,
            translator: ctx.translator,
            address,
            value,
            from: identity.address,
          }),
        );
      }
      let estimate: TransactionFeeEstimate;
      try {
        estimate = await quoteNamedWrite(name, identity.address, value);
      } catch (err) {
        if (name === "create") {
          const status = deadlineStatusFromError(err);
          if (status === "far" || status === "past" || status === "early") {
            clearRememberedGenvmLag();
            const address = loadProductSession().address;
            if (!address) throw err;
            working = persist(
              await bindCreateClockAndNonce(
                { ...loadProductSession(), genvmLagSeconds: undefined },
                {
                  funder: identity.address,
                  translator: ctx.translator,
                  address,
                  value,
                  from: identity.address,
                  forceDiscover: true,
                },
              ),
            );
            estimate = await quoteNamedWrite(name, identity.address, value);
          } else {
            throw err;
          }
        } else {
          throw err;
        }
      }
      const latest = loadProductSession();
      const binding = currentProductQuoteBinding({
        wallet: identity.address,
        chainId: identity.chainId,
        contract: latest.address,
        translator: ctx.translator,
        method: name,
        valueWei: value.toString(),
        clientNonce: latest.clientNonce,
        submitByUnix: latest.submitByUnix,
        recoverAfterUnix: latest.recoverAfterUnix,
        taskId: latest.expectedTaskId,
      });
      quotes.current[name] = estimate;
      update((current) =>
        withProductAction(current, name, {
          phase: "quoted",
          quotedValueWei: value.toString(),
          quotedFeeWei: estimate.feeValue.toString(),
          quotedBinding: binding,
          quotedAt: Date.now(),
          error: undefined,
        }),
      );
    } catch (err) {
      failOnCard(isUserRejection(err) ? "Wallet rejected the fee estimate." : formatError(err));
    }
  }

  async function signAction(name: ProductActionName) {
    const existing = loadProductSession()[name];
    if (neverResubmit(existing) === "resume") {
      if (existing.txId) await trackExisting(name, existing.txId);
      if (name === "cancel") await pollPayment();
      return;
    }
    const identity = await wallet.verifyBeforeWrite();
    let live = loadProductSession();
    const ctx: ProductWriteContext = {
      funder: identity.address,
      chainId: identity.chainId,
      translator: live.translator.trim(),
      connected: true,
    };
    const bound = productSessionCompatible(live, ctx.funder, ctx.translator);
    if (!bound.ok) {
      update((current) => withProductAction(current, name, { error: bound.reason }));
      return;
    }
    if (
      name === "create" &&
      deadlinesStale(
        live.submitByUnix,
        live.createDeadlineClock === "utc" ? Math.floor(Date.now() / 1000) : genvmNowForSession(live),
      )
    ) {
      quotes.current.create = undefined;
      update((current) =>
        withProductAction(current, name, {
          phase: "idle",
          quotedBinding: undefined,
          quotedFeeWei: undefined,
          error:
            "Create deadlines are too close to Studio-dev GetTimestamp expiry. Estimate again to bind fresh submit_by / recover_after.",
        }),
      );
      return;
    }
    const reward = sessionRewardWei(live);
    const allowed = productActionSignAllowed(name, live, ctx, reward);
    if (!allowed.ok) {
      update((current) => withProductAction(current, name, { error: allowed.reason }));
      return;
    }
    const value = name === "create" ? reward ?? 0n : 0n;
    const currentBinding = currentProductQuoteBinding({
      wallet: identity.address,
      chainId: identity.chainId,
      contract: live.address,
      translator: ctx.translator,
      method: name,
      valueWei: value.toString(),
      clientNonce: live.clientNonce,
      submitByUnix: live.submitByUnix,
      recoverAfterUnix: live.recoverAfterUnix,
      taskId: live.expectedTaskId,
    });
    if (!productQuoteStillValid(live[name].quotedBinding, currentBinding)) {
      quotes.current[name] = undefined;
      update((current) =>
        withProductAction(current, name, {
          phase: "idle",
          quotedBinding: undefined,
          quotedFeeWei: undefined,
          error: productQuoteInvalidReason(live[name].quotedBinding, currentBinding),
        }),
      );
      return;
    }
    const estimate = quotes.current[name];
    if (!estimate) {
      update((current) =>
        withProductAction(current, name, {
          error: "Estimate again before signing. Unsigned fee quotes are not reused after a reload, and a timeout never resubmits.",
        }),
      );
      return;
    }
    const floor = quoteMeetsStudioFloor(estimate);
    if (!floor.ok) {
      quotes.current[name] = undefined;
      update((current) =>
        withProductAction(current, name, {
          phase: "idle",
          quotedBinding: undefined,
          quotedFeeWei: undefined,
          quotedValueWei: undefined,
          error: floor.reason,
        }),
      );
      return;
    }
    if (wallet.balanceWei != null && wallet.balanceWei < estimate.feeValue + value) {
      update((current) =>
        withProductAction(current, name, {
          error: `Insufficient GEN. Wallet has ${formatGen(wallet.balanceWei ?? 0n)}; this write needs ${formatGen(value)} attached plus ${formatGen(estimate.feeValue)} protocol fee.`,
        }),
      );
      return;
    }

    update((current) => withProductAction(current, name, { phase: "signing", error: undefined }));
    try {
      const client = createWriteClient(identity.address, wallet.provider!);
      if (name !== "deploy") {
        const before = await readEoaBalances({
          funder: identity.address,
          named: ctx.translator,
          contract: live.address,
        });
        update((current) => (name === "create" ? { ...current, beforeCreate: before } : { ...current, beforeCancel: before }));
      }

      let txId: string;
      if (name === "deploy") {
        txId = await submitProductDeploy(client, estimate);
      } else {
        const address = loadProductSession().address;
        if (!address) throw new Error("Missing contract address");
        const latest = loadProductSession();
        txId = await submitWrite(client, {
          address: address as `0x${string}`,
          functionName: name === "create" ? "create_task" : "cancel_task",
          args: name === "create" ? createArgsFromSession(latest, ctx.translator) : [latest.expectedTaskId],
          value,
          estimate,
        });
      }

      setSession((current) => {
        let boundSession = bindProductSession(current, identity.address, ctx.translator);
        if (name === "create") {
          boundSession = {
            ...boundSession,
            boundRewardWei: boundSession.boundRewardWei ?? value.toString(),
            boundRewardGen: boundSession.boundRewardGen ?? boundSession.rewardGen,
          };
        }
        const next = withProductAction(boundSession, name, { phase: "submitted", txId, submittedAt: Date.now() });
        saveProductSession(next);
        return next;
      });
      const summary = await trackExisting(name, txId);
      if (!summary) return;
      const latest = loadProductSession();
      if (name !== "deploy" && latest.address) {
        const afterParent = await readEoaBalances({
          funder: identity.address,
          named: ctx.translator,
          contract: latest.address,
        });
        update((current) => (name === "create" ? { ...current, afterCreate: afterParent } : { ...current, afterParent }));
      }
      if (name === "cancel") {
        const latestAfterTrack = loadProductSession();
        const transfer = preserveEnrichedTransfer(
          latestAfterTrack.transfer,
          collectTransferEvidence(summary.receipt, txId, sessionRewardWei(latestAfterTrack)?.toString()),
        );
        const evalNow = evaluateCancelRefund({
          parentSuccessful: Boolean(summary.parentSuccessful),
          statusName: summary.statusName,
          executionName: summary.executionName,
          parentTxId: txId,
          rewardWei: sessionRewardWei(latestAfterTrack) ?? (value === 0n ? 0n : value),
          funder: identity.address,
          named: ctx.translator,
          transfer,
          before: latestAfterTrack.beforeCancel,
          after: latestAfterTrack.afterParent,
          actualFee: feeFromCancel(latestAfterTrack),
        });
        update((current) => ({
          ...current,
          transfer,
          paymentEvidence: evalNow.verdict === "YES" ? "YES" : "UNPROVEN",
          paymentReason: `${evalNow.reason} ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`,
        }));
        await pollPayment();
      }
      await wallet.refreshBalance();
    } catch (err) {
      if (isUserRejection(err)) {
        update((current) =>
          withProductAction(current, name, {
            phase: "rejected",
            error: "Wallet rejected the signature request. Nothing was submitted.",
          }),
        );
        return;
      }
      const still = loadProductSession()[name];
      if (still.txId) {
        update((current) =>
          withProductAction(current, name, {
            phase: "waiting",
            error: `A transaction ID already exists (${still.txId}). Tracking it instead of resubmitting. ${formatError(err)}`,
          }),
        );
        await trackExisting(name, still.txId);
        return;
      }
      const blocker = name === "deploy" ? describeDeployBlocker(err) : formatError(err);
      const budgetTooLow = /BudgetTooLow/i.test(formatError(err));
      if (budgetTooLow) quotes.current[name] = undefined;
      update((current) =>
        withProductAction(current, name, {
          phase: "idle",
          error: blocker,
          ...(budgetTooLow ? { quotedFeeWei: undefined, quotedValueWei: undefined, quotedBinding: undefined } : {}),
        }),
      );
    }
  }

  function retryAction(name: ProductActionName) {
    quotes.current[name] = undefined;
    update((current) => retryFailedProductAction(current, name));
  }

  const writesReady = Boolean(wallet.connected && wallet.onStudioDev && wallet.provider && wallet.address);
  const disabledReason = !compat.ok
    ? compat.reason
    : !writesReady
      ? wallet.connected
        ? `Wrong chain (${wallet.chainId ?? "unknown"}). Switch to Studio-dev ${STUDIO_DEV_CHAIN_ID}.`
        : "Connect a wallet first. Demo Owner / Demo Translator is not authorization."
      : undefined;

  const deployGuard = disabledReason ? { ok: false as const, reason: disabledReason } : deployWriteAllowed(session, writeCtx);
  const createGuard = disabledReason
    ? { ok: false as const, reason: disabledReason }
    : !sourceRechecked
      ? {
          ok: false as const,
          reason:
            "Rechecking gen_getContractCode against this contract address and the current PRODUCT_SOURCE SHA-256 before create is enabled.",
        }
      : createEstimateAllowed(session, writeCtx, rewardWei);
  const createSignGuard = disabledReason
    ? { ok: false as const, reason: disabledReason }
    : createSignAllowed(session, writeCtx, rewardWei);
  const cancelGuard = disabledReason ? { ok: false as const, reason: disabledReason } : cancelWriteAllowed(session, writeCtx, rewardWei);
  const clearRisk = productClearRisk(session);
  const paymentEval = evaluateCancelRefund({
    parentSuccessful: Boolean(session.cancel.parentSuccessful),
    statusName: session.cancel.statusName,
    executionName: session.cancel.executionName,
    parentTxId: session.cancel.txId,
    rewardWei: rewardWei ?? 0n,
    funder: session.boundFunder ?? wallet.address ?? "",
    named: session.boundTranslator ?? translator,
    transfer: session.transfer,
    before: session.beforeCancel,
    after: session.afterWait ?? session.afterParent,
    actualFee: feeFromCancel(session),
  });

  return (
    <div className="w-full px-gutter py-space-xl max-w-7xl mx-auto flex flex-col gap-space-xl">
      <section className="flex flex-col gap-space-sm">
        <div className="flex flex-wrap items-center gap-space-sm">
          <span className="inline-flex items-center gap-1 px-space-sm py-0.5 bg-secondary-container text-on-secondary-container font-label-sm text-label-sm uppercase tracking-wider rounded shadow-[2px_2px_0px_#00170b]">
            Live Product Test · Phase A
          </span>
          <span className="inline-flex items-center gap-1 px-space-sm py-0.5 bg-tertiary-fixed text-on-tertiary-fixed font-label-sm text-label-sm uppercase tracking-wider rounded">
            Studio-dev {STUDIO_DEV_CHAIN_ID} only
          </span>
          <span className="inline-flex items-center gap-1 px-space-sm py-0.5 bg-error-container text-on-error-container font-label-sm text-label-sm uppercase tracking-wider rounded">
            Live result UNPROVEN
          </span>
        </div>
        <h1 className="font-display-lg text-display-lg-mobile md:text-display-lg text-primary tracking-tight leading-none uppercase">
          LocaleBounty contract · deploy, create, cancel
        </h1>
        <p className="font-body-lg text-body-lg text-on-surface-variant max-w-3xl">
          This harness talks to <span className="font-mono">contracts/localebounty.py</span> on Studio-dev and keeps its
          own persist key. The six public screens at <span className="font-mono">/</span> are wired to the same contract.
          The old Stitch demo stays under <span className="font-mono">/demo</span>. Demo Owner / Demo Translator is not
          wallet authorization and cannot sign these transactions.
        </p>
        <p className="font-body-md text-body-md text-on-surface-variant max-w-3xl bg-surface-container-lowest px-space-md py-space-sm rounded">
          Every write needs an explicit Estimate, then an explicit Sign. Account and chain are rechecked before each.
          Attached reward, fee deposit, and expected wallet spend are shown separately. {HISTORICAL_PROBE_PAYOUT_FEE_NOTE}
        </p>
      </section>

      <WalletCard />

      <section className="bg-surface-container-lowest p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-md">
        <h2 className="font-title-lg text-title-lg text-primary uppercase">Fund on Studio-dev</h2>
        <p className="font-body-md text-body-md text-on-surface-variant">
          Request faucet GEN for the same browser wallet. This app never asks for a private key. Quote the live fee
          deposit separately from the attached reward. The historical probe actual fee was 0.000126304500000823 GEN,
          not 0.126 GEN.
        </p>
        <div className="flex flex-wrap gap-space-sm">
          <a
            className="inline-flex items-center gap-space-xs bg-secondary-container text-on-secondary-container font-label-md text-label-md uppercase px-space-md py-space-sm rounded shadow-[2px_2px_0px_#00170b]"
            href={STUDIO_DEV_FAUCET}
            target="_blank"
            rel="noreferrer"
          >
            Open Studio-dev faucet
          </a>
          <a className="font-label-md text-label-md uppercase text-secondary" href={STUDIO_DEV_STUDIO} target="_blank" rel="noreferrer">
            Studio UI
          </a>
          <a className="font-label-md text-label-md uppercase text-secondary" href={STUDIO_DEV_EXPLORER} target="_blank" rel="noreferrer">
            Explorer
          </a>
          <span className="font-body-sm text-body-sm text-on-surface-variant font-mono">{STUDIO_DEV_RPC}</span>
        </div>
      </section>

      <section className="bg-surface-container-lowest p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-md">
        <h2 className="font-title-lg text-title-lg text-primary uppercase">Named translator and reward</h2>
        <p className="font-body-md text-body-md text-on-surface-variant">
          Translator must be a different 20-byte EOA than the connected funder. Reward is user-chosen GEN attached to{" "}
          <span className="font-mono">create_task</span>. A fresh <span className="font-mono">client_nonce</span> is
          generated once per create attempt.
        </p>
        <label className="flex flex-col gap-space-xs">
          <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">Named translator EOA</span>
          <input
            value={session.translator}
            onChange={(e) => persist({ ...session, translator: e.target.value.trim() })}
            placeholder="0x…"
            className="bg-surface-container-high px-space-md py-space-sm rounded font-mono text-sm"
            spellCheck={false}
          />
        </label>
        <label className="flex flex-col gap-space-xs">
          <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">GEN reward (attached to create)</span>
          <input
            value={session.rewardGen}
            onChange={(e) => persist({ ...session, rewardGen: e.target.value })}
            placeholder="0.5"
            className="bg-surface-container-high px-space-md py-space-sm rounded font-mono text-sm disabled:opacity-60"
            inputMode="decimal"
            disabled={Boolean(session.create.txId)}
          />
        </label>
        {isEoaAddress(translator) ? (
          <p className="font-body-sm text-body-sm text-primary break-all">
            Translator that will be signed: <span className="font-mono">{translator}</span>
          </p>
        ) : session.translator ? (
          <p className="text-error font-body-sm text-body-sm">Enter a 0x-prefixed 40-hex-character address.</p>
        ) : null}
        {session.create.txId ? (
          <p className="font-body-sm text-body-sm text-on-surface-variant break-all">
            Reward is bound to create {session.create.txId}
            {session.boundRewardWei ? ` at ${session.boundRewardWei} wei` : rewardWei != null ? ` at ${rewardWei.toString()} wei` : ""}.
            Later GEN edits cannot change payment proof.
          </p>
        ) : rewardWei != null && rewardWei > 0n ? (
          <p className="font-body-sm text-body-sm">
            Attached reward: {formatGen(rewardWei)} ({rewardWei.toString()} wei). Protocol fee is quoted separately.
          </p>
        ) : rewardInputError ? (
          <p className="text-error font-body-sm text-body-sm">{rewardInputError}</p>
        ) : null}
        {session.boundFunder ? (
          <p className="font-body-sm text-body-sm text-on-surface-variant break-all">
            Bound funder {session.boundFunder}
            {session.boundTranslator ? ` · bound translator ${session.boundTranslator}` : ""}
          </p>
        ) : null}
        {session.clientNonce ? (
          <p className="font-body-sm text-body-sm font-mono break-all">client_nonce {session.clientNonce}</p>
        ) : null}
      </section>

      {disabledReason ? (
        <p className="bg-error-container text-on-error-container px-space-md py-space-sm rounded font-body-md text-body-md">
          Writes disabled: {disabledReason}
        </p>
      ) : null}

      <section className="bg-surface-container-low p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-md">
        <h2 className="font-title-lg text-title-lg text-primary uppercase">1. Deploy localebounty.py</h2>
        <p className="font-body-sm text-body-sm text-on-surface-variant break-all">
          {session.address ? (
            <a className="text-secondary underline-offset-2 hover:underline" href={explorerAddress(session.address)} target="_blank" rel="noreferrer">
              Contract {session.address}
            </a>
          ) : (
            "Contract: not deployed"
          )}
        </p>
        <ActionBlock
          title="Deploy current product contract (pinned runner in source header)"
          action={session.deploy}
          disabled={!deployGuard.ok}
          disableReason={deployGuard.ok ? undefined : deployGuard.reason}
          onPrepare={() => void prepareAction("deploy")}
          onSign={() => void signAction("deploy")}
          onRetry={() => retryAction("deploy")}
          attachedWei="0"
          quotedFeeWei={session.deploy.quotedFeeWei}
        />
      </section>

      <section className="bg-surface-container-low p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-md">
        <h2 className="font-title-lg text-title-lg text-primary uppercase">2. Verify deployed source</h2>
        <dl className="grid grid-cols-1 gap-space-sm font-body-sm text-body-sm">
          <div>
            <dt className="font-label-sm text-label-sm uppercase text-on-surface-variant">Local SHA-256</dt>
            <dd className="font-mono break-all">{session.localSourceSha256 ?? "hashing…"}</dd>
          </div>
          <div>
            <dt className="font-label-sm text-label-sm uppercase text-on-surface-variant">Deployed SHA-256</dt>
            <dd className="font-mono break-all">{session.deployedSourceSha256 ?? "UNPROVEN"}</dd>
          </div>
          <div>
            <dt className="font-label-sm text-label-sm uppercase text-on-surface-variant">Match</dt>
            <dd>
              {session.sourceMatch ? "YES" : session.sourceVerifyStatus} — {session.sourceVerifyReason}
            </dd>
          </div>
        </dl>
        <button
          type="button"
          disabled={!session.address}
          onClick={() => session.address && void verifySource(session.address)}
          className="self-start font-label-sm text-label-sm uppercase px-space-sm py-space-xs bg-surface-container-high rounded disabled:opacity-40"
        >
          Recheck source
        </button>
      </section>

      <section className="bg-surface-container-low p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-md">
        <h2 className="font-title-lg text-title-lg text-primary uppercase">3. Create one task</h2>
        <p className="font-body-sm text-body-sm text-on-surface-variant">
          Short test text, fresh nonce, submit_by ≈ GenVM now+1800s, recover_after = submit_by+3600s. Studio-dev
          GetTimestamp can lag the browser clock; Estimate binds deadlines to that clock. Expected task ID{" "}
          <span className="font-mono break-all">{session.expectedTaskId ?? "after estimate"}</span>
        </p>
        {session.submitByUnix != null && session.recoverAfterUnix != null ? (
          <p className="font-body-sm text-body-sm text-on-surface-variant font-mono break-all">
            Bound deadlines ({session.createDeadlineClock === "utc" ? "UTC envelope clock for Sign" : "GetTimestamp"}):
            submit_by={session.submitByUnix} recover_after={session.recoverAfterUnix}
            {session.genvmLagSeconds != null ? ` · GetTimestamp lag vs browser ≈ ${session.genvmLagSeconds}s` : ""}
          </p>
        ) : null}
        {session.createDeadlineClock === "utc" ? (
          <p className="font-body-sm text-body-sm text-on-surface-variant">
            Studio-dev fee simulation still uses GetTimestamp (~30-day window in 2024 on this runner). Consensus
            execution used a later clock on the previous create (submission deadline in the past while the same
            GetTimestamp window still simulates). Estimate quotes the fee in the simulation window; Sign submits these
            UTC deadlines.
          </p>
        ) : null}
        <ActionBlock
          title="create_task(client_nonce, …, translator, deadlines) + reward"
          action={session.create}
          disabled={!createGuard.ok}
          disableReason={createGuard.ok ? undefined : createGuard.reason}
          signDisabled={!createSignGuard.ok}
          signDisableReason={createSignGuard.ok ? undefined : createSignGuard.reason}
          onPrepare={() => void prepareAction("create")}
          onSign={() => void signAction("create")}
          onRetry={() => retryAction("create")}
          attachedWei={session.create.quotedValueWei ?? (rewardWei != null ? rewardWei.toString() : "0")}
          quotedFeeWei={session.create.quotedFeeWei}
          quoteHint="Estimating create_task. The first estimate may probe Studio-dev GetTimestamp before quoting. This is not a wallet signature."
        />

      </section>

      <section className="bg-surface-container-low p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-md">
        <h2 className="font-title-lg text-title-lg text-primary uppercase">4. Read get_task</h2>
        <button
          type="button"
          disabled={!session.address || !session.expectedTaskId}
          onClick={() => void refreshCreateTask()}
          className="self-start font-label-sm text-label-sm uppercase px-space-sm py-space-xs bg-surface-container-high rounded disabled:opacity-40"
        >
          Refresh get_task
        </button>
        {session.createTask ? (
          <dl className="grid grid-cols-1 md:grid-cols-2 gap-space-sm font-body-sm text-body-sm">
            <Field label="task_id" value={session.createTask.task_id} />
            <Field label="funder" value={session.createTask.funder} />
            <Field label="translator" value={session.createTask.translator} />
            <Field label="reward wei" value={session.createTask.rewardWei} />
            <Field label="client_nonce" value={session.createTask.client_nonce} />
            <Field label="state" value={session.createTask.state} />
            <Field label="payout_submitted" value={String(session.createTask.payout_submitted)} />
            <Field label="submit_by_unix" value={String(session.createTask.submit_by_unix)} />
            <Field label="recover_after_unix" value={String(session.createTask.recover_after_unix)} />
            <Field label="translation" value={session.createTask.translation === "" ? "(empty)" : session.createTask.translation} />
          </dl>
        ) : (
          <p className="font-body-sm text-body-sm text-on-surface-variant">No get_task snapshot for this session yet.</p>
        )}
      </section>

      <section className="bg-surface-container-low p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-md">
        <h2 className="font-title-lg text-title-lg text-primary uppercase">5. Cancel still-open task</h2>
        <p className="font-body-sm text-body-sm text-on-surface-variant">
          Enabled only after create is FINALIZED, isSuccessful, and get_task matches this session (funder, translator,
          reward, nonce-derived task ID, deadlines, open, empty translation).
        </p>
        <ActionBlock
          title="cancel_task(task_id)"
          action={session.cancel}
          disabled={!cancelGuard.ok}
          disableReason={cancelGuard.ok ? undefined : cancelGuard.reason}
          onPrepare={() => void prepareAction("cancel")}
          onSign={() => void signAction("cancel")}
          onRetry={() => retryAction("cancel")}
          attachedWei="0"
          quotedFeeWei={session.cancel.quotedFeeWei}
        />
        {session.cancel.txId ? (
          <button
            type="button"
            onClick={() => void pollPayment()}
            className="self-start font-label-sm text-label-sm uppercase px-space-sm py-space-xs bg-tertiary-fixed text-on-tertiary-fixed rounded"
          >
            Refresh balance evidence
          </button>
        ) : null}
      </section>

      <section className="bg-surface-container-lowest p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-md">
        <h2 className="font-title-lg text-title-lg text-primary uppercase">Evidence fields (kept separate)</h2>
        <StatusFields
          tx={session.cancel.statusName ?? session.create.statusName ?? session.deploy.statusName ?? "none"}
          execution={session.cancel.executionName ?? session.create.executionName ?? session.deploy.executionName ?? "none"}
          contractState={session.cancelTask?.state ?? session.createTask?.state ?? "none"}
          payoutSubmitted={String(session.cancelTask?.payout_submitted ?? session.createTask?.payout_submitted ?? false)}
          transfer={paymentEval.transferLabel}
          balance={paymentEval.balanceLabel}
          payment={`${session.paymentEvidence} — ${session.paymentReason}`}
        />
        <p className="font-body-sm text-body-sm text-on-surface-variant">
          Wallet confirmation or a successful parent alone never displays “refund paid”. Payment YES requires outgoing
          EthSend to the funder for the exact reward, child value_credited, and funder delta = reward − receipt fee.{" "}
          {PAYOUT_SUBMITTED_IS_NOT_PAYMENT}
        </p>
      </section>

      <section className="bg-primary-container text-inverse-on-surface p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-md">
        <div className="flex flex-wrap items-end justify-between gap-space-md">
          <div>
            <p className="font-label-sm text-label-sm uppercase tracking-wider text-tertiary-fixed">Phase A live result</p>
            <h2 className="font-display-lg text-headline-lg uppercase">{overall.verdict}</h2>
            <p className="font-body-md text-body-md text-inverse-on-surface/80 max-w-3xl">{overall.reason}</p>
          </div>
          <CopyButton value={evidence} label="Copy evidence JSON" />
        </div>
        {clearPrompt ? (
          <div className="bg-surface-container-lowest text-on-surface p-space-md rounded flex flex-col gap-space-sm">
            <p className="font-body-sm text-body-sm">{clearRisk.reason}</p>
            <p className="font-body-sm text-body-sm font-mono break-all">Task ID: {clearRisk.taskId ?? "(none)"}</p>
            <p className="font-body-sm text-body-sm font-mono break-all">Deploy tx: {clearRisk.txIds.deploy ?? "(none)"}</p>
            <p className="font-body-sm text-body-sm font-mono break-all">Create tx: {clearRisk.txIds.create ?? "(none)"}</p>
            <p className="font-body-sm text-body-sm font-mono break-all">Cancel tx: {clearRisk.txIds.cancel ?? "(none)"}</p>
            <CopyButton value={evidence} label="Copy evidence JSON" onCopied={() => setEvidenceExported(true)} />
            {evidenceExported ? (
              <p className="font-body-sm text-body-sm">Evidence copied this prompt. You may clear local tracking.</p>
            ) : (
              <p className="font-body-sm text-body-sm">Copy evidence JSON before clearing.</p>
            )}
            <div className="flex flex-wrap gap-space-sm">
              <button
                type="button"
                disabled={!evidenceExported}
                className="font-label-sm text-label-sm uppercase tracking-wider px-space-sm py-space-xs bg-error-container text-on-error-container rounded disabled:opacity-40"
                onClick={() => {
                  quotes.current = {};
                  persist(clearProductSession());
                  setClearPrompt(false);
                  setEvidenceExported(false);
                  setSourceRechecked(true);
                }}
              >
                I exported evidence — clear tracking
              </button>
              <button
                type="button"
                className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant"
                onClick={() => {
                  setClearPrompt(false);
                  setEvidenceExported(false);
                }}
              >
                Keep tracking
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="self-start font-label-sm text-label-sm uppercase tracking-wider text-tertiary-fixed"
            onClick={() => {
              if (clearRisk.blocked) {
                setClearPrompt(true);
                setEvidenceExported(false);
                return;
              }
              quotes.current = {};
              persist(clearProductSession());
              setSourceRechecked(true);
            }}
          >
            Clear local tracking
          </button>
        )}
      </section>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-label-sm text-label-sm uppercase text-on-surface-variant">{label}</dt>
      <dd className="font-mono break-all">{value}</dd>
    </div>
  );
}

function ActionBlock({
  title,
  action,
  disabled,
  disableReason,
  signDisabled,
  signDisableReason,
  onPrepare,
  onSign,
  onRetry,
  attachedWei,
  quotedFeeWei,
  quoteHint,
}: {
  title: string;
  action: ProductActionRecord;
  disabled: boolean;
  disableReason?: string;
  signDisabled?: boolean;
  signDisableReason?: string;
  onPrepare: () => void;
  onSign: () => void;
  onRetry: () => void;
  attachedWei: string;
  quotedFeeWei?: string;
  quoteHint?: string;
}) {
  const busy = action.phase === "quoting" || action.phase === "signing" || action.phase === "submitted" || action.phase === "waiting";
  const resume = hasTxId(action);
  const failed = isTerminalFailure(action);
  const layers = action.txId
    ? consensusLayer({
        statusName: action.statusName,
        parentSuccessful: Boolean(action.parentSuccessful),
        executionName: action.executionName,
        executionError: action.executionError,
      })
    : undefined;
  let attached = 0n;
  let fee = 0n;
  try {
    attached = BigInt(attachedWei || "0");
  } catch {
    attached = 0n;
  }
  try {
    fee = quotedFeeWei ? BigInt(quotedFeeWei) : 0n;
  } catch {
    fee = 0n;
  }
  const fees = feeDepositFigures(quotedFeeWei, action.actualFeeWei);
  return (
    <div className="bg-surface-container-lowest p-space-md rounded flex flex-col gap-space-xs">
      <div className="flex flex-wrap items-baseline justify-between gap-space-xs">
        <h3 className="font-title-md text-title-md text-primary">{title}</h3>
        <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">{action.phase}</span>
      </div>
      <p className="font-body-sm text-body-sm">Attached reward: {formatGen(attached)}.</p>
      <p className="font-body-sm text-body-sm">{fees.depositLabel}</p>
      <p className="font-body-sm text-body-sm">{fees.actualLabel}</p>
      <p className="font-body-sm text-body-sm">{fees.unusedLabel}</p>
      <p className="font-body-sm text-body-sm">
        Expected wallet spend at sign: {quotedFeeWei ? formatGen(attached + fee) : "estimate first"}. Reward and fee
        deposit are separate.
      </p>
      {action.txId ? (
        <div className="flex flex-col gap-1">
          <a
            className="font-mono text-xs break-all text-secondary underline-offset-2 hover:underline"
            href={explorerTx(action.txId)}
            target="_blank"
            rel="noreferrer"
          >
            tx {action.txId}
          </a>
          <p className="font-body-sm text-body-sm text-on-surface-variant">{layers?.walletNote}</p>
          <p className="font-body-sm text-body-sm">{layers?.consensusNote}</p>
          <p className="font-body-sm text-body-sm">{layers?.executionNote}</p>
        </div>
      ) : null}
      {action.phase === "quoting" ? (
        <p className="font-body-sm text-body-sm text-on-surface-variant">
          {quoteHint ?? "Waiting for Studio-dev fee quote (up to 20s). This is not a wallet signature."}
        </p>
      ) : null}
      {action.phase === "waiting" || action.phase === "submitted" ? (
        <p className="font-body-sm text-body-sm text-on-surface-variant">
          Polling Studio-dev every 1s. MetaMask confirm is not execution success.
        </p>
      ) : null}
      {layers?.error || action.error ? (
        <p className="text-error font-body-sm text-body-sm">{layers?.error ?? action.error}</p>
      ) : null}
      {disableReason && !resume ? <p className="font-body-sm text-body-sm text-on-surface-variant">{disableReason}</p> : null}
      {signDisableReason && !resume && action.quotedFeeWei ? (
        <p className="font-body-sm text-body-sm text-on-surface-variant">{signDisableReason}</p>
      ) : null}
      <div className="flex flex-wrap gap-space-xs">
        <button
          type="button"
          disabled={disabled || busy || resume}
          onClick={onPrepare}
          className="font-label-sm text-label-sm uppercase px-space-sm py-space-xs bg-surface-container-high rounded disabled:opacity-40"
        >
          {action.phase === "quoting" ? "Estimating…" : "Estimate fee"}
        </button>
        <button
          type="button"
          disabled={resume ? busy : disabled || busy || Boolean(signDisabled) || !action.quotedFeeWei}
          onClick={onSign}
          className="font-label-sm text-label-sm uppercase px-space-sm py-space-xs bg-secondary-container text-on-secondary-container rounded shadow-[2px_2px_0px_#00170b] disabled:opacity-40"
        >
          {resume ? (busy ? "Tracking…" : "Refresh tracking") : action.phase === "signing" ? "Awaiting wallet…" : "Sign in wallet"}
        </button>
        {failed ? (
          <button
            type="button"
            onClick={onRetry}
            className="font-label-sm text-label-sm uppercase px-space-sm py-space-xs bg-tertiary-fixed text-on-tertiary-fixed rounded shadow-[2px_2px_0px_#00170b]"
          >
            New attempt
          </button>
        ) : null}
      </div>
    </div>
  );
}

function StatusFields({
  tx,
  execution,
  contractState,
  payoutSubmitted,
  transfer,
  balance,
  payment,
}: {
  tx: string;
  execution: string;
  contractState: string;
  payoutSubmitted: string;
  transfer: string;
  balance: string;
  payment: string;
}) {
  return (
    <div className="grid grid-cols-1 gap-space-xs">
      <StatusCard title="Transaction status" value={tx} />
      <StatusCard title="Execution result" value={execution} />
      <StatusCard title="Contract state" value={contractState} />
      <StatusCard title="Contract payout_submitted" value={`${payoutSubmitted}. ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`} />
      <StatusCard title="Transfer delivery" value={transfer} />
      <StatusCard title="Balance evidence" value={balance} />
      <StatusCard title="Payment evidence" value={payment} />
    </div>
  );
}

function StatusCard({ title, value }: { title: string; value: string }) {
  return (
    <div className="bg-surface-container-low p-space-sm rounded">
      <p className="font-label-sm text-label-sm uppercase text-on-surface-variant">{title}</p>
      <p className="font-body-sm text-body-sm break-all">{value}</p>
    </div>
  );
}
