import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TransactionFeeEstimate } from "genlayer-js/types";
import { CopyButton } from "../components/CopyButton";
import { useWallet } from "../live/WalletContext";
import { WalletCard } from "../live/WalletCard";
import { isUserRejection } from "../live/eip1193";
import { extractFinalizedFee } from "../live/fees";
import {
  addressesEqual,
  explorerAddress,
  explorerTx,
  feeDepositFigures,
  formatError,
  formatGen,
  isEoaAddress,
  jsonSafe,
} from "../live/format";
import {
  PRODUCT_V2_SOURCE,
  createReadClient,
  createWriteClient,
  describeDeployBlocker,
  quoteDeploy,
  quoteMeetsStudioFloor,
  quoteWrite,
  readProductTask,
  submitProductV2Deploy,
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
  rpcGetBalance,
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
import { applySourceComparison, compareLocalToDeployed, invalidateStaleSourceMatch, unverifiedSource } from "../live/product/source";
import { genRewardError } from "../live/product/task";
import { sha256Utf8 } from "../live/product/taskId";
import { errorAfterSuccessfulRefresh } from "../live/product/staleErrors";
import { collectTransferEvidence, enrichCancelRefundTransfer, preserveEnrichedTransfer } from "../live/product/transfers";
import {
  BROWSER_FEE_QUOTE_NOTE,
  HISTORICAL_PROBE_PAYOUT_FEE_NOTE,
  LANE_A_APP_CONTEXT,
  LANE_A_INTENDED_MEANING,
  LANE_A_SEMANTIC_CRITERIA,
  LANE_A_SOURCE_TEXT,
  LANE_A_STRING_KEY,
  LANE_B_APP_CONTEXT,
  LANE_B_INTENDED_MEANING,
  LANE_B_LEAD_PRESETS,
  LANE_B_SEMANTIC_CRITERIA,
  LANE_B_SOURCE_TEXT,
  LANE_B_STRING_KEY,
  TEST_SOURCE_LOCALE,
  TEST_TARGET_LOCALE,
  V2_SOURCE_FILE,
  normalizeLaneBLeadSeconds,
  type ProductV2ActionName,
} from "../live/productV2/constants";
import { deadlineStatusFromError, makeV2CreateDeadlineProbe } from "../live/productV2/createClock";
import {
  PAYOUT_SUBMITTED_IS_NOT_PAYMENT,
  buildLaneAEvidencePayload,
  buildLaneBEvidencePayload,
  evaluateExpireRefund,
  feeFromAction,
  laneBRecoveryVerdict,
  overallLaneAVerdict,
  overallLaneBVerdict,
} from "../live/productV2/evidence";
import { acceptClockView, expireClockView, selectedLeadPreview } from "../live/productV2/expireClock";
import {
  acceptBAllowed,
  bindLaneCreateIdentity,
  cancelAAllowed,
  cancelBAllowed,
  connectedV2Role,
  createAEstimateAllowed,
  createASignAllowed,
  createBEstimateAllowed,
  createBSignAllowed,
  deadlinesStale,
  deployWriteAllowed,
  expireBAllowed,
  funderCancelAfterAcceptBlocked,
  hasTxId,
  isFinalizedSuccessful,
  isFinalizedWithReturn,
  isTerminalFailure,
  laneRewardWei,
  needsV2TxResume,
  neverResubmit,
  retryFailedV2Action,
  sourceAllowsV2Create,
  v2ActionEstimateAllowed,
  v2ActionSignAllowed,
  v2ClearRisk,
  type V2WriteContext,
} from "../live/productV2/guards";
import {
  bindV2Session,
  clearProductV2Session,
  invalidateQuotedV2Action,
  invalidateV2UnsignedQuotes,
  loadProductV2Session,
  resetProductV2TransientPhases,
  saveProductV2Session,
  withV2Action,
  type ProductV2ActionRecord,
  type ProductV2Session,
} from "../live/productV2/persist";
import { currentV2QuoteBinding, v2QuoteInvalidReason, v2QuoteStillValid } from "../live/productV2/quotes";
import { createV2TaskArgs, parseProductV2Task } from "../live/productV2/task";
import { evaluateCancelRefund } from "../live/product/evidence";
import { PRODUCT_UI_CONTRACT } from "../live/productUi/constants";

type QuoteMap = Partial<Record<ProductV2ActionName, TransactionFeeEstimate>>;
type Lane = "A" | "B";

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

function relabelV2SourceReason(reason: string): string {
  return reason.replaceAll("localebounty.py", "localebounty_v2.py").replaceAll("PRODUCT_SOURCE", "localebounty_v2.py");
}

function laneCopy(lane: Lane) {
  if (lane === "A") {
    return {
      sourceText: LANE_A_SOURCE_TEXT,
      sourceLocale: TEST_SOURCE_LOCALE,
      targetLocale: TEST_TARGET_LOCALE,
      stringKey: LANE_A_STRING_KEY,
      appContext: LANE_A_APP_CONTEXT,
      intendedMeaning: LANE_A_INTENDED_MEANING,
      semanticCriteria: LANE_A_SEMANTIC_CRITERIA,
    };
  }
  return {
    sourceText: LANE_B_SOURCE_TEXT,
    sourceLocale: TEST_SOURCE_LOCALE,
    targetLocale: TEST_TARGET_LOCALE,
    stringKey: LANE_B_STRING_KEY,
    appContext: LANE_B_APP_CONTEXT,
    intendedMeaning: LANE_B_INTENDED_MEANING,
    semanticCriteria: LANE_B_SEMANTIC_CRITERIA,
  };
}

function createArgsFromSession(session: ProductV2Session, lane: Lane, translator: string) {
  return createV2TaskArgs({
    clientNonce: (lane === "A" ? session.nonceA : session.nonceB) ?? "",
    translator,
    submitByUnix: (lane === "A" ? session.submitA : session.submitB) ?? 0,
    recoverAfterUnix: (lane === "A" ? session.recoverA : session.recoverB) ?? 0,
    ...laneCopy(lane),
  });
}

function writeCall(name: ProductV2ActionName, session: ProductV2Session, translator: string): { functionName: string; args: unknown[] } {
  if (name === "createA") return { functionName: "create_task", args: createArgsFromSession(session, "A", translator) };
  if (name === "createB") return { functionName: "create_task", args: createArgsFromSession(session, "B", translator) };
  if (name === "cancelA") return { functionName: "cancel_task", args: [session.taskIdA] };
  if (name === "cancelB") return { functionName: "cancel_task", args: [session.taskIdB] };
  if (name === "acceptB") return { functionName: "accept_task", args: [session.taskIdB] };
  return { functionName: "expire_unsubmitted_task", args: [session.taskIdB] };
}

function attachedValue(name: ProductV2ActionName, session: ProductV2Session): bigint {
  if (name === "createA") return laneRewardWei(session, "A") ?? 0n;
  if (name === "createB") return laneRewardWei(session, "B") ?? 0n;
  return 0n;
}

function executionClockUnix(session: ProductV2Session): number {
  const wall = Math.floor(Date.now() / 1000);
  const genvm = genvmNowForSession(
    { genvmLagSeconds: session.genvmLagSeconds, submitByUnix: session.submitB ?? session.submitA },
    wall,
  );
  return createSignNowUnix(genvm, wall).nowUnix;
}

async function bindCreateClockAndNonce(
  session: ProductV2Session,
  input: {
    funder: string;
    translator: string;
    address: string;
    value: bigint;
    from: `0x${string}`;
    lane: Lane;
    forceDiscover?: boolean;
  },
): Promise<ProductV2Session> {
  let genvmNow = input.forceDiscover ? undefined : cachedGenvmUnix(session);
  if (genvmNow == null) {
    genvmNow = await discoverGenvmUnix(
      makeV2CreateDeadlineProbe({
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
  const bound = await bindLaneCreateIdentity(session, { funder: input.funder, lane: input.lane, nowUnix: signNow.nowUnix });
  return { ...bound, genvmLagSeconds: lag, createDeadlineClock: signNow.clock };
}

async function quoteNamedWrite(name: ProductV2ActionName, from: `0x${string}`, value: bigint): Promise<TransactionFeeEstimate> {
  if (name === "deploy") return quoteDeploy();
  const latest = loadProductV2Session();
  if (!latest.address) throw new Error("Deploy localebounty_v2.py first.");
  const translator = latest.boundTranslator ?? latest.translator.trim();
  let args: unknown[];
  let functionName: string;
  if (name === "createA" || name === "createB") {
    functionName = "create_task";
    const lane: Lane = name === "createA" ? "A" : "B";
    if (latest.createDeadlineClock === "utc") {
      const genvmNow = cachedGenvmUnix(latest) ?? genvmNowForSession({ genvmLagSeconds: latest.genvmLagSeconds });
      const sim = createDeadlinesFromGenvm(genvmNow);
      const nonce = (lane === "A" ? latest.nonceA : latest.nonceB) ?? `fee-sim-${sim.submitByUnix}`;
      args = createV2TaskArgs({
        clientNonce: nonce,
        translator,
        submitByUnix: sim.submitByUnix,
        recoverAfterUnix: sim.recoverAfterUnix,
        ...laneCopy(lane),
      });
    } else {
      args = createArgsFromSession(latest, lane, translator);
    }
  } else {
    const call = writeCall(name, latest, translator);
    functionName = call.functionName;
    args = call.args;
  }
  return quoteWrite({
    address: latest.address as `0x${string}`,
    functionName,
    args,
    value,
    from,
  });
}

async function snapshotCallerWei(caller: string, funder: string, named: string, eoa: EoaBalances): Promise<string> {
  if (addressesEqual(caller, funder)) return eoa.funderWei;
  if (addressesEqual(caller, named)) return eoa.namedWei;
  return (await rpcGetBalance(caller)).toString();
}

export function LiveProductV2Test() {
  const wallet = useWallet();
  const [session, setSession] = useState<ProductV2Session>(() => resetProductV2TransientPhases(loadProductV2Session()));
  const quotes = useRef<QuoteMap>({});
  const resumeOnce = useRef(false);
  const [sourceRechecked, setSourceRechecked] = useState(false);
  const [clearPrompt, setClearPrompt] = useState(false);
  const [evidenceExported, setEvidenceExported] = useState(false);
  const [, setTick] = useState(0);

  const persist = useCallback((next: ProductV2Session) => {
    saveProductV2Session(next);
    setSession(next);
    return next;
  }, []);

  const update = useCallback((updater: (current: ProductV2Session) => ProductV2Session) => {
    setSession((current) => {
      const next = updater(current);
      saveProductV2Session(next);
      return next;
    });
  }, []);

  const translator = session.translator.trim();
  const rewardA = laneRewardWei(session, "A");
  const rewardB = laneRewardWei(session, "B");
  const rewardInputError = session.createA.txId && session.createB.txId ? undefined : genRewardError(session.rewardGen);
  const writeCtx: V2WriteContext = { wallet: wallet.address, chainId: wallet.chainId, connected: wallet.connected };
  const role = connectedV2Role(session, wallet.address);
  const nowUnix = executionClockUnix(session);
  const expireView = expireClockView(session.submitB, nowUnix);
  const acceptView = acceptClockView(session.submitB, nowUnix);
  const laneA = overallLaneAVerdict(session);
  const laneB = overallLaneBVerdict(session);
  const laneBRecovery = laneBRecoveryVerdict(session);
  const evidenceA = useMemo(() => {
    try {
      return buildLaneAEvidencePayload({ wallet: wallet.address, chainId: wallet.chainId, session });
    } catch (err) {
      return JSON.stringify({ error: formatError(err), live_result: "UNPROVEN" }, null, 2);
    }
  }, [wallet.address, wallet.chainId, session]);
  const evidenceB = useMemo(() => {
    try {
      return buildLaneBEvidencePayload({ wallet: wallet.address, chainId: wallet.chainId, session });
    } catch (err) {
      return JSON.stringify({ error: formatError(err), live_result: "UNPROVEN" }, null, 2);
    }
  }, [wallet.address, wallet.chainId, session]);

  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setSession((current) => {
      const next = resetProductV2TransientPhases(current);
      saveProductV2Session(next);
      return next;
    });
    void sha256Utf8(PRODUCT_V2_SOURCE).then((hash) => {
      if (cancelled) return;
      update((current) => {
        const next = invalidateStaleSourceMatch(current, hash);
        return { ...next, sourceVerifyReason: relabelV2SourceReason(next.sourceVerifyReason) };
      });
    });
    return () => {
      cancelled = true;
    };
  }, [update]);

  useEffect(() => {
    setSession((current) => {
      const next = invalidateV2UnsignedQuotes(current);
      if (
        next.deploy.quotedBinding === current.deploy.quotedBinding &&
        next.createA.quotedBinding === current.createA.quotedBinding &&
        next.cancelA.quotedBinding === current.cancelA.quotedBinding &&
        next.createB.quotedBinding === current.createB.quotedBinding &&
        next.cancelB.quotedBinding === current.cancelB.quotedBinding &&
        next.acceptB.quotedBinding === current.acceptB.quotedBinding &&
        next.expireB.quotedBinding === current.expireB.quotedBinding
      ) {
        return current;
      }
      quotes.current = {};
      saveProductV2Session(next);
      return next;
    });
  }, [
    wallet.address,
    wallet.chainId,
    translator,
    session.address,
    session.rewardGen,
    session.nonceA,
    session.nonceB,
    session.laneBLeadSeconds,
  ]);

  const applySummary = useCallback(
    (name: ProductV2ActionName, summary: TxSummary) => {
      update((current) => {
        const nextAction = applyTxSummaryToAction(current[name], summary);
        let next: ProductV2Session = { ...current, [name]: nextAction };
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

  const verifySource = useCallback(
    async (address: string) => {
      const localSha256 = await sha256Utf8(PRODUCT_V2_SOURCE);
      try {
        const raw = await rpcGetContractCode(address);
        const compared = await compareLocalToDeployed(PRODUCT_V2_SOURCE, raw);
        const labeled = { ...compared, reason: relabelV2SourceReason(compared.reason) };
        update((current) => applySourceComparison(current, labeled, address));
        return labeled;
      } catch (err) {
        const failed = unverifiedSource(
          localSha256,
          `Source match is UNPROVEN: ${formatError(err)} Create stays disabled until gen_getContractCode returns LocaleBounty source that hashes to the local localebounty_v2.py bytes.`,
        );
        update((current) => applySourceComparison(current, failed, address));
        return failed;
      }
    },
    [update],
  );

  const refreshTask = useCallback(
    async (lane: Lane) => {
      const stored = loadProductV2Session();
      const taskId = lane === "A" ? stored.taskIdA : stored.taskIdB;
      if (!stored.address || !taskId) return undefined;
      try {
        const raw = jsonSafe(await readProductTask(createReadClient(), stored.address, taskId));
        const parsed = parseProductV2Task(raw);
        update((current) =>
          lane === "A"
            ? { ...current, taskA: parsed, createA: { ...current.createA, snapshot: raw, error: undefined } }
            : { ...current, taskB: parsed, createB: { ...current.createB, snapshot: raw, error: undefined } },
        );
        return parsed;
      } catch (err) {
        update((current) =>
          withV2Action(current, lane === "A" ? "createA" : "createB", { error: `get_task failed: ${formatError(err)}` }),
        );
        return undefined;
      }
    },
    [update],
  );

  const enrichRefundTransfer = useCallback(async (parentReceipt: unknown, txId: string, lane: Lane) => {
    const stored = loadProductV2Session();
    const reward = laneRewardWei(stored, lane);
    const funder = stored.boundFunder ?? stored[lane === "A" ? "taskA" : "taskB"]?.funder ?? "";
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
  }, []);

  const refreshRefundReceipts = useCallback(
    async (name: "cancelA" | "cancelB" | "expireB") => {
      const stored = loadProductV2Session();
      const txId = stored[name].txId;
      if (!txId) return;
      let parentReceipt = stored[name].receipt;
      let receiptError: string | undefined;
      try {
        parentReceipt = await rpcGetTransaction(txId);
      } catch (err) {
        receiptError = `eth_getTransactionByHash failed while refreshing ${name} ${txId}: ${formatError(err)} Existing tx ID is kept. Not resubmitting.`;
      }
      const lane: Lane = name === "cancelA" ? "A" : "B";
      const transfer = await enrichRefundTransfer(parentReceipt, txId, lane);
      const task = await refreshTask(lane);
      const fee = extractFinalizedFee(parentReceipt);
      const transferPatch =
        name === "cancelA" ? { transferA: transfer } : name === "cancelB" ? { transferCancelB: transfer } : { transferB: transfer };
      update((current) =>
        withV2Action(
          {
            ...current,
            ...transferPatch,
          },
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
    [enrichRefundTransfer, refreshTask, update],
  );

  const trackExisting = useCallback(
    async (name: ProductV2ActionName, txId: string) => {
      update((current) => withV2Action(current, name, { phase: "waiting", txId, error: undefined }));
      try {
        const summary = await watchTx(createReadClient(), txId, (partial) => applySummary(name, partial));
        applySummary(name, summary);
        if (name === "deploy" && summary.parentSuccessful && (summary.contractAddress || loadProductV2Session().address)) {
          const address = summary.contractAddress ?? loadProductV2Session().address;
          if (address) await verifySource(address);
        }
        if (name === "createA" && summary.parentSuccessful) await refreshTask("A");
        if ((name === "createB" || name === "acceptB") && summary.parentSuccessful) await refreshTask("B");
        if (name === "cancelA") {
          const transfer = await enrichRefundTransfer(summary.receipt, txId, "A");
          const task = await refreshTask("A");
          update((current) => ({
            ...current,
            transferA: transfer,
            cancelA: {
              ...current.cancelA,
              error: errorAfterSuccessfulRefresh({
                getTaskOk: Boolean(task),
                getTaskError: current.cancelA.error,
              }),
            },
          }));
        }
        if (name === "cancelB") {
          const transfer = await enrichRefundTransfer(summary.receipt, txId, "B");
          const task = await refreshTask("B");
          update((current) => ({
            ...current,
            transferCancelB: transfer,
            cancelB: {
              ...current.cancelB,
              error: errorAfterSuccessfulRefresh({
                getTaskOk: Boolean(task),
                getTaskError: current.cancelB.error,
              }),
            },
          }));
        }
        if (name === "expireB") {
          const transfer = await enrichRefundTransfer(summary.receipt, txId, "B");
          const task = await refreshTask("B");
          update((current) => ({
            ...current,
            transferB: transfer,
            expireB: {
              ...current.expireB,
              error: errorAfterSuccessfulRefresh({
                getTaskOk: Boolean(task),
                getTaskError: current.expireB.error,
              }),
            },
          }));
        }
        return summary;
      } catch (err) {
        update((current) =>
          withV2Action(current, name, {
            phase: "waiting",
            txId,
            error: `Wait timed out or RPC failed while tracking ${txId}. Not resubmitting. ${formatError(err)}`,
          }),
        );
        return null;
      }
    },
    [applySummary, enrichRefundTransfer, refreshTask, update, verifySource],
  );

  const pollPaymentA = useCallback(async () => {
    await refreshRefundReceipts("cancelA");
    const stored = loadProductV2Session();
    const named = stored.boundTranslator ?? stored.translator;
    const funder = stored.boundFunder ?? wallet.address;
    const contract = stored.address;
    const reward = laneRewardWei(stored, "A");
    if (!funder || !contract || !isEoaAddress(named) || reward == null) return;
    const before = stored.beforeCancelA;
    if (!before) {
      update((current) => ({
        ...current,
        paymentA: "UNPROVEN",
        paymentAReason: `Cannot prove an EOA delta: no before-cancel balances were stored. Parent success is not payment. ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`,
      }));
      return;
    }
    const deadline = Date.now() + EXTERNAL_WAIT_MS;
    const samples: EoaBalances[] = [];
    let last = await readEoaBalances({ funder, named, contract });
    samples.push(last);
    while (true) {
      const live = loadProductV2Session();
      const evalResult = evaluateCancelRefund({
        parentSuccessful: Boolean(live.cancelA.parentSuccessful),
        statusName: live.cancelA.statusName,
        executionName: live.cancelA.executionName,
        parentTxId: live.cancelA.txId,
        rewardWei: reward,
        funder,
        named,
        transfer: live.transferA,
        before,
        after: last,
        actualFee: feeFromAction(live.cancelA),
      });
      if (evalResult.verdict === "YES") {
        update((current) => ({
          ...current,
          afterWaitA: last,
          waitSamplesA: samples,
          paymentA: "YES",
          paymentAReason: `${evalResult.reason} ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`,
        }));
        return;
      }
      if (Date.now() >= deadline) {
        update((current) => ({
          ...current,
          afterWaitA: last,
          waitSamplesA: samples,
          paymentA: "UNPROVEN",
          paymentAReason: `${evalResult.reason} payout_submitted=${String(live.taskA?.payout_submitted ?? false)}. ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`,
        }));
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, EXTERNAL_POLL_MS));
      last = await readEoaBalances({ funder, named, contract });
      samples.push(last);
    }
  }, [refreshRefundReceipts, update, wallet.address]);

  const pollPaymentB = useCallback(async () => {
    await refreshRefundReceipts("expireB");
    const stored = loadProductV2Session();
    const named = stored.boundTranslator ?? stored.translator;
    const funder = stored.boundFunder ?? stored.taskB?.funder;
    const caller = stored.expireCaller ?? wallet.address;
    const contract = stored.address;
    const reward = laneRewardWei(stored, "B");
    if (!funder || !contract || !isEoaAddress(named) || !caller || reward == null) return;
    const before = stored.beforeExpireB;
    if (!before || stored.beforeExpireCallerWei == null) {
      update((current) => ({
        ...current,
        paymentB: "UNPROVEN",
        paymentBReason: `Cannot prove an EOA delta: missing before-expire funder or caller balances. An emitted transfer alone is not paid. ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`,
      }));
      return;
    }
    const deadline = Date.now() + EXTERNAL_WAIT_MS;
    const samples: EoaBalances[] = [];
    let last = await readEoaBalances({ funder, named, contract });
    let lastCaller = await snapshotCallerWei(caller, funder, named, last);
    samples.push(last);
    while (true) {
      const live = loadProductV2Session();
      const evalResult = evaluateExpireRefund({
        parentSuccessful: Boolean(live.expireB.parentSuccessful),
        statusName: live.expireB.statusName,
        executionName: live.expireB.executionName,
        parentTxId: live.expireB.txId,
        rewardWei: reward,
        funder,
        translator: named,
        caller,
        transfer: live.transferB,
        beforeFunderWei: before.funderWei,
        afterFunderWei: last.funderWei,
        beforeNamedWei: before.namedWei,
        afterNamedWei: last.namedWei,
        beforeCallerWei: live.beforeExpireCallerWei,
        afterCallerWei: lastCaller,
        actualFee: feeFromAction(live.expireB),
      });
      const acceptedProof = isFinalizedWithReturn(live.acceptB) && (live.taskB?.accepted_at_unix ?? 0) > 0;
      if (evalResult.verdict === "YES") {
        if (acceptedProof) {
          update((current) => ({
            ...current,
            afterWaitB: last,
            waitSamplesB: samples,
            afterExpireCallerWei: lastCaller,
            paymentB: "YES",
            paymentBReason: `${evalResult.reason} ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`,
          }));
        } else {
          update((current) => ({
            ...current,
            afterWaitB: last,
            waitSamplesB: samples,
            afterExpireCallerWei: lastCaller,
            paymentB: "UNPROVEN",
            paymentBReason: `Unaccepted expire recovery is never Lane B YES. ${evalResult.reason} ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`,
            paymentBRecovery: "YES",
            paymentBRecoveryKind: "unaccepted_expire",
            paymentBRecoveryReason: `Unaccepted expire recovery: ${evalResult.reason} This is not Lane B YES. ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`,
          }));
        }
        return;
      }
      if (Date.now() >= deadline) {
        if (acceptedProof) {
          update((current) => ({
            ...current,
            afterWaitB: last,
            waitSamplesB: samples,
            afterExpireCallerWei: lastCaller,
            paymentB: "UNPROVEN",
            paymentBReason: `${evalResult.reason} payout_submitted=${String(live.taskB?.payout_submitted ?? false)}. ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`,
          }));
        } else {
          update((current) => ({
            ...current,
            afterWaitB: last,
            waitSamplesB: samples,
            afterExpireCallerWei: lastCaller,
            paymentB: "UNPROVEN",
            paymentBReason: `Unaccepted expire recovery is never Lane B YES. ${evalResult.reason} ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`,
            paymentBRecovery: "UNPROVEN",
            paymentBRecoveryKind: "unaccepted_expire",
            paymentBRecoveryReason: `${evalResult.reason} payout_submitted=${String(live.taskB?.payout_submitted ?? false)}. This is not Lane B YES. ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`,
          }));
        }
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, EXTERNAL_POLL_MS));
      last = await readEoaBalances({ funder, named, contract });
      lastCaller = await snapshotCallerWei(caller, funder, named, last);
      samples.push(last);
    }
  }, [refreshRefundReceipts, update, wallet.address]);

  const pollPaymentCancelB = useCallback(async () => {
    await refreshRefundReceipts("cancelB");
    const stored = loadProductV2Session();
    const named = stored.boundTranslator ?? stored.translator;
    const funder = stored.boundFunder ?? wallet.address;
    const contract = stored.address;
    const reward = laneRewardWei(stored, "B");
    if (!funder || !contract || !isEoaAddress(named) || reward == null) return;
    const before = stored.beforeCancelB;
    if (!before) {
      update((current) => ({
        ...current,
        paymentBRecovery: "UNPROVEN",
        paymentBRecoveryKind: "unaccepted_cancel",
        paymentBRecoveryReason: `Cannot prove an EOA delta: no before-cancel balances were stored. Parent success is not payment. Unaccepted cancel is never Lane B YES. ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`,
        paymentB: "UNPROVEN",
        paymentBReason: `Unaccepted cancel recovery is never Lane B YES. ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`,
      }));
      return;
    }
    const deadline = Date.now() + EXTERNAL_WAIT_MS;
    const samples: EoaBalances[] = [];
    let last = await readEoaBalances({ funder, named, contract });
    samples.push(last);
    while (true) {
      const live = loadProductV2Session();
      const evalResult = evaluateCancelRefund({
        parentSuccessful: Boolean(live.cancelB.parentSuccessful),
        statusName: live.cancelB.statusName,
        executionName: live.cancelB.executionName,
        parentTxId: live.cancelB.txId,
        rewardWei: reward,
        funder,
        named,
        transfer: live.transferCancelB,
        before,
        after: last,
        actualFee: feeFromAction(live.cancelB),
      });
      if (evalResult.verdict === "YES") {
        update((current) => ({
          ...current,
          afterWaitCancelB: last,
          waitSamplesCancelB: samples,
          paymentBRecovery: "YES",
          paymentBRecoveryKind: "unaccepted_cancel",
          paymentBRecoveryReason: `Unaccepted cancel recovery: ${evalResult.reason} This is not Lane B YES. ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`,
          paymentB: "UNPROVEN",
          paymentBReason: `Unaccepted cancel recovery is never Lane B YES. ${evalResult.reason} ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`,
        }));
        return;
      }
      if (Date.now() >= deadline) {
        update((current) => ({
          ...current,
          afterWaitCancelB: last,
          waitSamplesCancelB: samples,
          paymentBRecovery: "UNPROVEN",
          paymentBRecoveryKind: "unaccepted_cancel",
          paymentBRecoveryReason: `${evalResult.reason} payout_submitted=${String(live.taskB?.payout_submitted ?? false)}. This is not Lane B YES. ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`,
          paymentB: "UNPROVEN",
          paymentBReason: `Unaccepted cancel recovery is never Lane B YES. ${evalResult.reason} ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`,
        }));
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, EXTERNAL_POLL_MS));
      last = await readEoaBalances({ funder, named, contract });
      samples.push(last);
    }
  }, [refreshRefundReceipts, update, wallet.address]);

  const resumeAll = useCallback(async () => {
    const stored = loadProductV2Session();
    const names: ProductV2ActionName[] = ["deploy", "createA", "cancelA", "createB", "cancelB", "acceptB", "expireB"];
    for (const name of names) {
      const action = stored[name];
      const missingTask =
        (name === "createA" && action.txId && !stored.taskA) || (name === "createB" && action.txId && !stored.taskB);
      if (action.txId && (needsV2TxResume(action) || missingTask)) {
        await trackExisting(name, action.txId);
      }
    }
    const after = loadProductV2Session();
    if (after.address) await verifySource(after.address);
    if (isFinalizedSuccessful(after.createA) && !after.taskA) await refreshTask("A");
    if (isFinalizedSuccessful(after.createB) && !after.taskB) await refreshTask("B");
    if (isFinalizedSuccessful(after.acceptB) || isFinalizedSuccessful(after.cancelB)) await refreshTask("B");
    if (after.cancelA.txId) await pollPaymentA();
    if (after.cancelB.txId) await pollPaymentCancelB();
    if (after.expireB.txId) await pollPaymentB();
    setSourceRechecked(true);
  }, [pollPaymentA, pollPaymentB, pollPaymentCancelB, refreshTask, trackExisting, verifySource]);

  useEffect(() => {
    if (resumeOnce.current) return;
    resumeOnce.current = true;
    void resumeAll();
  }, [resumeAll]);

  async function prepareAction(name: ProductV2ActionName) {
    const failOnCard = (error: string) => {
      update((current) => withV2Action(current, name, { phase: "idle", error }));
    };
    try {
      const live = loadProductV2Session();
      if (hasTxId(live[name])) {
        failOnCard(`Transaction ID ${live[name].txId} already exists. Resume tracking; not estimating a resubmit.`);
        return;
      }
      const identity = await wallet.verifyBeforeWrite();
      const ctx: V2WriteContext = { wallet: identity.address, chainId: identity.chainId, connected: true };
      let working = loadProductV2Session();
      const clock = executionClockUnix(working);
      const allowed = v2ActionEstimateAllowed(name, working, ctx, clock, working.localSourceSha256);
      if (!allowed.ok) {
        failOnCard(allowed.reason);
        return;
      }
      const value = attachedValue(name, working);
      update((current) => withV2Action(current, name, { phase: "quoting", error: undefined }));
      if (name === "createA" || name === "createB") {
        const address = working.address;
        if (!address) throw new Error("Deploy localebounty_v2.py first.");
        working = persist(
          await bindCreateClockAndNonce(working, {
            funder: identity.address,
            translator: working.translator.trim(),
            address,
            value,
            from: identity.address,
            lane: name === "createA" ? "A" : "B",
          }),
        );
      }
      let estimate: TransactionFeeEstimate;
      try {
        estimate = await quoteNamedWrite(name, identity.address, value);
      } catch (err) {
        if (name === "createA" || name === "createB") {
          const status = deadlineStatusFromError(err);
          if (status === "far" || status === "past" || status === "early") {
            clearRememberedGenvmLag();
            const address = loadProductV2Session().address;
            if (!address) throw err;
            working = persist(
              await bindCreateClockAndNonce(
                { ...loadProductV2Session(), genvmLagSeconds: undefined },
                {
                  funder: identity.address,
                  translator: loadProductV2Session().translator.trim(),
                  address,
                  value,
                  from: identity.address,
                  lane: name === "createA" ? "A" : "B",
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
      const latest = loadProductV2Session();
      const binding = currentV2QuoteBinding({
        wallet: identity.address,
        chainId: identity.chainId,
        contract: latest.address,
        translator: latest.translator.trim(),
        method: name,
        valueWei: value.toString(),
        clientNonce: name === "createA" ? latest.nonceA : latest.nonceB,
        submitByUnix: name === "createA" ? latest.submitA : latest.submitB,
        recoverAfterUnix: name === "createA" ? latest.recoverA : latest.recoverB,
        taskId: name === "cancelA" ? latest.taskIdA : latest.taskIdB,
      });
      quotes.current[name] = estimate;
      update((current) =>
        withV2Action(current, name, {
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

  async function signAction(name: ProductV2ActionName) {
    const existing = loadProductV2Session()[name];
    if (neverResubmit(existing) === "resume") {
      if (existing.txId) await trackExisting(name, existing.txId);
      if (name === "cancelA") await pollPaymentA();
      if (name === "cancelB") await pollPaymentCancelB();
      if (name === "expireB") await pollPaymentB();
      return;
    }
    const identity = await wallet.verifyBeforeWrite();
    let live = loadProductV2Session();
    const ctx: V2WriteContext = { wallet: identity.address, chainId: identity.chainId, connected: true };
    const clock = executionClockUnix(live);
    if (
      (name === "createA" || name === "createB") &&
      deadlinesStale(
        name === "createA" ? live.submitA : live.submitB,
        live.createDeadlineClock === "utc" ? Math.floor(Date.now() / 1000) : genvmNowForSession({ genvmLagSeconds: live.genvmLagSeconds }),
      )
    ) {
      quotes.current[name] = undefined;
      update((current) =>
        withV2Action(current, name, {
          phase: "idle",
          quotedBinding: undefined,
          quotedFeeWei: undefined,
          error: "Create deadlines are too close to expiry. Estimate again to bind a fresh submission window.",
        }),
      );
      return;
    }
    const allowed = v2ActionSignAllowed(name, live, ctx, clock, live.localSourceSha256);
    if (!allowed.ok) {
      update((current) => withV2Action(current, name, { error: allowed.reason }));
      return;
    }
    const value = attachedValue(name, live);
    const currentBinding = currentV2QuoteBinding({
      wallet: identity.address,
      chainId: identity.chainId,
      contract: live.address,
      translator: live.translator.trim(),
      method: name,
      valueWei: value.toString(),
      clientNonce: name === "createA" ? live.nonceA : live.nonceB,
      submitByUnix: name === "createA" ? live.submitA : live.submitB,
      recoverAfterUnix: name === "createA" ? live.recoverA : live.recoverB,
      taskId: name === "cancelA" ? live.taskIdA : live.taskIdB,
    });
    if (!v2QuoteStillValid(live[name].quotedBinding, currentBinding)) {
      quotes.current[name] = undefined;
      update((current) =>
        withV2Action(current, name, {
          phase: "idle",
          quotedBinding: undefined,
          quotedFeeWei: undefined,
          error: v2QuoteInvalidReason(live[name].quotedBinding, currentBinding),
        }),
      );
      return;
    }
    const estimate = quotes.current[name];
    if (!estimate) {
      update((current) =>
        withV2Action(current, name, {
          error: "Estimate again before signing. Unsigned fee quotes are not reused after a reload, and a timeout never resubmits.",
        }),
      );
      return;
    }
    const floor = quoteMeetsStudioFloor(estimate);
    if (!floor.ok) {
      quotes.current[name] = undefined;
      update((current) =>
        withV2Action(current, name, {
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
        withV2Action(current, name, {
          error: `Insufficient GEN. Wallet has ${formatGen(wallet.balanceWei ?? 0n)}; this write needs ${formatGen(value)} attached plus ${formatGen(estimate.feeValue)} protocol fee.`,
        }),
      );
      return;
    }

    update((current) => withV2Action(current, name, { phase: "signing", error: undefined }));
    try {
      const client = createWriteClient(identity.address, wallet.provider!);
      if (name !== "deploy") {
        const named = live.boundTranslator ?? live.translator.trim();
        const funder =
          live.boundFunder ??
          (name === "createA" || name === "createB" || name === "cancelA" || name === "cancelB"
            ? identity.address
            : live.taskB?.funder ?? identity.address);
        const before = await readEoaBalances({ funder, named, contract: live.address });
        let beforeCaller: string | undefined;
        if (name === "expireB") {
          beforeCaller = await snapshotCallerWei(identity.address, funder, named, before);
        }
        update((current) => {
          if (name === "createA") return { ...current, beforeCreateA: before };
          if (name === "cancelA") return { ...current, beforeCancelA: before };
          if (name === "createB") return { ...current, beforeCreateB: before };
          if (name === "cancelB") return { ...current, beforeCancelB: before };
          if (name === "acceptB") return { ...current, beforeAcceptB: before };
          return { ...current, beforeExpireB: before, expireCaller: identity.address, beforeExpireCallerWei: beforeCaller };
        });
      }

      let txId: string;
      if (name === "deploy") {
        txId = await submitProductV2Deploy(client, estimate);
      } else {
        const address = loadProductV2Session().address;
        if (!address) throw new Error("Missing V2 contract address");
        const latest = loadProductV2Session();
        const call = writeCall(name, latest, latest.boundTranslator ?? latest.translator.trim());
        txId = await submitWrite(client, {
          address: address as `0x${string}`,
          functionName: call.functionName,
          args: call.args,
          value,
          estimate,
        });
      }

      setSession((current) => {
        let boundSession = bindV2Session(current, name === "acceptB" || name === "expireB" ? current.boundFunder ?? identity.address : identity.address, current.translator.trim());
        if (name === "createA") {
          boundSession = {
            ...boundSession,
            boundFunder: boundSession.boundFunder ?? identity.address,
            boundTranslator: boundSession.boundTranslator ?? boundSession.translator.trim(),
            boundRewardAWei: boundSession.boundRewardAWei ?? value.toString(),
          };
        }
        if (name === "createB") {
          boundSession = {
            ...boundSession,
            boundFunder: boundSession.boundFunder ?? identity.address,
            boundTranslator: boundSession.boundTranslator ?? boundSession.translator.trim(),
            boundRewardBWei: boundSession.boundRewardBWei ?? value.toString(),
          };
        }
        if (name === "expireB") {
          boundSession = { ...boundSession, expireCaller: boundSession.expireCaller ?? identity.address };
        }
        const next = withV2Action(boundSession, name, { phase: "submitted", txId, submittedAt: Date.now() });
        saveProductV2Session(next);
        return next;
      });
      const summary = await trackExisting(name, txId);
      if (!summary) return;
      const latest = loadProductV2Session();
      if (name !== "deploy" && latest.address) {
        const named = latest.boundTranslator ?? latest.translator.trim();
        const funder = latest.boundFunder ?? identity.address;
        const afterParent = await readEoaBalances({ funder, named, contract: latest.address });
        let afterCaller: string | undefined;
        if (name === "expireB") {
          afterCaller = await snapshotCallerWei(identity.address, funder, named, afterParent);
        }
        update((current) => {
          if (name === "createA") return { ...current, afterCreateA: afterParent };
          if (name === "cancelA") return { ...current, afterCancelA: afterParent };
          if (name === "createB") return { ...current, afterCreateB: afterParent };
          if (name === "cancelB") return { ...current, afterCancelB: afterParent };
          if (name === "acceptB") return { ...current, afterAcceptB: afterParent };
          return { ...current, afterExpireB: afterParent, afterExpireCallerWei: afterCaller };
        });
      }
      if (name === "cancelA") {
        const latestAfterTrack = loadProductV2Session();
        const transfer = preserveEnrichedTransfer(
          latestAfterTrack.transferA,
          collectTransferEvidence(summary.receipt, txId, laneRewardWei(latestAfterTrack, "A")?.toString()),
        );
        const evalNow = evaluateCancelRefund({
          parentSuccessful: Boolean(summary.parentSuccessful),
          statusName: summary.statusName,
          executionName: summary.executionName,
          parentTxId: txId,
          rewardWei: laneRewardWei(latestAfterTrack, "A") ?? 0n,
          funder: latestAfterTrack.boundFunder ?? identity.address,
          named: latestAfterTrack.boundTranslator ?? latestAfterTrack.translator,
          transfer,
          before: latestAfterTrack.beforeCancelA,
          after: latestAfterTrack.afterCancelA,
          actualFee: feeFromAction(latestAfterTrack.cancelA),
        });
        update((current) => ({
          ...current,
          transferA: transfer,
          paymentA: evalNow.verdict === "YES" ? "YES" : "UNPROVEN",
          paymentAReason: `${evalNow.reason} ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`,
        }));
        await pollPaymentA();
      }
      if (name === "cancelB") {
        const latestAfterTrack = loadProductV2Session();
        const transfer = preserveEnrichedTransfer(
          latestAfterTrack.transferCancelB,
          collectTransferEvidence(summary.receipt, txId, laneRewardWei(latestAfterTrack, "B")?.toString()),
        );
        const evalNow = evaluateCancelRefund({
          parentSuccessful: Boolean(summary.parentSuccessful),
          statusName: summary.statusName,
          executionName: summary.executionName,
          parentTxId: txId,
          rewardWei: laneRewardWei(latestAfterTrack, "B") ?? 0n,
          funder: latestAfterTrack.boundFunder ?? identity.address,
          named: latestAfterTrack.boundTranslator ?? latestAfterTrack.translator,
          transfer,
          before: latestAfterTrack.beforeCancelB,
          after: latestAfterTrack.afterCancelB,
          actualFee: feeFromAction(latestAfterTrack.cancelB),
        });
        update((current) => ({
          ...current,
          transferCancelB: transfer,
          paymentB: "UNPROVEN",
          paymentBReason: `Unaccepted cancel recovery is never Lane B YES. ${evalNow.reason} ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`,
          paymentBRecovery: evalNow.verdict === "YES" ? "YES" : "UNPROVEN",
          paymentBRecoveryKind: "unaccepted_cancel",
          paymentBRecoveryReason: `${evalNow.reason} This is not Lane B YES. ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`,
        }));
        await pollPaymentCancelB();
      }
      if (name === "expireB") {
        const latestAfterTrack = loadProductV2Session();
        const transfer = preserveEnrichedTransfer(
          latestAfterTrack.transferB,
          collectTransferEvidence(summary.receipt, txId, laneRewardWei(latestAfterTrack, "B")?.toString()),
        );
        const evalNow = evaluateExpireRefund({
          parentSuccessful: Boolean(summary.parentSuccessful),
          statusName: summary.statusName,
          executionName: summary.executionName,
          parentTxId: txId,
          rewardWei: laneRewardWei(latestAfterTrack, "B") ?? 0n,
          funder: latestAfterTrack.boundFunder ?? latestAfterTrack.taskB?.funder ?? "",
          translator: latestAfterTrack.boundTranslator ?? latestAfterTrack.translator,
          caller: latestAfterTrack.expireCaller ?? identity.address,
          transfer,
          beforeFunderWei: latestAfterTrack.beforeExpireB?.funderWei,
          afterFunderWei: latestAfterTrack.afterExpireB?.funderWei,
          beforeNamedWei: latestAfterTrack.beforeExpireB?.namedWei,
          afterNamedWei: latestAfterTrack.afterExpireB?.namedWei,
          beforeCallerWei: latestAfterTrack.beforeExpireCallerWei,
          afterCallerWei: latestAfterTrack.afterExpireCallerWei,
          actualFee: feeFromAction(latestAfterTrack.expireB),
        });
        const acceptedProof =
          isFinalizedWithReturn(latestAfterTrack.acceptB) && (latestAfterTrack.taskB?.accepted_at_unix ?? 0) > 0;
        if (acceptedProof) {
          update((current) => ({
            ...current,
            transferB: transfer,
            paymentB: evalNow.verdict === "YES" ? "YES" : "UNPROVEN",
            paymentBReason: `${evalNow.reason} ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`,
          }));
        } else {
          update((current) => ({
            ...current,
            transferB: transfer,
            paymentB: "UNPROVEN",
            paymentBReason: `Unaccepted expire recovery is never Lane B YES. ${evalNow.reason} ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`,
            paymentBRecovery: evalNow.verdict === "YES" ? "YES" : "UNPROVEN",
            paymentBRecoveryKind: "unaccepted_expire",
            paymentBRecoveryReason: `${evalNow.reason} This is not Lane B YES. ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`,
          }));
        }
        await pollPaymentB();
      }
      await wallet.refreshBalance();
    } catch (err) {
      if (isUserRejection(err)) {
        update((current) =>
          withV2Action(current, name, {
            phase: "rejected",
            error: "Wallet rejected the signature request. Nothing was submitted.",
          }),
        );
        return;
      }
      const still = loadProductV2Session()[name];
      if (still.txId) {
        update((current) =>
          withV2Action(current, name, {
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
        withV2Action(current, name, {
          phase: "idle",
          error: blocker,
          ...(budgetTooLow ? { quotedFeeWei: undefined, quotedValueWei: undefined, quotedBinding: undefined } : {}),
        }),
      );
    }
  }

  function retryAction(name: ProductV2ActionName) {
    quotes.current[name] = undefined;
    update((current) => retryFailedV2Action(current, name));
  }

  const writesReady = Boolean(wallet.connected && wallet.onStudioDev && wallet.provider && wallet.address);
  const disabledReason = !writesReady
    ? wallet.connected
      ? `Wrong chain (${wallet.chainId ?? "unknown"}). Switch to Studio-dev ${STUDIO_DEV_CHAIN_ID}.`
      : "Connect a wallet first. Demo Owner / Demo Translator is not authorization."
    : undefined;

  const sourceCreate = sourceAllowsV2Create(session, session.localSourceSha256);
  const deployGuard = disabledReason ? { ok: false as const, reason: disabledReason } : deployWriteAllowed(session, writeCtx);
  const createAGuard = disabledReason
    ? { ok: false as const, reason: disabledReason }
    : !sourceRechecked
      ? {
          ok: false as const,
          reason:
            "Rechecking gen_getContractCode against this contract address and the current localebounty_v2.py SHA-256 before create is enabled.",
        }
      : createAEstimateAllowed(session, writeCtx, session.localSourceSha256);
  const createASignGuard = disabledReason
    ? { ok: false as const, reason: disabledReason }
    : createASignAllowed(session, writeCtx, session.localSourceSha256);
  const cancelAGuard = disabledReason ? { ok: false as const, reason: disabledReason } : cancelAAllowed(session, writeCtx);
  const createBGuard = disabledReason
    ? { ok: false as const, reason: disabledReason }
    : !sourceRechecked
      ? {
          ok: false as const,
          reason:
            "Rechecking gen_getContractCode against this contract address and the current localebounty_v2.py SHA-256 before create is enabled.",
        }
      : createBEstimateAllowed(session, writeCtx, session.localSourceSha256);
  const createBSignGuard = disabledReason
    ? { ok: false as const, reason: disabledReason }
    : createBSignAllowed(session, writeCtx, session.localSourceSha256);
  const acceptBGuard = disabledReason ? { ok: false as const, reason: disabledReason } : acceptBAllowed(session, writeCtx, nowUnix);
  const expireBGuard = disabledReason ? { ok: false as const, reason: disabledReason } : expireBAllowed(session, writeCtx, nowUnix);
  const cancelBGuard = disabledReason ? { ok: false as const, reason: disabledReason } : cancelBAllowed(session, writeCtx);
  const cancelBBlocked = funderCancelAfterAcceptBlocked(session);
  const clearRisk = v2ClearRisk(session);

  const paymentEvalA = evaluateCancelRefund({
    parentSuccessful: Boolean(session.cancelA.parentSuccessful),
    statusName: session.cancelA.statusName,
    executionName: session.cancelA.executionName,
    parentTxId: session.cancelA.txId,
    rewardWei: rewardA ?? 0n,
    funder: session.boundFunder ?? wallet.address ?? "",
    named: session.boundTranslator ?? translator,
    transfer: session.transferA,
    before: session.beforeCancelA,
    after: session.afterWaitA ?? session.afterCancelA,
    actualFee: feeFromAction(session.cancelA),
  });
  const paymentEvalB = evaluateExpireRefund({
    parentSuccessful: Boolean(session.expireB.parentSuccessful),
    statusName: session.expireB.statusName,
    executionName: session.expireB.executionName,
    parentTxId: session.expireB.txId,
    rewardWei: rewardB ?? 0n,
    funder: session.boundFunder ?? session.taskB?.funder ?? "",
    translator: session.boundTranslator ?? translator,
    caller: session.expireCaller ?? "",
    transfer: session.transferB,
    beforeFunderWei: session.beforeExpireB?.funderWei,
    afterFunderWei: (session.afterWaitB ?? session.afterExpireB)?.funderWei,
    beforeNamedWei: session.beforeExpireB?.namedWei,
    afterNamedWei: (session.afterWaitB ?? session.afterExpireB)?.namedWei,
    beforeCallerWei: session.beforeExpireCallerWei,
    afterCallerWei: session.afterExpireCallerWei,
    actualFee: feeFromAction(session.expireB),
  });
  const paymentEvalCancelB = evaluateCancelRefund({
    parentSuccessful: Boolean(session.cancelB.parentSuccessful),
    statusName: session.cancelB.statusName,
    executionName: session.cancelB.executionName,
    parentTxId: session.cancelB.txId,
    rewardWei: rewardB ?? 0n,
    funder: session.boundFunder ?? wallet.address ?? "",
    named: session.boundTranslator ?? translator,
    transfer: session.transferCancelB,
    before: session.beforeCancelB,
    after: session.afterWaitCancelB ?? session.afterCancelB,
    actualFee: feeFromAction(session.cancelB),
  });

  return (
    <div className="w-full px-gutter py-space-xl max-w-7xl mx-auto flex flex-col gap-space-xl">
      <section className="flex flex-col gap-space-sm">
        <div className="flex flex-wrap items-center gap-space-sm">
          <span className="inline-flex items-center gap-1 px-space-sm py-0.5 bg-secondary-container text-on-secondary-container font-label-sm text-label-sm uppercase tracking-wider rounded shadow-[2px_2px_0px_#00170b]">
            Live Product V2 · Phase C2
          </span>
          <span className="inline-flex items-center gap-1 px-space-sm py-0.5 bg-tertiary-fixed text-on-tertiary-fixed font-label-sm text-label-sm uppercase tracking-wider rounded">
            Studio-dev {STUDIO_DEV_CHAIN_ID} only
          </span>
          <span className="inline-flex items-center gap-1 px-space-sm py-0.5 bg-error-container text-on-error-container font-label-sm text-label-sm uppercase tracking-wider rounded">
            Live result UNPROVEN
          </span>
        </div>
        <h1 className="font-display-lg text-display-lg-mobile md:text-display-lg text-primary tracking-tight leading-none uppercase">
          LocaleBounty V2 harness · accept and expire
        </h1>
        <p className="font-body-lg text-body-lg text-on-surface-variant max-w-3xl">
          Isolated from the six public screens. Those stay on V1 at{" "}
          <span className="font-mono">{PRODUCT_UI_CONTRACT}</span>. This page deploys{" "}
          <span className="font-mono">{V2_SOURCE_FILE}</span> from your funded wallet, then runs two small lanes. Persist
          key <span className="font-mono">localebounty.live-product-v2.v1</span>.
        </p>
        <p className="font-body-md text-body-md text-on-surface-variant max-w-3xl bg-surface-container-lowest px-space-md py-space-sm rounded">
          Every write needs Estimate, then Sign. Attached reward, quoted fee deposit, actual receipt fee, and refund stay
          separate. Connected role: {role}. {BROWSER_FEE_QUOTE_NOTE} {HISTORICAL_PROBE_PAYOUT_FEE_NOTE}
        </p>
      </section>

      <WalletCard />

      <section className="bg-surface-container-lowest p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-md">
        <h2 className="font-title-lg text-title-lg text-primary uppercase">Fund on Studio-dev</h2>
        <p className="font-body-md text-body-md text-on-surface-variant">
          Request faucet GEN for the same browser wallet. This app never asks for a private key and never auto-signs.
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
          Translator must be a different 20-byte EOA than the funder. Reward is attached only on create_task. accept_task
          and expire_unsubmitted_task attach 0 GEN; the signer pays the write fee.
        </p>
        <label className="flex flex-col gap-space-xs">
          <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">Named translator EOA</span>
          <input
            value={session.translator}
            onChange={(e) => persist({ ...session, translator: e.target.value.trim() })}
            placeholder="0x…"
            className="bg-surface-container-high px-space-md py-space-sm rounded font-mono text-sm"
            spellCheck={false}
            disabled={Boolean(session.createA.txId || session.createB.txId)}
          />
        </label>
        <label className="flex flex-col gap-space-xs">
          <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">GEN reward (attached to each create)</span>
          <input
            value={session.rewardGen}
            onChange={(e) => persist({ ...session, rewardGen: e.target.value })}
            placeholder="0.5"
            className="bg-surface-container-high px-space-md py-space-sm rounded font-mono text-sm disabled:opacity-60"
            inputMode="decimal"
            disabled={Boolean(session.createA.txId && session.createB.txId)}
          />
        </label>
        {isEoaAddress(translator) ? (
          <p className="font-body-sm text-body-sm text-primary break-all">
            Translator that will be signed: <span className="font-mono">{translator}</span>
          </p>
        ) : session.translator ? (
          <p className="text-error font-body-sm text-body-sm">Enter a 0x-prefixed 40-hex-character address.</p>
        ) : null}
        {rewardA != null && rewardA > 0n ? (
          <p className="font-body-sm text-body-sm">
            Attached reward: {formatGen(rewardA)} ({rewardA.toString()} wei). Protocol fee is quoted separately.
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
      </section>

      {disabledReason ? (
        <p className="bg-error-container text-on-error-container px-space-md py-space-sm rounded font-body-md text-body-md">
          Writes disabled: {disabledReason}
        </p>
      ) : null}

      <section className="bg-surface-container-low p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-md">
        <h2 className="font-title-lg text-title-lg text-primary uppercase">1. Deploy localebounty_v2.py</h2>
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
          title="Deploy current localebounty_v2.py (pinned runner in source header)"
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
        <h2 className="font-title-lg text-title-lg text-primary uppercase">2. Verify deployed V2 source</h2>
        <p className="font-body-sm text-body-sm text-on-surface-variant">
          Create stays disabled until gen_getContractCode SHA-256 equals the exact local {V2_SOURCE_FILE} bytes and deploy
          is FINALIZED with FINISHED_WITH_RETURN. {sourceCreate.ok ? "Source binding allows create." : sourceCreate.reason}
        </p>
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
        <h2 className="font-title-lg text-title-lg text-primary uppercase">Lane A · unaccepted create then funder cancel</h2>
        <p className="font-body-sm text-body-sm text-on-surface-variant">
          submit_by ≈ now+1800s. Do not accept or submit. Expected task ID{" "}
          <span className="font-mono break-all">{session.taskIdA ?? "after estimate"}</span>
        </p>
        {session.submitA != null ? (
          <p className="font-body-sm text-body-sm font-mono break-all">
            Bound deadlines ({session.createDeadlineClock ?? "unset"}): submit_by={session.submitA} recover_after={session.recoverA}
            {session.nonceA ? ` · nonce ${session.nonceA}` : ""}
          </p>
        ) : null}
        <ActionBlock
          title="create_task lane A + reward"
          action={session.createA}
          disabled={!createAGuard.ok}
          disableReason={createAGuard.ok ? undefined : createAGuard.reason}
          signDisabled={!createASignGuard.ok}
          signDisableReason={createASignGuard.ok ? undefined : createASignGuard.reason}
          onPrepare={() => void prepareAction("createA")}
          onSign={() => void signAction("createA")}
          onRetry={() => retryAction("createA")}
          attachedWei={session.createA.quotedValueWei ?? (rewardA != null ? rewardA.toString() : "0")}
          quotedFeeWei={session.createA.quotedFeeWei}
          quoteHint="Estimating create_task. The first estimate may probe Studio-dev GetTimestamp. This is not a wallet signature."
        />
        <button
          type="button"
          disabled={!session.address || !session.taskIdA}
          onClick={() => void refreshTask("A")}
          className="self-start font-label-sm text-label-sm uppercase px-space-sm py-space-xs bg-surface-container-high rounded disabled:opacity-40"
        >
          Refresh get_task A
        </button>
        {session.taskA ? (
          <dl className="grid grid-cols-1 md:grid-cols-2 gap-space-sm font-body-sm text-body-sm">
            <Field label="task_id" value={session.taskA.task_id} />
            <Field label="state" value={session.taskA.state} />
            <Field label="accepted_at_unix" value={String(session.taskA.accepted_at_unix)} />
            <Field label="translation" value={session.taskA.translation === "" ? "(empty)" : session.taskA.translation} />
            <Field label="payout_submitted" value={String(session.taskA.payout_submitted)} />
            <Field label="reward wei" value={session.taskA.rewardWei} />
          </dl>
        ) : (
          <p className="font-body-sm text-body-sm text-on-surface-variant">No get_task snapshot for lane A yet.</p>
        )}
        <ActionBlock
          title="cancel_task(task_id) funder only, open unaccepted"
          action={session.cancelA}
          disabled={!cancelAGuard.ok}
          disableReason={cancelAGuard.ok ? undefined : cancelAGuard.reason}
          onPrepare={() => void prepareAction("cancelA")}
          onSign={() => void signAction("cancelA")}
          onRetry={() => retryAction("cancelA")}
          attachedWei="0"
          quotedFeeWei={session.cancelA.quotedFeeWei}
        />
        {session.cancelA.txId ? (
          <button
            type="button"
            onClick={() => void pollPaymentA()}
            className="self-start font-label-sm text-label-sm uppercase px-space-sm py-space-xs bg-tertiary-fixed text-on-tertiary-fixed rounded"
          >
            Refresh lane A balance evidence
          </button>
        ) : null}
        <StatusFields
          tx={session.cancelA.statusName ?? session.createA.statusName ?? "none"}
          execution={session.cancelA.executionName ?? session.createA.executionName ?? "none"}
          contractState={session.taskA?.state ?? "none"}
          payoutSubmitted={String(session.taskA?.payout_submitted ?? false)}
          transfer={paymentEvalA.transferLabel}
          balance={paymentEvalA.balanceLabel}
          payment={`${session.paymentA} — ${session.paymentAReason}`}
        />
        <div className="flex flex-wrap items-center justify-between gap-space-sm">
          <p className="font-title-md text-title-md uppercase">Lane A {laneA.verdict}</p>
          <CopyButton value={evidenceA} label="Copy lane A evidence JSON" />
        </div>
        <p className="font-body-sm text-body-sm text-on-surface-variant">{laneA.reason}</p>
      </section>

      <section className="bg-surface-container-low p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-md">
        <h2 className="font-title-lg text-title-lg text-primary uppercase">Lane B · accept then expire, or unaccepted recovery</h2>
        <p className="font-body-sm text-body-sm text-on-surface-variant">
          Lane B YES requires a finalized successful accept, nonzero accepted_at_unix, and a later successful expiry with
          exact refund delivery. If acceptance misses the window, recover with funder cancel while OPEN unaccepted, or
          expire_unsubmitted_task after now &gt; submit_by_unix. Those recoveries are labeled separately and are never Lane
          B YES. Expected task ID{" "}
          <span className="font-mono break-all">{session.taskIdB ?? "after estimate"}</span>
        </p>
        <label className="flex flex-col gap-space-xs">
          <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">
            Lane B accept window (from Sign create)
          </span>
          <select
            value={String(session.laneBLeadSeconds)}
            disabled={Boolean(session.createB.txId)}
            onChange={(e) => {
              if (session.createB.txId) return;
              const seconds = normalizeLaneBLeadSeconds(Number(e.target.value));
              quotes.current.createB = undefined;
              persist({
                ...session,
                laneBLeadSeconds: seconds,
                submitB: undefined,
                recoverB: undefined,
                createB: invalidateQuotedV2Action(session.createB),
              });
            }}
            className="bg-surface-container-high px-space-md py-space-sm rounded font-body-sm text-body-sm disabled:opacity-60"
          >
            {LANE_B_LEAD_PRESETS.map((preset) => (
              <option key={preset.seconds} value={String(preset.seconds)}>
                {preset.label}
              </option>
            ))}
          </select>
        </label>
        <p className="font-body-sm text-body-sm">{selectedLeadPreview(session.laneBLeadSeconds)}</p>
        <p className="font-body-sm text-body-sm">{acceptView.countdownLabel}</p>
        <p className="font-body-sm text-body-sm text-on-surface-variant">{acceptView.gateLabel}</p>
        {session.submitB != null ? (
          <p className="font-body-sm text-body-sm font-mono break-all">
            Bound deadlines ({session.createDeadlineClock ?? "unset"}): submit_by={session.submitB} recover_after={session.recoverB}
            {session.nonceB ? ` · nonce ${session.nonceB}` : ""}
            {session.submitB != null && !session.createB.txId
              ? " · remaining time above is the accept window that starts once create executes."
              : ""}
          </p>
        ) : null}
        <ActionBlock
          title="create_task lane B + reward"
          action={session.createB}
          disabled={!createBGuard.ok}
          disableReason={createBGuard.ok ? undefined : createBGuard.reason}
          signDisabled={!createBSignGuard.ok}
          signDisableReason={createBSignGuard.ok ? undefined : createBSignGuard.reason}
          onPrepare={() => void prepareAction("createB")}
          onSign={() => void signAction("createB")}
          onRetry={() => retryAction("createB")}
          attachedWei={session.createB.quotedValueWei ?? (rewardB != null ? rewardB.toString() : "0")}
          quotedFeeWei={session.createB.quotedFeeWei}
        />
        <button
          type="button"
          disabled={!session.address || !session.taskIdB}
          onClick={() => void refreshTask("B")}
          className="self-start font-label-sm text-label-sm uppercase px-space-sm py-space-xs bg-surface-container-high rounded disabled:opacity-40"
        >
          Refresh get_task B
        </button>
        {session.taskB ? (
          <dl className="grid grid-cols-1 md:grid-cols-2 gap-space-sm font-body-sm text-body-sm">
            <Field label="task_id" value={session.taskB.task_id} />
            <Field label="state" value={session.taskB.state} />
            <Field label="accepted_at_unix" value={String(session.taskB.accepted_at_unix)} />
            <Field label="submit_by_unix" value={String(session.taskB.submit_by_unix)} />
            <Field label="translation" value={session.taskB.translation === "" ? "(empty)" : session.taskB.translation} />
            <Field label="payout_submitted" value={String(session.taskB.payout_submitted)} />
          </dl>
        ) : (
          <p className="font-body-sm text-body-sm text-on-surface-variant">No get_task snapshot for lane B yet.</p>
        )}
        <p className="font-body-sm text-body-sm">Connect the named translator to Estimate and Sign accept_task. No GEN is attached.</p>
        <ActionBlock
          title="accept_task(task_id) named translator, now < submit_by"
          action={session.acceptB}
          disabled={!acceptBGuard.ok}
          disableReason={acceptBGuard.ok ? undefined : acceptBGuard.reason}
          onPrepare={() => void prepareAction("acceptB")}
          onSign={() => void signAction("acceptB")}
          onRetry={() => retryAction("acceptB")}
          attachedWei="0"
          quotedFeeWei={session.acceptB.quotedFeeWei}
        />
        <p className="font-body-sm text-body-sm text-on-surface-variant">
          {(session.taskB?.accepted_at_unix ?? 0) > 0 || isFinalizedWithReturn(session.acceptB)
            ? cancelBBlocked.reason
            : "Funder cancel is available while this Lane B task is OPEN and unaccepted. After accept, cancel stays unavailable."}
        </p>
        <ActionBlock
          title="cancel_task(task_id) funder only, OPEN unaccepted (Lane B recovery)"
          action={session.cancelB}
          disabled={!cancelBGuard.ok}
          disableReason={cancelBGuard.ok ? undefined : cancelBGuard.reason}
          onPrepare={() => void prepareAction("cancelB")}
          onSign={() => void signAction("cancelB")}
          onRetry={() => retryAction("cancelB")}
          attachedWei="0"
          quotedFeeWei={session.cancelB.quotedFeeWei}
        />
        {session.cancelB.txId ? (
          <button
            type="button"
            onClick={() => void pollPaymentCancelB()}
            className="self-start font-label-sm text-label-sm uppercase px-space-sm py-space-xs bg-tertiary-fixed text-on-tertiary-fixed rounded"
          >
            Refresh unaccepted-cancel balance evidence
          </button>
        ) : null}
        {session.cancelB.txId ? (
          <StatusFields
            tx={session.cancelB.statusName ?? "none"}
            execution={session.cancelB.executionName ?? "none"}
            contractState={session.taskB?.state ?? "none"}
            payoutSubmitted={String(session.taskB?.payout_submitted ?? false)}
            transfer={paymentEvalCancelB.transferLabel}
            balance={paymentEvalCancelB.balanceLabel}
            payment={`${session.paymentBRecovery} (${session.paymentBRecoveryKind}) — ${session.paymentBRecoveryReason}`}
          />
        ) : null}
        <p className="font-body-sm text-body-sm">{expireView.countdownLabel}</p>
        <p className="font-body-sm text-body-sm text-on-surface-variant">{expireView.gateLabel}</p>
        <ActionBlock
          title="expire_unsubmitted_task(task_id) any wallet, now > submit_by, OPEN or ACCEPTED unsubmitted"
          action={session.expireB}
          disabled={!expireBGuard.ok}
          disableReason={expireBGuard.ok ? undefined : expireBGuard.reason}
          onPrepare={() => void prepareAction("expireB")}
          onSign={() => void signAction("expireB")}
          onRetry={() => retryAction("expireB")}
          attachedWei="0"
          quotedFeeWei={session.expireB.quotedFeeWei}
        />
        {session.expireB.txId ? (
          <button
            type="button"
            onClick={() => void pollPaymentB()}
            className="self-start font-label-sm text-label-sm uppercase px-space-sm py-space-xs bg-tertiary-fixed text-on-tertiary-fixed rounded"
          >
            Refresh lane B expire balance evidence
          </button>
        ) : null}
        {session.expireCaller ? (
          <p className="font-body-sm text-body-sm font-mono break-all">Expire caller {session.expireCaller}</p>
        ) : null}
        <StatusFields
          tx={session.expireB.statusName ?? session.acceptB.statusName ?? session.createB.statusName ?? "none"}
          execution={session.expireB.executionName ?? session.acceptB.executionName ?? session.createB.executionName ?? "none"}
          contractState={session.taskB?.state ?? "none"}
          payoutSubmitted={String(session.taskB?.payout_submitted ?? false)}
          transfer={paymentEvalB.transferLabel}
          balance={paymentEvalB.balanceLabel}
          payment={`${session.paymentB} — ${session.paymentBReason}`}
        />
        <div className="flex flex-wrap items-center justify-between gap-space-sm">
          <p className="font-title-md text-title-md uppercase">Lane B {laneB.verdict}</p>
          <CopyButton value={evidenceB} label="Copy lane B evidence JSON" />
        </div>
        <p className="font-body-sm text-body-sm text-on-surface-variant">{laneB.reason}</p>
        <p className="font-title-md text-title-md uppercase">
          Unaccepted recovery {laneBRecovery.kind} {laneBRecovery.verdict}
        </p>
        <p className="font-body-sm text-body-sm text-on-surface-variant">{laneBRecovery.reason}</p>
      </section>

      <section className="bg-primary-container text-inverse-on-surface p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-md">
        <p className="font-label-sm text-label-sm uppercase tracking-wider text-tertiary-fixed">Phase C2 live result</p>
        <h2 className="font-display-lg text-headline-lg uppercase">
          A {laneA.verdict} · B {laneB.verdict} · recovery {laneBRecovery.kind} {laneBRecovery.verdict}
        </h2>
        <p className="font-body-md text-body-md text-inverse-on-surface/80 max-w-3xl">
          Direct tests and unit tests are not live YES. Do not treat an emitted transfer as paid. {PAYOUT_SUBMITTED_IS_NOT_PAYMENT}
        </p>
        {clearPrompt ? (
          <div className="bg-surface-container-lowest text-on-surface p-space-md rounded flex flex-col gap-space-sm">
            <p className="font-body-sm text-body-sm">{clearRisk.reason}</p>
            <p className="font-body-sm text-body-sm font-mono break-all">Task A: {clearRisk.taskIdA ?? "(none)"}</p>
            <p className="font-body-sm text-body-sm font-mono break-all">Task B: {clearRisk.taskIdB ?? "(none)"}</p>
            <p className="font-body-sm text-body-sm font-mono break-all">Deploy: {clearRisk.txIds.deploy ?? "(none)"}</p>
            <p className="font-body-sm text-body-sm font-mono break-all">Create A: {clearRisk.txIds.createA ?? "(none)"}</p>
            <p className="font-body-sm text-body-sm font-mono break-all">Cancel A: {clearRisk.txIds.cancelA ?? "(none)"}</p>
            <p className="font-body-sm text-body-sm font-mono break-all">Create B: {clearRisk.txIds.createB ?? "(none)"}</p>
            <p className="font-body-sm text-body-sm font-mono break-all">Cancel B: {clearRisk.txIds.cancelB ?? "(none)"}</p>
            <p className="font-body-sm text-body-sm font-mono break-all">Accept B: {clearRisk.txIds.acceptB ?? "(none)"}</p>
            <p className="font-body-sm text-body-sm font-mono break-all">Expire B: {clearRisk.txIds.expireB ?? "(none)"}</p>
            <CopyButton value={`${evidenceA}\n\n${evidenceB}`} label="Copy both evidence JSON blobs" onCopied={() => setEvidenceExported(true)} />
            <div className="flex flex-wrap gap-space-sm">
              <button
                type="button"
                disabled={!evidenceExported}
                className="font-label-sm text-label-sm uppercase tracking-wider px-space-sm py-space-xs bg-error-container text-on-error-container rounded disabled:opacity-40"
                onClick={() => {
                  quotes.current = {};
                  persist(clearProductV2Session());
                  setClearPrompt(false);
                  setEvidenceExported(false);
                  setSourceRechecked(true);
                }}
              >
                I exported evidence — clear V2 tracking
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
              persist(clearProductV2Session());
              setSourceRechecked(true);
            }}
          >
            Clear V2 local tracking
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
  action: ProductV2ActionRecord;
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
