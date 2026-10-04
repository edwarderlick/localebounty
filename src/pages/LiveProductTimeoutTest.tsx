import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TransactionFeeEstimate } from "genlayer-js/types";
import { CopyButton } from "../components/CopyButton";
import { useWallet } from "../live/WalletContext";
import { WalletCard } from "../live/WalletCard";
import { isUserRejection } from "../live/eip1193";
import { extractFinalizedFee } from "../live/fees";
import { explorerAddress, explorerTx, feeDepositFigures, formatError, formatGen, jsonSafe } from "../live/format";
import {
  PRODUCT_SOURCE,
  createReadClient,
  createWriteClient,
  quoteMeetsStudioFloor,
  quoteWrite,
  readProductTask,
  readProductView,
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
  cachedGenvmUnix,
  clearRememberedGenvmLag,
  createDeadlinesFromGenvm,
  createSignNowUnix,
  discoverGenvmUnix,
  genvmNowForSession,
  rememberGenvmLag,
} from "../live/product/clock";
import { HISTORICAL_PROBE_PAYOUT_FEE_NOTE } from "../live/product/constants";
import { applySourceComparison, compareLocalToDeployed, invalidateStaleSourceMatch, unverifiedSource } from "../live/product/source";
import { createTaskArgs, genRewardError, parseProductTask } from "../live/product/task";
import { sha256Utf8 } from "../live/product/taskId";
import { clearStaleGetTaskErrors, errorAfterSuccessfulRefresh } from "../live/product/staleErrors";
import { collectTransferEvidence, enrichCancelRefundTransfer, preserveEnrichedTransfer } from "../live/product/transfers";
import {
  TIMEOUT_APP_CONTEXT,
  TIMEOUT_CONTRACT_ADDRESS,
  TIMEOUT_INTENDED_MEANING,
  TIMEOUT_SEMANTIC_CRITERIA,
  TIMEOUT_SOURCE_LOCALE,
  TIMEOUT_SOURCE_TEXT,
  TIMEOUT_STRING_KEY,
  TIMEOUT_SUGGESTED_TRANSLATION,
  TIMEOUT_TARGET_LOCALE,
  STATE_SUBMITTED,
  type TimeoutActionName,
} from "../live/productTimeout/constants";
import { timeoutDeadlineStatusFromError, makeTimeoutCreateDeadlineProbe } from "../live/productTimeout/createClock";
import { PAYOUT_SUBMITTED_IS_NOT_PAYMENT } from "../live/product/evidence";
import { buildTimeoutEvidencePayload, evaluateSettlement, feeFromAction, overallTimeoutVerdict } from "../live/productTimeout/evidence";
import {
  asB1Session,
  b1SessionRewardWei,
  bindB1CreateEstimateIdentity,
  connectedB1Role,
  deadlinesStale,
  hasTxId,
  isTerminalFailure,
  needsB1TxResume,
  neverResubmit,
  retryFailedTimeoutAction,
  timeoutActionEstimateAllowed,
  timeoutActionSignAllowed,
  timeoutClearRisk,
  type B1WriteContext,
} from "../live/productTimeout/guards";
import { parseLibraryEntry, parseLibraryVersionCount } from "../live/productB1/library";
import {
  bindTimeoutFunder,
  bindTimeoutTranslator,
  clearTimeoutSession,
  invalidateTimeoutUnsignedQuotes,
  loadTimeoutSession,
  resetTimeoutTransientPhases,
  saveTimeoutSession,
  withTimeoutAction,
  type TimeoutActionRecord,
  type TimeoutSession,
} from "../live/productTimeout/persist";
import { recoveryClockView } from "../live/productTimeout/recoverClock";
import { b1QuoteInvalidReason, b1QuoteStillValid, currentB1QuoteBinding } from "../live/productB1/quotes";

type QuoteMap = Partial<Record<TimeoutActionName, TransactionFeeEstimate>>;

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

function createArgsFromSession(session: TimeoutSession, translator: string) {
  return createTaskArgs({
    clientNonce: session.clientNonce ?? "",
    translator,
    submitByUnix: session.submitByUnix ?? 0,
    recoverAfterUnix: session.recoverAfterUnix ?? 0,
    sourceText: TIMEOUT_SOURCE_TEXT,
    sourceLocale: TIMEOUT_SOURCE_LOCALE,
    targetLocale: TIMEOUT_TARGET_LOCALE,
    stringKey: TIMEOUT_STRING_KEY,
    appContext: TIMEOUT_APP_CONTEXT,
    intendedMeaning: TIMEOUT_INTENDED_MEANING,
    semanticCriteria: TIMEOUT_SEMANTIC_CRITERIA,
  });
}

async function bindCreateClockAndNonce(
  session: TimeoutSession,
  input: { funder: string; translator: string; value: bigint; from: `0x${string}`; forceDiscover?: boolean },
): Promise<TimeoutSession> {
  let genvmNow = input.forceDiscover ? undefined : cachedGenvmUnix(session);
  if (genvmNow == null) {
    genvmNow = await discoverGenvmUnix(
      makeTimeoutCreateDeadlineProbe({
        address: session.address as `0x${string}`,
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
  const bound = await bindB1CreateEstimateIdentity(asB1Session(session), { funder: input.funder, nowUnix: signNow.nowUnix });
  const { evaluate: _ignored, ...rest } = bound;
  return { ...rest, genvmLagSeconds: lag, createDeadlineClock: signNow.clock };
}

export function LiveProductTimeoutTest() {
  const wallet = useWallet();
  const [session, setSession] = useState<TimeoutSession>(() => loadTimeoutSession());
  const [sourceRechecked, setSourceRechecked] = useState(false);
  const [clearPrompt, setClearPrompt] = useState(false);
  const [evidenceExported, setEvidenceExported] = useState(false);
  const quotes = useRef<QuoteMap>({});
  const resumeOnce = useRef(false);

  const persist = useCallback((next: TimeoutSession) => {
    saveTimeoutSession(next);
    return next;
  }, []);

  const update = useCallback((mutator: (current: TimeoutSession) => TimeoutSession) => {
    setSession((current) => persist(mutator(current)));
  }, [persist]);

  const [, setTick] = useState(0);
  const rewardWei = b1SessionRewardWei(asB1Session(session));
  const role = connectedB1Role(asB1Session(session), wallet.address);
  const writeCtx: B1WriteContext = { wallet: wallet.address, chainId: wallet.chainId, connected: wallet.connected };
  const nowUnix = createSignNowUnix(genvmNowForSession(session), Math.floor(Date.now() / 1000)).nowUnix;
  const recoverClock = recoveryClockView(session.task?.recovery_opens_at_unix, nowUnix);
  const overall = overallTimeoutVerdict(session);

  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  const evidence = useMemo(() => {
    try {
      return buildTimeoutEvidencePayload({ wallet: wallet.address, chainId: wallet.chainId, session });
    } catch (err) {
      return JSON.stringify({ error: formatError(err), live_result: "UNPROVEN" }, null, 2);
    }
  }, [wallet.address, wallet.chainId, session]);

  useEffect(() => {
    setSession((current) => persist(resetTimeoutTransientPhases(current)));
    void sha256Utf8(PRODUCT_SOURCE).then((hash) => {
      update((current) => invalidateStaleSourceMatch(current, hash));
    });
  }, [persist, update]);

  useEffect(() => {
    setSession((current) => {
      const next = invalidateTimeoutUnsignedQuotes(current);
      quotes.current = {};
      saveTimeoutSession(next);
      return next;
    });
  }, [wallet.address, wallet.chainId, session.translator, session.translation, session.rewardGen, session.clientNonce]);

  const applySummary = useCallback(
    (name: TimeoutActionName, summary: TxSummary) => {
      update((current) => withTimeoutAction(current, name, applyTxSummaryToAction(current[name], summary)));
    },
    [update],
  );

  const verifySource = useCallback(async () => {
    const address = TIMEOUT_CONTRACT_ADDRESS;
    const localSha256 = await sha256Utf8(PRODUCT_SOURCE);
    try {
      const raw = await rpcGetContractCode(address);
      const compared = await compareLocalToDeployed(PRODUCT_SOURCE, raw);
      update((current) => applySourceComparison({ ...current, address }, compared, address));
      return compared;
    } catch (err) {
      const failed = unverifiedSource(
        localSha256,
        `Source match is UNPROVEN: ${formatError(err)} Create stays disabled until gen_getContractCode matches localebounty.py.`,
      );
      update((current) => applySourceComparison({ ...current, address }, failed, address));
      return failed;
    }
  }, [update]);

  const refreshLibrary = useCallback(async (stored: TimeoutSession) => {
    try {
      const countRaw = await readProductView(createReadClient(), stored.address, "library_version_count", [
        TIMEOUT_STRING_KEY,
        TIMEOUT_TARGET_LOCALE,
      ]);
      const count = parseLibraryVersionCount(countRaw);
      let entry = undefined;
      if (count && count > 0) {
        const raw = jsonSafe(
          await readProductView(createReadClient(), stored.address, "get_library_entry", [TIMEOUT_STRING_KEY, TIMEOUT_TARGET_LOCALE, count]),
        );
        entry = parseLibraryEntry(raw);
      }
      return { count, entry };
    } catch {
      return { count: stored.libraryCountAfter, entry: stored.libraryEntry };
    }
  }, []);

  const refreshTask = useCallback(async () => {
    const stored = loadTimeoutSession();
    if (!stored.expectedTaskId) return undefined;
    try {
      const raw = jsonSafe(await readProductTask(createReadClient(), stored.address, stored.expectedTaskId));
      const parsed = parseProductTask(raw);
      const library = await refreshLibrary(stored);
      update((current) => ({
        ...clearStaleGetTaskErrors(current),
        task: parsed,
        libraryCountBefore: current.libraryCountBefore ?? library.count,
        libraryCountAfter: library.count,
        libraryEntry: library.entry,
      }));
      return parsed;
    } catch (err) {
      update((current) => withTimeoutAction(current, "create", { error: `get_task failed: ${formatError(err)}` }));
      return undefined;
    }
  }, [refreshLibrary, update]);

  const settlementRecipient = useCallback((stored: TimeoutSession) => stored.boundFunder ?? "", []);

  const enrichSettlement = useCallback(
    async (parentReceipt: unknown, txId: string, recipient: string) => {
      const stored = loadTimeoutSession();
      const reward = b1SessionRewardWei(asB1Session(stored));
      if (!recipient || reward == null) return collectTransferEvidence(parentReceipt, txId);
      return enrichCancelRefundTransfer({
        parentReceipt,
        parentTxId: txId,
        contract: stored.address,
        funder: recipient,
        rewardWei: reward.toString(),
        fetchTx: rpcGetTransaction,
        listAddressTxs: rpcGetTransactionsForAddress,
      });
    },
    [],
  );

  const refreshSettlementReceipts = useCallback(
    async (name: "recover") => {
      const stored = loadTimeoutSession();
      const txId = stored[name].txId;
      if (!txId) return;
      let parentReceipt = stored[name].receipt;
      let receiptError: string | undefined;
      try {
        parentReceipt = await rpcGetTransaction(txId);
      } catch (err) {
        receiptError = `eth_getTransactionByHash failed while refreshing ${name} ${txId}: ${formatError(err)} Existing tx ID is kept. Not resubmitting.`;
      }
      const task = await refreshTask();
      const recipient = stored.boundFunder ?? "";
      const transfer = await enrichSettlement(parentReceipt, txId, recipient);
      const fee = extractFinalizedFee(parentReceipt);
      update((current) =>
        withTimeoutAction(
          { ...current, transfer },
          name,
          {
            txId,
            receipt: parentReceipt ?? current[name].receipt,
            statusName: receiptStatusName(parentReceipt, current[name].statusName),
            executionName: receiptExecutionName(parentReceipt, current[name].executionName),
            parentSuccessful:
              current[name].parentSuccessful ||
              (receiptStatusName(parentReceipt) === "FINALIZED" &&
                receiptExecutionName(parentReceipt) === "FINISHED_WITH_RETURN"),
            error: errorAfterSuccessfulRefresh({
              receiptError,
              getTaskOk: Boolean(task),
              getTaskError: current[name].error,
            }),
            ...(fee.available
              ? { actualFeeWei: fee.feeWei?.toString(), actualFeeSource: fee.source, actualFeeAvailable: true }
              : {}),
          },
        ),
      );
    },
    [enrichSettlement, refreshTask, update],
  );

  const trackExisting = useCallback(
    async (name: TimeoutActionName, txId: string) => {
      update((current) => withTimeoutAction(current, name, { phase: "waiting", txId, error: undefined }));
      try {
        const summary = await watchTx(createReadClient(), txId, (partial) => applySummary(name, partial));
        applySummary(name, summary);
        if (name === "create" || name === "submit") await refreshTask();
        if (name === "recover") {
          const stored = loadTimeoutSession();
          const recipient = settlementRecipient(stored);
          const transfer = await enrichSettlement(summary.receipt, txId, recipient);
          await refreshTask();
          update((current) => ({
            ...current,
            transfer: preserveEnrichedTransfer(transfer, collectTransferEvidence(summary.receipt, txId)),
            [name]: { ...current[name], error: undefined },
          }));
        }
        return summary;
      } catch (err) {
        update((current) =>
          withTimeoutAction(current, name, {
            phase: "waiting",
            txId,
            error: `Wait timed out or RPC failed while tracking ${txId}. Not resubmitting. ${formatError(err)}`,
          }),
        );
        return null;
      }
    },
    [applySummary, enrichSettlement, refreshTask, settlementRecipient, update],
  );

  const pollPayment = useCallback(async () => {
    const stored0 = loadTimeoutSession();
    if (stored0.recover.txId) await refreshSettlementReceipts("recover");
    const stored = loadTimeoutSession();
    const funder = stored.boundFunder;
    const named = stored.boundTranslator;
    const reward = b1SessionRewardWei(asB1Session(stored));
    const settleName: "recover" | undefined = stored.recover.txId ? "recover" : undefined;
    if (!funder || !named || reward == null || !settleName) return;
    const before = stored.beforeRecover;
    if (!before) {
      update((current) => ({
        ...current,
        paymentEvidence: "UNPROVEN",
        paymentReason: `Cannot prove an EOA delta: no before-settlement balances were stored. ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`,
      }));
      return;
    }
    const deadline = Date.now() + EXTERNAL_WAIT_MS;
    const samples: EoaBalances[] = [];
    let last = await readEoaBalances({ funder, named, contract: stored.address });
    samples.push(last);
    while (true) {
      const live = loadTimeoutSession();
      const action = live[settleName];
      const evalResult = evaluateSettlement({
        parentSuccessful: Boolean(action.parentSuccessful),
        statusName: action.statusName,
        executionName: action.executionName,
        parentTxId: action.txId,
        rewardWei: reward,
        recipient: funder,
        otherParty: named,
        otherMustNotGain: true,
        transfer: live.transfer,
        before,
        after: last,
        actualFee: feeFromAction(action),
        recipientIsFunder: true,
      });
      if (evalResult.verdict === "YES") {
        update((current) => ({
          ...current,
          afterWait: last,
          waitSamples: samples,
          paymentEvidence: "YES",
          paymentReason: evalResult.reason,
        }));
        return;
      }
      if (Date.now() >= deadline) {
        update((current) => ({
          ...current,
          afterWait: last,
          waitSamples: samples,
          paymentEvidence: "UNPROVEN",
          paymentReason: `${evalResult.reason} ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`,
        }));
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, EXTERNAL_POLL_MS));
      last = await readEoaBalances({ funder, named, contract: stored.address });
      samples.push(last);
    }
  }, [refreshSettlementReceipts, update]);

  const resumeAll = useCallback(async () => {
    const stored = loadTimeoutSession();
    for (const name of ["create", "submit", "recover"] as TimeoutActionName[]) {
      if (stored[name].txId && needsB1TxResume(stored[name])) {
        await trackExisting(name, stored[name].txId!);
      }
    }
    await verifySource();
    if (loadTimeoutSession().expectedTaskId) await refreshTask();
    if (loadTimeoutSession().recover.txId) await pollPayment();
    setSourceRechecked(true);
  }, [pollPayment, refreshTask, trackExisting, verifySource]);

  useEffect(() => {
    if (resumeOnce.current) return;
    resumeOnce.current = true;
    void resumeAll();
  }, [resumeAll]);

  async function quoteNamedWrite(name: TimeoutActionName, from: `0x${string}`, value: bigint): Promise<TransactionFeeEstimate> {
    const latest = loadTimeoutSession();
    let args: unknown[];
    if (name === "create") {
      if (latest.createDeadlineClock === "utc") {
        const genvmNow = cachedGenvmUnix(latest) ?? genvmNowForSession(latest);
        const sim = createDeadlinesFromGenvm(genvmNow);
        args = createTaskArgs({
          clientNonce: latest.clientNonce ?? `fee-sim-${sim.submitByUnix}`,
          translator: (latest.boundTranslator ?? latest.translator).trim(),
          submitByUnix: sim.submitByUnix,
          recoverAfterUnix: sim.recoverAfterUnix,
          sourceText: TIMEOUT_SOURCE_TEXT,
          sourceLocale: TIMEOUT_SOURCE_LOCALE,
          targetLocale: TIMEOUT_TARGET_LOCALE,
          stringKey: TIMEOUT_STRING_KEY,
          appContext: TIMEOUT_APP_CONTEXT,
          intendedMeaning: TIMEOUT_INTENDED_MEANING,
          semanticCriteria: TIMEOUT_SEMANTIC_CRITERIA,
        });
      } else {
        args = createArgsFromSession(latest, (latest.boundTranslator ?? latest.translator).trim());
      }
    } else if (name === "submit") {
      args = [latest.expectedTaskId, latest.boundTranslation ?? latest.translation.trim()];
    } else {
      args = [latest.expectedTaskId];
    }
    const functionName =
      name === "create" ? "create_task" : name === "submit" ? "submit_translation" : "recover_undecided_task";
    return quoteWrite({
      address: latest.address as `0x${string}`,
      functionName,
      args,
      value,
      from,
    });
  }

  async function prepareAction(name: TimeoutActionName) {
    const failOnCard = (error: string) => update((current) => withTimeoutAction(current, name, { phase: "idle", error }));
    try {
      const live = loadTimeoutSession();
      if (hasTxId(live[name])) {
        failOnCard(`Transaction ID ${live[name].txId} already exists. Resume tracking; not estimating a resubmit.`);
        return;
      }
      const identity = await wallet.verifyBeforeWrite();
      const ctx: B1WriteContext = { wallet: identity.address, chainId: identity.chainId, connected: true };
      const allowed = timeoutActionEstimateAllowed(name, loadTimeoutSession(), ctx, nowUnix);
      if (!allowed.ok) {
        failOnCard(allowed.reason);
        return;
      }
      const value = name === "create" ? b1SessionRewardWei(asB1Session(loadTimeoutSession())) ?? 0n : 0n;
      update((current) => withTimeoutAction(current, name, { phase: "quoting", error: undefined }));
      let working = loadTimeoutSession();
      if (name === "create") {
        working = persist(
          await bindCreateClockAndNonce(working, {
            funder: identity.address,
            translator: (working.boundTranslator ?? working.translator).trim(),
            value,
            from: identity.address,
          }),
        );
        setSession(working);
      }
      if (name === "submit") {
        update((current) => ({ ...current, boundTranslation: current.translation.trim() }));
      }
      let estimate: TransactionFeeEstimate;
      try {
        estimate = await quoteNamedWrite(name, identity.address, value);
      } catch (err) {
        if (name === "create") {
          const status = timeoutDeadlineStatusFromError(err);
          if (status === "far" || status === "past" || status === "early") {
            clearRememberedGenvmLag();
            working = persist(
              await bindCreateClockAndNonce(
                { ...loadTimeoutSession(), genvmLagSeconds: undefined },
                {
                  funder: identity.address,
                  translator: (loadTimeoutSession().boundTranslator ?? loadTimeoutSession().translator).trim(),
                  value,
                  from: identity.address,
                  forceDiscover: true,
                },
              ),
            );
            setSession(working);
            estimate = await quoteNamedWrite(name, identity.address, value);
          } else {
            throw err;
          }
        } else {
          throw err;
        }
      }
      const latest = loadTimeoutSession();
      const binding = currentB1QuoteBinding({
        wallet: identity.address,
        chainId: identity.chainId,
        contract: latest.address,
        translator: (latest.boundTranslator ?? latest.translator).trim(),
        method: name,
        valueWei: value.toString(),
        clientNonce: latest.clientNonce,
        submitByUnix: latest.submitByUnix,
        recoverAfterUnix: latest.recoverAfterUnix,
        taskId: latest.expectedTaskId,
        translation: latest.boundTranslation ?? latest.translation.trim(),
      });
      quotes.current[name] = estimate;
      update((current) =>
        withTimeoutAction(current, name, {
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

  async function signAction(name: TimeoutActionName) {
    const existing = loadTimeoutSession()[name];
    if (neverResubmit(existing) === "resume") {
      if (existing.txId) await trackExisting(name, existing.txId);
      if (name === "recover") await pollPayment();
      return;
    }
    const identity = await wallet.verifyBeforeWrite();
    let live = loadTimeoutSession();
    const ctx: B1WriteContext = { wallet: identity.address, chainId: identity.chainId, connected: true };
    const allowed = timeoutActionSignAllowed(name, live, ctx, nowUnix);
    if (!allowed.ok) {
      update((current) => withTimeoutAction(current, name, { error: allowed.reason }));
      return;
    }
    if (
      name === "create" &&
      deadlinesStale(live.submitByUnix, live.createDeadlineClock === "utc" ? Math.floor(Date.now() / 1000) : genvmNowForSession(live))
    ) {
      quotes.current.create = undefined;
      update((current) =>
        withTimeoutAction(current, name, {
          phase: "idle",
          quotedBinding: undefined,
          quotedFeeWei: undefined,
          error: "Create deadlines are too close to expiry. Estimate again.",
        }),
      );
      return;
    }
    const value = name === "create" ? b1SessionRewardWei(asB1Session(live)) ?? 0n : 0n;
    const currentBinding = currentB1QuoteBinding({
      wallet: identity.address,
      chainId: identity.chainId,
      contract: live.address,
      translator: (live.boundTranslator ?? live.translator).trim(),
      method: name,
      valueWei: value.toString(),
      clientNonce: live.clientNonce,
      submitByUnix: live.submitByUnix,
      recoverAfterUnix: live.recoverAfterUnix,
      taskId: live.expectedTaskId,
      translation: live.boundTranslation ?? live.translation.trim(),
    });
    if (!b1QuoteStillValid(live[name].quotedBinding, currentBinding)) {
      quotes.current[name] = undefined;
      update((current) =>
        withTimeoutAction(current, name, {
          phase: "idle",
          quotedBinding: undefined,
          quotedFeeWei: undefined,
          error: b1QuoteInvalidReason(live[name].quotedBinding, currentBinding),
        }),
      );
      return;
    }
    const estimate = quotes.current[name];
    if (!estimate) {
      update((current) =>
        withTimeoutAction(current, name, {
          error: "Estimate again before signing. Unsigned fee quotes are not reused after a reload, and a timeout never resubmits.",
        }),
      );
      return;
    }
    const floor = quoteMeetsStudioFloor(estimate);
    if (!floor.ok) {
      quotes.current[name] = undefined;
      update((current) => withTimeoutAction(current, name, { phase: "idle", error: floor.reason, quotedFeeWei: undefined, quotedBinding: undefined }));
      return;
    }
    if (wallet.balanceWei != null && wallet.balanceWei < estimate.feeValue + value) {
      update((current) =>
        withTimeoutAction(current, name, {
          error: `Insufficient GEN. Wallet has ${formatGen(wallet.balanceWei ?? 0n)}; this write needs ${formatGen(value)} attached plus ${formatGen(estimate.feeValue)} protocol fee.`,
        }),
      );
      return;
    }

    update((current) => withTimeoutAction(current, name, { phase: "signing", error: undefined }));
    try {
      const client = createWriteClient(identity.address, wallet.provider!);
      const named = (loadTimeoutSession().boundTranslator ?? loadTimeoutSession().translator).trim();
      const before = await readEoaBalances({ funder: loadTimeoutSession().boundFunder ?? identity.address, named, contract: live.address });
      if (name === "create") update((current) => ({ ...current, beforeCreate: before }));
      if (name === "submit") update((current) => ({ ...current, beforeSubmit: before }));
      if (name === "recover") {
        const library = await refreshLibrary(loadTimeoutSession());
        update((current) => ({ ...current, beforeRecover: before, libraryCountBefore: library.count }));
      }

      const latest = loadTimeoutSession();
      const functionName =
        name === "create" ? "create_task" : name === "submit" ? "submit_translation" : "recover_undecided_task";
      const args =
        name === "create"
          ? createArgsFromSession(latest, (latest.boundTranslator ?? latest.translator).trim())
          : name === "submit"
            ? [latest.expectedTaskId, latest.boundTranslation ?? latest.translation.trim()]
            : [latest.expectedTaskId];
      const txId = await submitWrite(client, {
        address: latest.address as `0x${string}`,
        functionName,
        args,
        value,
        estimate,
      });
      setSession((current) => {
        let bound = current;
        if (name === "create") {
          bound = bindTimeoutTranslator(bindTimeoutFunder(current, identity.address), (current.boundTranslator ?? current.translator).trim());
          bound = {
            ...bound,
            boundRewardWei: bound.boundRewardWei ?? value.toString(),
            boundRewardGen: bound.boundRewardGen ?? bound.rewardGen,
          };
        }
        const next = withTimeoutAction(bound, name, { phase: "submitted", txId, submittedAt: Date.now() });
        saveTimeoutSession(next);
        return next;
      });
      const summary = await trackExisting(name, txId);
      if (!summary) return;
      const after = await readEoaBalances({
        funder: loadTimeoutSession().boundFunder ?? identity.address,
        named,
        contract: loadTimeoutSession().address,
      });
      if (name === "create") update((current) => ({ ...current, afterCreate: after }));
      if (name === "submit") update((current) => ({ ...current, afterSubmit: after }));
      if (name === "recover") update((current) => ({ ...current, afterRecover: after }));
      if (name === "recover") {
        const latestAfter = loadTimeoutSession();
        const transfer = preserveEnrichedTransfer(
          latestAfter.transfer,
          collectTransferEvidence(summary.receipt, txId, b1SessionRewardWei(asB1Session(latestAfter))?.toString()),
        );
        update((current) => ({ ...current, transfer }));
        await pollPayment();
      }
      await wallet.refreshBalance();
    } catch (err) {
      if (isUserRejection(err)) {
        update((current) => withTimeoutAction(current, name, { phase: "rejected", error: "Wallet rejected the signature request. Nothing was submitted." }));
        return;
      }
      const still = loadTimeoutSession()[name];
      if (still.txId) {
        update((current) =>
          withTimeoutAction(current, name, {
            phase: "waiting",
            error: `A transaction ID already exists (${still.txId}). Tracking it instead of resubmitting. ${formatError(err)}`,
          }),
        );
        await trackExisting(name, still.txId);
        return;
      }
      update((current) => withTimeoutAction(current, name, { phase: "idle", error: formatError(err) }));
    }
  }

  const writesReady = Boolean(wallet.connected && wallet.onStudioDev && wallet.provider && wallet.address);
  const disabledReason = !writesReady
    ? wallet.connected
      ? `Wrong chain (${wallet.chainId ?? "unknown"}). Switch to Studio-dev ${STUDIO_DEV_CHAIN_ID}.`
      : "Connect a wallet first. Demo Owner / Demo Translator is not authorization."
    : !sourceRechecked
      ? "Rechecking gen_getContractCode against the existing product contract before writes are enabled."
      : undefined;
  const createGuard = disabledReason ? { ok: false as const, reason: disabledReason } : timeoutActionEstimateAllowed("create", session, writeCtx, nowUnix);
  const createSignGuard = disabledReason ? { ok: false as const, reason: disabledReason } : timeoutActionSignAllowed("create", session, writeCtx, nowUnix);
  const submitGuard = disabledReason ? { ok: false as const, reason: disabledReason } : timeoutActionEstimateAllowed("submit", session, writeCtx, nowUnix);
  const recoverGuard = disabledReason ? { ok: false as const, reason: disabledReason } : timeoutActionEstimateAllowed("recover", session, writeCtx, nowUnix);
  const recoverSignGuard = disabledReason ? { ok: false as const, reason: disabledReason } : timeoutActionSignAllowed("recover", session, writeCtx, nowUnix);
  const clearRisk = timeoutClearRisk(session);
  const rewardError = genRewardError(session.rewardGen);
  const paymentEval = evaluateSettlement({
    parentSuccessful: Boolean(session.recover.parentSuccessful),
    statusName: session.recover.statusName,
    executionName: session.recover.executionName,
    parentTxId: session.recover.txId,
    rewardWei: rewardWei ?? 0n,
    recipient: session.boundFunder ?? "",
    otherParty: session.boundTranslator ?? "",
    otherMustNotGain: true,
    transfer: session.transfer,
    before: session.beforeRecover,
    after: session.afterWait ?? session.afterRecover,
    actualFee: feeFromAction(session.recover),
    recipientIsFunder: true,
  });

  return (
    <div className="w-full px-gutter py-space-xl max-w-7xl mx-auto flex flex-col gap-space-xl">
      <section className="flex flex-col gap-space-sm">
        <div className="flex flex-wrap items-center gap-space-sm">
          <span className="inline-flex items-center gap-1 px-space-sm py-0.5 bg-secondary-container text-on-secondary-container font-label-sm text-label-sm uppercase tracking-wider rounded shadow-[2px_2px_0px_#00170b]">
            Live Product Test · Timeout recovery
          </span>
          <span className="inline-flex items-center gap-1 px-space-sm py-0.5 bg-tertiary-fixed text-on-tertiary-fixed font-label-sm text-label-sm uppercase tracking-wider rounded">
            Existing contract · no redeploy
          </span>
          <span className="inline-flex items-center gap-1 px-space-sm py-0.5 bg-error-container text-on-error-container font-label-sm text-label-sm uppercase tracking-wider rounded">
            Live result UNPROVEN
          </span>
        </div>
        <h1 className="font-display-lg text-display-lg-mobile md:text-display-lg text-primary tracking-tight leading-none uppercase">
          Timeout recovery
        </h1>
        <p className="font-body-lg text-body-lg text-on-surface-variant max-w-3xl">
          Reuses deployed <span className="font-mono">{TIMEOUT_CONTRACT_ADDRESS}</span>. Phase A/B1/B2 evidence stay in
          different browser keys. Public screens at <span className="font-mono">/</span> use a separate persist. This
          page never calls evaluate_task. Timeout YES is only a proven recover_undecided_task refund after
          recovery_opens_at_unix. Live timeout recovery is UNPROVEN until that wallet run finishes.
        </p>
        <p className="font-body-md text-body-md text-on-surface-variant max-w-3xl bg-surface-container-lowest px-space-md py-space-sm rounded">
          Switch wallets between steps. Funder creates a fresh-nonce task. Only the named translator submits. Wait until
          the contract recovery opening time, then the funder Estimates and explicitly Signs recover. Create and submit
          tx IDs persist if you close the browser. {HISTORICAL_PROBE_PAYOUT_FEE_NOTE}
        </p>
      </section>

      <WalletCard />

      <p className="font-body-sm text-body-sm">
        Connected role:{" "}
        <span className="font-label-sm text-label-sm uppercase">
          {role === "funder" ? "funder" : role === "translator" ? "named translator" : role === "unbound" ? "unbound (first create will bind funder)" : "other wallet — writes disabled"}
        </span>
      </p>

      <section className="bg-surface-container-low p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-md">
        <h2 className="font-title-lg text-title-lg text-primary uppercase">Existing contract source</h2>
        <a className="font-mono text-xs break-all text-secondary" href={explorerAddress(TIMEOUT_CONTRACT_ADDRESS)} target="_blank" rel="noreferrer">
          {TIMEOUT_CONTRACT_ADDRESS}
        </a>
        <p className="font-body-sm text-body-sm">{session.sourceVerifyReason}</p>
        <p className="font-body-sm text-body-sm">Match: {String(session.sourceMatch)} · {session.sourceVerifyStatus}</p>
        <button type="button" onClick={() => void verifySource()} className="self-start font-label-sm text-label-sm uppercase px-space-sm py-space-xs bg-surface-container-high rounded">
          Recheck gen_getContractCode
        </button>
      </section>

      <section className="bg-surface-container-low p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-md">
        <h2 className="font-title-lg text-title-lg text-primary uppercase">1. Funder creates a new task</h2>
        <p className="font-body-sm text-body-sm text-on-surface-variant">
          Source: “{TIMEOUT_SOURCE_TEXT}” ({TIMEOUT_SOURCE_LOCALE} → {TIMEOUT_TARGET_LOCALE}, key {TIMEOUT_STRING_KEY}).
        </p>
        <p className="font-body-sm text-body-sm text-on-surface-variant">Criteria: {TIMEOUT_SEMANTIC_CRITERIA}</p>
        <label className="flex flex-col gap-1">
          <span className="font-label-sm text-label-sm uppercase text-on-surface-variant">Named translator (second wallet you control)</span>
          <input
            value={session.translator}
            disabled={Boolean(session.boundTranslator) || Boolean(session.create.txId)}
            onChange={(event) => update((current) => ({ ...current, translator: event.target.value.trim() }))}
            className="font-mono px-space-sm py-space-xs bg-surface-container-lowest rounded"
            placeholder="0x…"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-label-sm text-label-sm uppercase text-on-surface-variant">Reward GEN (attached create value)</span>
          <input
            value={session.rewardGen}
            disabled={Boolean(session.create.txId)}
            onChange={(event) => update((current) => ({ ...current, rewardGen: event.target.value }))}
            className="font-mono px-space-sm py-space-xs bg-surface-container-lowest rounded"
            placeholder="0.5"
          />
        </label>
        {rewardError ? <p className="text-error font-body-sm text-body-sm">{rewardError}</p> : null}
        <ActionBlock
          title="create_task(…)"
          action={session.create}
          disabled={!createGuard.ok}
          disableReason={createGuard.ok ? undefined : createGuard.reason}
          signDisabled={!createSignGuard.ok}
          signDisableReason={createSignGuard.ok ? undefined : createSignGuard.reason}
          onPrepare={() => void prepareAction("create")}
          onSign={() => void signAction("create")}
          onRetry={() => update((current) => retryFailedTimeoutAction(current, "create"))}
          attachedWei={session.create.quotedValueWei ?? (rewardWei != null ? rewardWei.toString() : "0")}
          quotedFeeWei={session.create.quotedFeeWei}
        />
      </section>

      <section className="bg-surface-container-low p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-md">
        <h2 className="font-title-lg text-title-lg text-primary uppercase">2. get_task</h2>
        <button type="button" disabled={!session.expectedTaskId} onClick={() => void refreshTask()} className="self-start font-label-sm text-label-sm uppercase px-space-sm py-space-xs bg-surface-container-high rounded disabled:opacity-40">
          Refresh get_task
        </button>
        {session.task ? (
          <dl className="grid grid-cols-1 md:grid-cols-2 gap-space-sm font-body-sm text-body-sm">
            <Field label="task_id" value={session.task.task_id} />
            <Field label="state" value={session.task.state} />
            <Field label="decision" value={session.task.decision} />
            <Field label="translation" value={session.task.translation || "(empty)"} />
            <Field label="payout_submitted" value={String(session.task.payout_submitted)} />
            <Field label="recovery_opens_at_unix" value={String(session.task.recovery_opens_at_unix)} />
            <Field label="recovery local date" value={recoverClock.localDate} />
            <Field label="recovery countdown" value={recoverClock.countdownLabel} />
            <Field label="payment_kind" value={session.task.payment_kind || "(none)"} />
            <Field label="funder" value={session.task.funder} />
            <Field label="translator" value={session.task.translator} />
          </dl>
        ) : (
          <p className="font-body-sm text-body-sm text-on-surface-variant">No get_task snapshot yet.</p>
        )}
      </section>

      <section className="bg-surface-container-low p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-md">
        <h2 className="font-title-lg text-title-lg text-primary uppercase">3. Translator submits</h2>
        <p className="font-body-sm text-body-sm text-on-surface-variant">
          Switch the connected wallet to {session.boundTranslator ?? "the named translator"}. Only that account can
          estimate/sign submit_translation. Suggested text: “{TIMEOUT_SUGGESTED_TRANSLATION}”. Do not call evaluate_task.
        </p>
        <label className="flex flex-col gap-1">
          <span className="font-label-sm text-label-sm uppercase text-on-surface-variant">Spanish translation</span>
          <textarea
            value={session.translation}
            disabled={Boolean(session.submit.txId)}
            onChange={(event) => update((current) => ({ ...current, translation: event.target.value }))}
            className="font-body-sm min-h-24 px-space-sm py-space-xs bg-surface-container-lowest rounded"
            placeholder={TIMEOUT_SUGGESTED_TRANSLATION}
          />
        </label>
        <button
          type="button"
          disabled={Boolean(session.submit.txId)}
          onClick={() => update((current) => ({ ...current, translation: TIMEOUT_SUGGESTED_TRANSLATION }))}
          className="self-start font-label-sm text-label-sm uppercase px-space-sm py-space-xs bg-surface-container-high rounded disabled:opacity-40"
        >
          Use suggested translation
        </button>
        <ActionBlock
          title="submit_translation(task_id, translation)"
          action={session.submit}
          disabled={!submitGuard.ok}
          disableReason={submitGuard.ok ? undefined : submitGuard.reason}
          onPrepare={() => void prepareAction("submit")}
          onSign={() => void signAction("submit")}
          onRetry={() => update((current) => retryFailedTimeoutAction(current, "submit"))}
          attachedWei="0"
          quotedFeeWei={session.submit.quotedFeeWei}
        />
      </section>

      <section className="bg-surface-container-low p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-md">
        <h2 className="font-title-lg text-title-lg text-primary uppercase">4. Wait, then funder recovers</h2>
        <p className="font-body-sm text-body-sm text-on-surface-variant">
          This test never calls evaluate_task. Keep the task submitted until recovery_opens_at_unix. Close the browser if
          you need to; create and submit hashes stay in this page’s storage key.
        </p>
        <p className="font-body-sm text-body-sm">
          recovery_opens_at_unix={session.task?.recovery_opens_at_unix ?? "(unread)"} · local {recoverClock.localDate}
        </p>
        <p className="font-body-sm text-body-sm">{recoverClock.countdownLabel}</p>
        <p className="font-body-sm text-body-sm text-on-surface-variant">{recoverClock.gateLabel}</p>
        <ActionBlock
          title="recover_undecided_task(task_id)"
          action={session.recover}
          disabled={!recoverGuard.ok}
          disableReason={recoverGuard.ok ? undefined : recoverGuard.reason}
          signDisabled={!recoverSignGuard.ok}
          signDisableReason={recoverSignGuard.ok ? undefined : recoverSignGuard.reason}
          onPrepare={() => void prepareAction("recover")}
          onSign={() => void signAction("recover")}
          onRetry={() => update((current) => retryFailedTimeoutAction(current, "recover"))}
          attachedWei="0"
          quotedFeeWei={session.recover.quotedFeeWei}
        />
        {session.task?.state === STATE_SUBMITTED ? (
          <p className="font-body-sm text-body-sm">
            Task is still submitted. Stored tx IDs are kept and are not resubmitted.
          </p>
        ) : null}
        {session.recover.txId ? (
          <button type="button" onClick={() => void pollPayment()} className="self-start font-label-sm text-label-sm uppercase px-space-sm py-space-xs bg-tertiary-fixed text-on-tertiary-fixed rounded">
            Refresh balance evidence
          </button>
        ) : null}
      </section>

      <section className="bg-surface-container-lowest p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-md">
        <h2 className="font-title-lg text-title-lg text-primary uppercase">Evidence fields (kept separate)</h2>
        <StatusCard title="Transaction status" value={session.recover.statusName ?? session.submit.statusName ?? session.create.statusName ?? "none"} />
        <StatusCard title="Execution result" value={session.recover.executionName ?? session.submit.executionName ?? session.create.executionName ?? "none"} />
        <StatusCard title="Contract decision" value={`state=${session.task?.state ?? "none"} decision=${session.task?.decision ?? "none"} payment_kind=${session.task?.payment_kind || "none"}`} />
        <StatusCard title="Contract payout_submitted" value={`${String(session.task?.payout_submitted ?? false)}. ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`} />
        <StatusCard
          title="Library"
          value={`before ${session.libraryCountBefore ?? "unread"} / after ${session.libraryCountAfter ?? "unread"}${
            session.libraryEntry ? ` · v${session.libraryEntry.version} task ${session.libraryEntry.task_id}` : " · no entry for this read"
          }`}
        />
        <StatusCard title="Transfer delivery" value={paymentEval.transferLabel} />
        <StatusCard title="Balance evidence" value={paymentEval.balanceLabel} />
        <StatusCard title="Payment evidence" value={`${session.paymentEvidence} — ${session.paymentReason}`} />
      </section>

      <section className="bg-primary-container text-inverse-on-surface p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-md">
        <div className="flex flex-wrap items-end justify-between gap-space-md">
          <div>
            <p className="font-label-sm text-label-sm uppercase tracking-wider text-tertiary-fixed">Timeout-recovery live result</p>
            <h2 className="font-display-lg text-headline-lg uppercase">{overall.verdict}</h2>
            <p className="font-body-md text-body-md text-inverse-on-surface/80 max-w-3xl">{overall.reason}</p>
          </div>
          <CopyButton value={evidence} label="Copy evidence JSON" />
        </div>
        {clearPrompt ? (
          <div className="bg-surface-container-lowest text-on-surface p-space-md rounded flex flex-col gap-space-sm">
            <p className="font-body-sm text-body-sm">{clearRisk.reason}</p>
            <p className="font-mono text-xs break-all">Task ID: {clearRisk.taskId ?? "(none)"}</p>
            <p className="font-mono text-xs break-all">Create: {clearRisk.txIds.create ?? "(none)"}</p>
            <p className="font-mono text-xs break-all">Submit: {clearRisk.txIds.submit ?? "(none)"}</p>
            <p className="font-mono text-xs break-all">Recover: {clearRisk.txIds.recover ?? "(none)"}</p>
            <CopyButton value={evidence} label="Copy evidence JSON" onCopied={() => setEvidenceExported(true)} />
            <div className="flex flex-wrap gap-space-sm">
              <button
                type="button"
                disabled={!evidenceExported}
                className="font-label-sm text-label-sm uppercase px-space-sm py-space-xs bg-error-container text-on-error-container rounded disabled:opacity-40"
                onClick={() => {
                  quotes.current = {};
                  persist(clearTimeoutSession());
                  setClearPrompt(false);
                  setEvidenceExported(false);
                  setSourceRechecked(true);
                }}
              >
                I exported evidence — clear timeout tracking
              </button>
              <button type="button" className="font-label-sm text-label-sm uppercase text-on-surface-variant" onClick={() => setClearPrompt(false)}>
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
              persist(clearTimeoutSession());
              setSourceRechecked(true);
            }}
          >
            Clear timeout-recovery local tracking
          </button>
        )}
        <a className="font-body-sm text-body-sm text-tertiary-fixed underline" href={STUDIO_DEV_FAUCET} target="_blank" rel="noreferrer">
          Studio-dev faucet
        </a>
        <a className="font-body-sm text-body-sm text-tertiary-fixed underline" href={STUDIO_DEV_EXPLORER} target="_blank" rel="noreferrer">
          Studio-dev explorer
        </a>
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
}: {
  title: string;
  action: TimeoutActionRecord;
  disabled: boolean;
  disableReason?: string;
  signDisabled?: boolean;
  signDisableReason?: string;
  onPrepare: () => void;
  onSign: () => void;
  onRetry: () => void;
  attachedWei: string;
  quotedFeeWei?: string;
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
        <a className="font-mono text-xs break-all text-secondary" href={explorerTx(action.txId)} target="_blank" rel="noreferrer">
          tx {action.txId}
        </a>
      ) : null}
      {layers ? (
        <>
          <p className="font-body-sm text-body-sm text-on-surface-variant">{layers.walletNote}</p>
          <p className="font-body-sm text-body-sm">{layers.consensusNote}</p>
          <p className="font-body-sm text-body-sm">{layers.executionNote}</p>
        </>
      ) : null}
      {layers?.error || action.error ? <p className="text-error font-body-sm text-body-sm">{layers?.error ?? action.error}</p> : null}
      {disableReason && !resume ? <p className="font-body-sm text-body-sm text-on-surface-variant">{disableReason}</p> : null}
      {signDisableReason && !resume && action.quotedFeeWei ? (
        <p className="font-body-sm text-body-sm text-on-surface-variant">{signDisableReason}</p>
      ) : null}
      <div className="flex flex-wrap gap-space-xs">
        <button type="button" disabled={disabled || busy || resume} onClick={onPrepare} className="font-label-sm text-label-sm uppercase px-space-sm py-space-xs bg-surface-container-high rounded disabled:opacity-40">
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
          <button type="button" onClick={onRetry} className="font-label-sm text-label-sm uppercase px-space-sm py-space-xs bg-tertiary-fixed text-on-tertiary-fixed rounded shadow-[2px_2px_0px_#00170b]">
            New attempt
          </button>
        ) : null}
      </div>
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
