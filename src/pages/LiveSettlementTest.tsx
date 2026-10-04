import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TransactionFeeEstimate } from "genlayer-js/types";
import { CopyButton } from "../components/CopyButton";
import { useWallet } from "../live/WalletContext";
import { WalletCard } from "../live/WalletCard";
import { isUserRejection } from "../live/eip1193";
import { buildEvidencePayload, evaluateRefundPayment, evaluateReleasePayment, overallVerdict } from "../live/evidence";
import { extractFinalizedFee, type FinalizedFee } from "../live/fees";
import { explorerAddress, explorerTx, formatError, formatGen, isEoaAddress, isZeroAddress, jsonSafe, lockLabel } from "../live/format";
import {
  createReadClient,
  createWriteClient,
  describeDeployBlocker,
  quoteDeploy,
  quoteMeetsStudioFloor,
  quoteWrite,
  readSnapshot,
  submitDeploy,
  submitWrite,
  watchTx,
  type TxSummary,
} from "../live/genlayer";
import {
  actionWriteAllowed,
  bindSession,
  hasTxId,
  importSnapshotAllowsBind,
  isFinalizedSuccessful,
  isTerminalFailure,
  needsPaymentResume,
  needsTxResume,
  neverResubmit,
  retryFailedLaneAction,
  sessionCompatible,
  type WriteContext,
} from "../live/guards";
import {
  EXTERNAL_POLL_MS,
  EXTERNAL_WAIT_MS,
  LOCK_WEI,
  STUDIO_DEV_CHAIN_ID,
  STUDIO_DEV_EXPLORER,
  STUDIO_DEV_FAUCET,
  STUDIO_DEV_RPC,
  STUDIO_DEV_STUDIO,
} from "../live/network";
import {
  clearSession,
  invalidateUnsignedQuotes,
  loadSession,
  resetTransientPhases,
  saveSession,
  type ActionName,
  type ActionRecord,
  type LaneKind,
  type LaneRecord,
  type LiveSession,
} from "../live/persist";
import { currentQuoteBinding, quoteInvalidReason, quoteStillValid } from "../live/quotes";
import { readEoaBalances, type EoaBalances } from "../live/rpc";
import { applyTxSummaryToLane, consensusLayer } from "../live/tracking";

type QuoteMap = Partial<Record<`${LaneKind}:${ActionName}`, TransactionFeeEstimate>>;

function actionOf(lane: LaneRecord, name: ActionName): ActionRecord {
  return lane[name];
}

function withAction(lane: LaneRecord, name: ActionName, patch: Partial<ActionRecord>): LaneRecord {
  return { ...lane, [name]: { ...lane[name], ...patch } };
}

function feeFromLane(lane: LaneRecord): FinalizedFee {
  if (lane.payout.actualFeeAvailable && lane.payout.actualFeeWei) {
    return {
      available: true,
      feeWei: BigInt(lane.payout.actualFeeWei),
      source: lane.payout.actualFeeSource,
      reason: `Stored receipt fee ${lane.payout.actualFeeWei} wei (${lane.payout.actualFeeSource ?? "receipt"}).`,
    };
  }
  return extractFinalizedFee(lane.payout.receipt);
}

export function LiveSettlementTest() {
  const wallet = useWallet();
  const [session, setSession] = useState<LiveSession>(() => resetTransientPhases(loadSession()));
  const [importDraft, setImportDraft] = useState({ release: "", refund: "" });
  const quotes = useRef<QuoteMap>({});
  const resumeOnce = useRef(false);

  const persist = useCallback((next: LiveSession) => {
    saveSession(next);
    setSession(next);
    return next;
  }, []);

  const updateLane = useCallback((kind: LaneKind, updater: (lane: LaneRecord) => LaneRecord) => {
    setSession((current) => {
      const next = { ...current, [kind]: updater(current[kind]) };
      saveSession(next);
      return next;
    });
  }, []);

  const recipient = session.recipient.trim();
  const writeCtx: WriteContext = {
    funder: wallet.address,
    chainId: wallet.chainId,
    recipient,
    connected: wallet.connected,
  };
  const compat = sessionCompatible(session, wallet.address, recipient);
  const overall = useMemo(
    () => overallVerdict(session, wallet.address, session.boundRecipient ?? recipient),
    [session, wallet.address, recipient],
  );
  const evidence = useMemo(() => {
    try {
      return buildEvidencePayload({ funder: wallet.address, chainId: wallet.chainId, session });
    } catch (err) {
      return JSON.stringify({ error: formatError(err), boundFunder: session.boundFunder ?? null }, null, 2);
    }
  }, [wallet.address, wallet.chainId, session]);

  useEffect(() => {
    setSession((current) => {
      const next = resetTransientPhases(current);
      saveSession(next);
      return next;
    });
  }, []);

  useEffect(() => {
    setSession((current) => {
      const next = invalidateUnsignedQuotes(current);
      if (next.release.deploy.quotedBinding === current.release.deploy.quotedBinding &&
          next.release.lock.quotedBinding === current.release.lock.quotedBinding &&
          next.release.payout.quotedBinding === current.release.payout.quotedBinding &&
          next.refund.deploy.quotedBinding === current.refund.deploy.quotedBinding &&
          next.refund.lock.quotedBinding === current.refund.lock.quotedBinding &&
          next.refund.payout.quotedBinding === current.refund.payout.quotedBinding) {
        return current;
      }
      quotes.current = {};
      saveSession(next);
      return next;
    });
  }, [wallet.address, wallet.chainId, recipient, session.release.address, session.refund.address]);

  const applySummary = useCallback(
    (kind: LaneKind, name: ActionName, summary: TxSummary) => {
      updateLane(kind, (lane) => applyTxSummaryToLane(lane, name, summary));
    },
    [updateLane],
  );

  const trackExisting = useCallback(
    async (kind: LaneKind, name: ActionName, txId: string) => {
      updateLane(kind, (lane) => {
        const waiting = withAction(lane, name, { phase: "waiting", txId, error: undefined });
        return name === "deploy" ? { ...waiting, deployBlocker: undefined } : waiting;
      });
      try {
        const summary = await watchTx(createReadClient(), txId, (partial) => applySummary(kind, name, partial));
        let snapshot: unknown;
        const stored = loadSession();
        const address =
          summary.parentSuccessful ? summary.contractAddress ?? stored[kind].address : stored[kind].imported ? stored[kind].address : undefined;
        if (address && (summary.parentSuccessful || stored[kind].imported)) {
          try {
            snapshot = jsonSafe(await readSnapshot(createReadClient(), address));
          } catch (err) {
            snapshot = { read_error: formatError(err) };
          }
        }
        applySummary(kind, name, summary);
        if (snapshot) updateLane(kind, (lane) => withAction(lane, name, { snapshot }));
        return summary;
      } catch (err) {
        updateLane(kind, (lane) =>
          withAction(lane, name, {
            phase: "waiting",
            txId,
            error: `Wait timed out or RPC failed while tracking ${txId}. Not resubmitting. ${formatError(err)}`,
          }),
        );
        return null;
      }
    },
    [applySummary, updateLane],
  );

  const pollPayment = useCallback(
    async (kind: LaneKind) => {
      const stored = loadSession();
      const lane = stored[kind];
      const named = stored.boundRecipient ?? stored.recipient;
      const funder = stored.boundFunder ?? wallet.address;
      const contract = lane.address;
      if (!funder || !contract || !isEoaAddress(named)) return;
      const before = lane.beforePayout;
      if (!before) {
        updateLane(kind, (current) => ({
          ...current,
          paymentEvidence: "UNPROVEN",
          paymentReason: "Cannot prove an EOA delta: no before-payout balances were stored for this funder/recipient.",
        }));
        return;
      }
      const deadline = Date.now() + EXTERNAL_WAIT_MS;
      const samples: EoaBalances[] = [];
      let last = await readEoaBalances({ funder, named, contract });
      samples.push(last);
      while (true) {
        const fee = feeFromLane(loadSession()[kind]);
        const evidence =
          kind === "release" ? evaluateReleasePayment(before, last) : evaluateRefundPayment(before, last, fee);
        if (evidence.verdict === "YES") {
          updateLane(kind, (current) => ({
            ...current,
            afterWait: last,
            waitSamples: samples,
            paymentEvidence: "YES",
            paymentReason: evidence.reason,
          }));
          return;
        }
        if (Date.now() >= deadline) {
          updateLane(kind, (current) => ({
            ...current,
            afterWait: last,
            waitSamples: samples,
            paymentEvidence: "UNPROVEN",
            paymentReason: evidence.reason,
          }));
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, EXTERNAL_POLL_MS));
        last = await readEoaBalances({ funder, named, contract });
        samples.push(last);
      }
    },
    [updateLane, wallet.address],
  );

  const resumeLane = useCallback(
    async (kind: LaneKind) => {
      const stored = loadSession();
      for (const name of ["deploy", "lock", "payout"] as ActionName[]) {
        const action = stored[kind][name];
        if (action.txId && (needsTxResume(action) || !action.snapshot)) {
          await trackExisting(kind, name, action.txId);
        }
      }
      const after = loadSession();
      if (needsPaymentResume(after[kind])) {
        await pollPayment(kind);
      }
    },
    [pollPayment, trackExisting],
  );

  useEffect(() => {
    if (resumeOnce.current) return;
    resumeOnce.current = true;
    void resumeLane("release");
    void resumeLane("refund");
  }, [resumeLane]);

  async function prepareAction(kind: LaneKind, name: ActionName) {
    const failOnCard = (error: string) => {
      updateLane(kind, (lane) => withAction(lane, name, { phase: "idle", error }));
    };
    try {
      const live = loadSession();
      if (hasTxId(live[kind][name])) {
        failOnCard(`Transaction ID ${live[kind][name].txId} already exists. Resume tracking; not estimating a resubmit.`);
        return;
      }
      const identity = await wallet.verifyBeforeWrite();
      const ctx: WriteContext = {
        funder: identity.address,
        chainId: identity.chainId,
        recipient: loadSession().recipient.trim(),
        connected: true,
      };
      const bound = sessionCompatible(loadSession(), ctx.funder, ctx.recipient);
      if (!bound.ok) {
        failOnCard(bound.reason);
        return;
      }
      const allowed = actionWriteAllowed(kind, name, loadSession()[kind], ctx);
      if (!allowed.ok) {
        failOnCard(allowed.reason);
        return;
      }
      updateLane(kind, (lane) => {
        const quoting = withAction(lane, name, { phase: "quoting", error: undefined });
        return name === "deploy" ? { ...quoting, deployBlocker: undefined } : quoting;
      });
      const value = name === "lock" ? LOCK_WEI : 0n;
      let estimate: TransactionFeeEstimate;
      if (name === "deploy") {
        estimate = await quoteDeploy();
      } else {
        const address = loadSession()[kind].address;
        if (!address) throw new Error("Deploy or import a contract address first.");
        estimate = await quoteWrite({
          address: address as `0x${string}`,
          functionName: name === "lock" ? "lock" : kind === "release" ? "release_to_named_wallet" : "refund_to_funder",
          args: name === "lock" ? [ctx.recipient] : [],
          value,
          from: identity.address,
        });
      }
      const binding = currentQuoteBinding({
        wallet: identity.address,
        chainId: identity.chainId,
        contract: loadSession()[kind].address,
        recipient: ctx.recipient,
        kind,
        name,
        valueWei: value.toString(),
      });
      quotes.current[`${kind}:${name}`] = estimate;
      updateLane(kind, (lane) =>
        withAction(lane, name, {
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

  async function signAction(kind: LaneKind, name: ActionName) {
    const existing = actionOf(loadSession()[kind], name);
    if (neverResubmit(existing) === "resume") {
      if (existing.txId) await trackExisting(kind, name, existing.txId);
      if (name === "payout") await pollPayment(kind);
      return;
    }
    const identity = await wallet.verifyBeforeWrite();
    const live = loadSession();
    const ctx: WriteContext = {
      funder: identity.address,
      chainId: identity.chainId,
      recipient: live.recipient.trim(),
      connected: true,
    };
    const bound = sessionCompatible(live, ctx.funder, ctx.recipient);
    if (!bound.ok) {
      updateLane(kind, (lane) => withAction(lane, name, { error: bound.reason }));
      return;
    }
    const allowed = actionWriteAllowed(kind, name, live[kind], ctx);
    if (!allowed.ok) {
      updateLane(kind, (lane) => withAction(lane, name, { error: allowed.reason }));
      return;
    }
    const value = name === "lock" ? LOCK_WEI : 0n;
    const currentBinding = currentQuoteBinding({
      wallet: identity.address,
      chainId: identity.chainId,
      contract: live[kind].address,
      recipient: ctx.recipient,
      kind,
      name,
      valueWei: value.toString(),
    });
    const storedBinding = live[kind][name].quotedBinding;
    if (!quoteStillValid(storedBinding, currentBinding)) {
      quotes.current[`${kind}:${name}`] = undefined;
      updateLane(kind, (lane) =>
        withAction(lane, name, {
          phase: "idle",
          quotedBinding: undefined,
          quotedFeeWei: undefined,
          error: quoteInvalidReason(storedBinding, currentBinding),
        }),
      );
      return;
    }
    const estimate = quotes.current[`${kind}:${name}`];
    if (!estimate) {
      updateLane(kind, (lane) =>
        withAction(lane, name, {
          error: "Estimate again before signing. Unsigned fee quotes are not reused after a reload, and a timeout never resubmits.",
        }),
      );
      return;
    }
    const floor = quoteMeetsStudioFloor(estimate);
    if (!floor.ok) {
      quotes.current[`${kind}:${name}`] = undefined;
      updateLane(kind, (lane) =>
        withAction(lane, name, {
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
      updateLane(kind, (lane) =>
        withAction(lane, name, {
          error: `Insufficient GEN. Wallet has ${formatGen(wallet.balanceWei ?? 0n)}; this write needs ${formatGen(value)} attached plus ${formatGen(estimate.feeValue)} protocol fee.`,
        }),
      );
      return;
    }

    updateLane(kind, (lane) => withAction(lane, name, { phase: "signing", error: undefined }));
    try {
      const client = createWriteClient(identity.address, wallet.provider!);
      let before: EoaBalances | undefined;
      if (name !== "deploy") {
        before = await readEoaBalances({
          funder: identity.address,
          named: ctx.recipient,
          contract: live[kind].address,
        });
        updateLane(kind, (lane) =>
          name === "lock" ? { ...lane, beforeLock: before } : { ...lane, beforePayout: before },
        );
      }

      let txId: string;
      if (name === "deploy") {
        txId = await submitDeploy(client, estimate);
      } else {
        const address = loadSession()[kind].address;
        if (!address) throw new Error("Missing contract address");
        txId = await submitWrite(client, {
          address: address as `0x${string}`,
          functionName: name === "lock" ? "lock" : kind === "release" ? "release_to_named_wallet" : "refund_to_funder",
          args: name === "lock" ? [ctx.recipient] : [],
          value,
          estimate,
        });
      }

      setSession((current) => {
        const boundSession = bindSession(current, identity.address, ctx.recipient);
        const next = {
          ...boundSession,
          [kind]: withAction(boundSession[kind], name, { phase: "submitted" as const, txId, submittedAt: Date.now() }),
        };
        saveSession(next);
        return next;
      });
      const summary = await trackExisting(kind, name, txId);
      if (!summary) return;
      const latest = loadSession();
      const contractAddress = latest[kind].address;
      if (name !== "deploy" && contractAddress) {
        const afterParent = await readEoaBalances({
          funder: identity.address,
          named: ctx.recipient,
          contract: contractAddress,
        });
        updateLane(kind, (lane) => (name === "lock" ? { ...lane, afterLock: afterParent } : { ...lane, afterParent }));
      }
      if (name === "payout") await pollPayment(kind);
      await wallet.refreshBalance();
    } catch (err) {
      if (isUserRejection(err)) {
        updateLane(kind, (lane) =>
          withAction(lane, name, {
            phase: "rejected",
            error: "Wallet rejected the signature request. Nothing was submitted.",
          }),
        );
        return;
      }
      const still = actionOf(loadSession()[kind], name);
      if (still.txId) {
        updateLane(kind, (lane) =>
          withAction(lane, name, {
            phase: "waiting",
            error: `A transaction ID already exists (${still.txId}). Tracking it instead of resubmitting. ${formatError(err)}`,
          }),
        );
        await trackExisting(kind, name, still.txId);
        return;
      }
      const blocker = name === "deploy" ? describeDeployBlocker(err) : formatError(err);
      const budgetTooLow = /BudgetTooLow/i.test(formatError(err));
      if (budgetTooLow) quotes.current[`${kind}:${name}`] = undefined;
      updateLane(kind, (lane) =>
        withAction(lane, name, {
          phase: "idle",
          error: blocker,
          ...(budgetTooLow
            ? { quotedFeeWei: undefined, quotedValueWei: undefined, quotedBinding: undefined }
            : {}),
        }),
      );
      if (name === "deploy") {
        updateLane(kind, (lane) => ({ ...lane, deployBlocker: describeDeployBlocker(err) }));
      }
    }
  }

  async function importAddress(kind: LaneKind) {
    const draft = importDraft[kind].trim();
    if (!isEoaAddress(draft) || isZeroAddress(draft)) {
      updateLane(kind, (lane) => ({ ...lane, deployBlocker: "Imported address must be a 20-byte hex address." }));
      return;
    }
    try {
      const snapshot = jsonSafe(await readSnapshot(createReadClient(), draft));
      const allowed = importSnapshotAllowsBind(snapshot);
      if (!allowed.ok) {
        updateLane(kind, (lane) => ({ ...lane, deployBlocker: allowed.reason }));
        return;
      }
      updateLane(kind, (lane) => ({
        ...lane,
        address: draft,
        imported: true,
        deployBlocker: undefined,
        deploy: {
          ...lane.deploy,
          phase: "success",
          snapshot,
          error: undefined,
        },
      }));
    } catch (err) {
      updateLane(kind, (lane) => ({
        ...lane,
        deployBlocker: `Could not read get_snapshot() at ${draft}: ${formatError(err)}`,
      }));
    }
  }

  function retryAction(kind: LaneKind, name: ActionName) {
    quotes.current[`${kind}:${name}`] = undefined;
    updateLane(kind, (lane) => retryFailedLaneAction(lane, name));
  }

  async function refreshEvidence(kind: LaneKind) {
    const lane = loadSession()[kind];
    if (lane.payout.txId && !isFinalizedSuccessful(lane.payout)) {
      await trackExisting(kind, "payout", lane.payout.txId);
    }
    if (needsPaymentResume(loadSession()[kind]) || isFinalizedSuccessful(loadSession()[kind].payout)) {
      await pollPayment(kind);
    }
  }

  const writesReady = Boolean(wallet.connected && wallet.onStudioDev && wallet.provider && wallet.address);
  const disabledReason = !compat.ok
    ? compat.reason
    : !writesReady
      ? wallet.connected
        ? `Wrong chain (${wallet.chainId ?? "unknown"}). Switch to Studio-dev ${STUDIO_DEV_CHAIN_ID}.`
        : "Connect a wallet first."
      : undefined;

  return (
    <div className="w-full px-gutter py-space-xl max-w-7xl mx-auto flex flex-col gap-space-xl">
      <section className="flex flex-col gap-space-sm">
        <div className="flex flex-wrap items-center gap-space-sm">
          <span className="inline-flex items-center gap-1 px-space-sm py-0.5 bg-secondary-container text-on-secondary-container font-label-sm text-label-sm uppercase tracking-wider rounded shadow-[2px_2px_0px_#00170b]">
            Live Settlement Test
          </span>
          <span className="inline-flex items-center gap-1 px-space-sm py-0.5 bg-tertiary-fixed text-on-tertiary-fixed font-label-sm text-label-sm uppercase tracking-wider rounded">
            Studio-dev {STUDIO_DEV_CHAIN_ID} only
          </span>
        </div>
        <h1 className="font-display-lg text-display-lg-mobile md:text-display-lg text-primary tracking-tight leading-none uppercase">
          Wallet-connected GEN probe
        </h1>
        <p className="font-body-lg text-body-lg text-on-surface-variant max-w-3xl">
          This route is a real Studio-dev test of the experimental settlement probe. It is not the LocaleBounty product
          contract. The six demo screens and their in-browser data stay demo. The header Demo Owner / Demo Translator
          switch is not authorization and cannot sign these transactions.
        </p>
        <p className="font-body-md text-body-md text-on-surface-variant max-w-3xl bg-surface-container-lowest px-space-md py-space-sm rounded">
          MetaMask “confirmed” only means the EVM envelope landed. GenLayer success needs consensus{" "}
          <span className="font-mono">FINALIZED</span> and execution <span className="font-mono">FINISHED_WITH_RETURN</span>{" "}
          (<span className="font-mono">isSuccessful true</span>). A finalized <span className="font-mono">FINISHED_WITH_ERROR</span>{" "}
          is a failed write — use New attempt, do not lock that receipt’s contract.
        </p>
      </section>

      <WalletCard />

      <section className="bg-surface-container-lowest p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-md">
        <h2 className="font-title-lg text-title-lg text-primary uppercase">1. Fund with the Studio-dev faucet</h2>
        <p className="font-body-md text-body-md text-on-surface-variant">
          Open GenLayer Studio-dev, connect the same test wallet, and request faucet GEN. This app never asks for a
          private key. Writes stay disabled until this wallet is on chain {STUDIO_DEV_CHAIN_ID} with enough GEN for the
          attached {lockLabel()} plus the quoted protocol fee.
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
        <h2 className="font-title-lg text-title-lg text-primary uppercase">2. Named recipient EOA</h2>
        <p className="font-body-md text-body-md text-on-surface-variant">
          Must be a different 20-byte address than the connected funder. Evidence is bound to one funder and one
          recipient. Editing the recipient after a transaction is stored does not mix those old IDs into a new session.
        </p>
        <label className="flex flex-col gap-space-xs">
          <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">Recipient</span>
          <input
            value={session.recipient}
            onChange={(e) => persist({ ...session, recipient: e.target.value.trim() })}
            placeholder="0x…"
            className="bg-surface-container-high px-space-md py-space-sm rounded font-mono text-sm"
            spellCheck={false}
          />
        </label>
        {isEoaAddress(recipient) ? (
          <p className="font-body-sm text-body-sm text-primary break-all">
            Full recipient that will be signed: <span className="font-mono">{recipient}</span>
          </p>
        ) : session.recipient ? (
          <p className="text-error font-body-sm text-body-sm">Enter a 0x-prefixed 40-hex-character address.</p>
        ) : null}
        {session.boundFunder ? (
          <p className="font-body-sm text-body-sm text-on-surface-variant break-all">
            Bound funder {session.boundFunder}
            {session.boundRecipient ? ` · bound recipient ${session.boundRecipient}` : ""}
          </p>
        ) : null}
      </section>

      {disabledReason ? (
        <p className="bg-error-container text-on-error-container px-space-md py-space-sm rounded font-body-md text-body-md">
          Writes disabled: {disabledReason}
        </p>
      ) : null}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-space-lg">
        <LaneCard
          kind="release"
          title="Release instance"
          payoutLabel="release_to_named_wallet()"
          lane={session.release}
          ctx={writeCtx}
          importValue={importDraft.release}
          onImportChange={(value) => setImportDraft((d) => ({ ...d, release: value }))}
          onImport={() => void importAddress("release")}
          onPrepare={(name) => void prepareAction("release", name)}
          onSign={(name) => void signAction("release", name)}
          onRetry={(name) => retryAction("release", name)}
          onRefresh={() => void refreshEvidence("release")}
          recipient={recipient}
          sessionBlock={compat.ok ? undefined : compat.reason}
        />
        <LaneCard
          kind="refund"
          title="Refund instance"
          payoutLabel="refund_to_funder()"
          lane={session.refund}
          ctx={writeCtx}
          importValue={importDraft.refund}
          onImportChange={(value) => setImportDraft((d) => ({ ...d, refund: value }))}
          onImport={() => void importAddress("refund")}
          onPrepare={(name) => void prepareAction("refund", name)}
          onSign={(name) => void signAction("refund", name)}
          onRetry={(name) => retryAction("refund", name)}
          onRefresh={() => void refreshEvidence("refund")}
          recipient={recipient}
          sessionBlock={compat.ok ? undefined : compat.reason}
        />
      </div>

      <section className="bg-primary-container text-inverse-on-surface p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-md">
        <div className="flex flex-wrap items-end justify-between gap-space-md">
          <div>
            <p className="font-label-sm text-label-sm uppercase tracking-wider text-tertiary-fixed">Final settlement verdict</p>
            <h2 className="font-display-lg text-headline-lg uppercase">{overall.verdict}</h2>
            <p className="font-body-md text-body-md text-inverse-on-surface/80 max-w-3xl">{overall.reason}</p>
          </div>
          <CopyButton value={evidence} label="Copy evidence" />
        </div>
        <p className="font-body-sm text-body-sm text-inverse-on-surface/70">
          YES requires both lanes: validated deploy/import, finalized successful lock, finalized successful payout,
          matching snapshots, and measured EOA proof. Refund YES needs the receipt net fee, not a feeValue range.
        </p>
        <button
          type="button"
          className="self-start font-label-sm text-label-sm uppercase tracking-wider text-tertiary-fixed"
          onClick={() => {
            quotes.current = {};
            persist(clearSession());
          }}
        >
          Clear local tracking
        </button>
      </section>
    </div>
  );
}

function instanceLabel(lane: LaneRecord): { text: string; href?: string } {
  const usable = Boolean(lane.address) && (lane.imported || isFinalizedSuccessful(lane.deploy) || !isTerminalFailure(lane.deploy));
  if (usable && lane.address) {
    return {
      text: `Contract: ${lane.address}${lane.imported ? " (imported)" : ""}`,
      href: explorerAddress(lane.address),
    };
  }
  if (isTerminalFailure(lane.deploy)) {
    const named = lane.deploy.contractAddress;
    return {
      text: named
        ? `Contract: none (receipt named ${named}; deploy was not isSuccessful). Use New attempt.`
        : "Contract: none — last deploy was not isSuccessful. Use New attempt.",
    };
  }
  if (lane.deploy.txId && !isFinalizedSuccessful(lane.deploy)) {
    return { text: "Contract: waiting for a successful finalized deploy" };
  }
  return { text: "Contract: not deployed" };
}

function LaneCard({
  kind,
  title,
  payoutLabel,
  lane,
  ctx,
  importValue,
  onImportChange,
  onImport,
  onPrepare,
  onSign,
  onRetry,
  onRefresh,
  recipient,
  sessionBlock,
}: {
  kind: LaneKind;
  title: string;
  payoutLabel: string;
  lane: LaneRecord;
  ctx: WriteContext;
  importValue: string;
  onImportChange: (value: string) => void;
  onImport: () => void;
  onPrepare: (name: ActionName) => void;
  onSign: (name: ActionName) => void;
  onRetry: (name: ActionName) => void;
  onRefresh: () => void;
  recipient: string;
  sessionBlock?: string;
}) {
  const deployGuard = actionWriteAllowed(kind, "deploy", lane, ctx);
  const lockGuard = actionWriteAllowed(kind, "lock", lane, ctx);
  const payoutGuard = actionWriteAllowed(kind, "payout", lane, ctx);
  const block = (guard: { ok: boolean; reason?: string }) =>
    sessionBlock ? { ok: false as const, reason: sessionBlock } : guard.ok ? { ok: true as const } : { ok: false as const, reason: guard.reason ?? "Write disabled." };
  const deploy = block(deployGuard);
  const lock = block(lockGuard);
  const payout = block(payoutGuard);
  const instance = instanceLabel(lane);
  const showDeployBlocker = Boolean(lane.deployBlocker) && !lane.deploy.txId;
  return (
    <section className="bg-surface-container-low p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-md">
      <div>
        <p className="font-label-sm text-label-sm uppercase tracking-wider text-secondary">{kind}</p>
        <h2 className="font-title-lg text-title-lg text-primary uppercase">{title}</h2>
        <p className="font-body-sm text-body-sm text-on-surface-variant break-all">
          {instance.href ? (
            <a className="text-secondary underline-offset-2 hover:underline" href={instance.href} target="_blank" rel="noreferrer">
              {instance.text}
            </a>
          ) : (
            instance.text
          )}
        </p>
      </div>

      <ActionBlock
        title="Deploy settlement_probe.py"
        action={lane.deploy}
        disabled={!deploy.ok}
        disableReason={deploy.ok ? undefined : deploy.reason}
        onPrepare={() => onPrepare("deploy")}
        onSign={() => onSign("deploy")}
        onRetry={() => onRetry("deploy")}
        valueLabel="0 GEN attached"
      />

      {showDeployBlocker ? (
        <p className="bg-error-container text-on-error-container p-space-sm rounded font-body-sm text-body-sm">
          {lane.deployBlocker}
        </p>
      ) : null}

      <div className="flex flex-col gap-space-xs">
        <span className="font-label-sm text-label-sm uppercase text-on-surface-variant">Import deployed address fallback</span>
        <div className="flex gap-space-xs">
          <input
            value={importValue}
            onChange={(e) => onImportChange(e.target.value)}
            placeholder="0x deployed probe"
            className="flex-1 bg-surface-container-highest px-space-sm py-space-xs rounded font-mono text-sm"
            spellCheck={false}
          />
          <button type="button" onClick={onImport} className="font-label-sm text-label-sm uppercase px-space-sm bg-surface-container-highest rounded">
            Import
          </button>
        </div>
      </div>

      <ActionBlock
        title={`lock(recipient) + ${lockLabel()}`}
        action={lane.lock}
        disabled={!lock.ok}
        disableReason={lock.ok ? undefined : lock.reason}
        onPrepare={() => onPrepare("lock")}
        onSign={() => onSign("lock")}
        onRetry={() => onRetry("lock")}
        valueLabel={`${lockLabel()} attached; protocol fee quoted separately`}
        extra={`Recipient in full: ${recipient || "—"}`}
      />

      <ActionBlock
        title={payoutLabel}
        action={lane.payout}
        disabled={!payout.ok}
        disableReason={payout.ok ? undefined : payout.reason}
        onPrepare={() => onPrepare("payout")}
        onSign={() => onSign("payout")}
        onRetry={() => onRetry("payout")}
        valueLabel="0 GEN attached; protocol fee quoted separately"
      />

      {isFinalizedSuccessful(lane.payout) && lane.paymentEvidence !== "YES" ? (
        <button
          type="button"
          onClick={onRefresh}
          className="font-label-sm text-label-sm uppercase px-space-sm py-space-xs bg-tertiary-fixed text-on-tertiary-fixed rounded"
        >
          Refresh evidence
        </button>
      ) : null}

      <StatusTriple
        tx={lane.payout.statusName ?? lane.lock.statusName ?? lane.deploy.statusName ?? "none"}
        execution={lane.payout.executionName ?? "none"}
        payment={`${lane.paymentEvidence} — ${lane.paymentReason}`}
      />
    </section>
  );
}

function ActionBlock({
  title,
  action,
  disabled,
  disableReason,
  onPrepare,
  onSign,
  onRetry,
  valueLabel,
  extra,
}: {
  title: string;
  action: ActionRecord;
  disabled: boolean;
  disableReason?: string;
  onPrepare: () => void;
  onSign: () => void;
  onRetry: () => void;
  valueLabel: string;
  extra?: string;
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
  return (
    <div className="bg-surface-container-lowest p-space-md rounded flex flex-col gap-space-xs">
      <div className="flex flex-wrap items-baseline justify-between gap-space-xs">
        <h3 className="font-title-md text-title-md text-primary">{title}</h3>
        <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">{action.phase}</span>
      </div>
      <p className="font-body-sm text-body-sm text-on-surface-variant">{valueLabel}</p>
      {extra ? <p className="font-body-sm text-body-sm break-all">{extra}</p> : null}
      {action.quotedFeeWei && !action.txId ? (
        <p className="font-body-sm text-body-sm">
          Quoted attached value: {formatGen(BigInt(action.quotedValueWei ?? "0"))}. Fee deposit (quote, required
          upfront): {formatGen(BigInt(action.quotedFeeWei))} ({action.quotedFeeWei} wei). Actual fee consumed is the
          later receipt figure; unused deposit is returned. These are separate.
        </p>
      ) : null}
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
          Waiting for Studio-dev fee quote (up to 20s). This is not a wallet signature.
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
          disabled={resume ? busy : disabled || busy || !action.quotedFeeWei}
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

function StatusTriple({ tx, execution, payment }: { tx: string; execution: string; payment: string }) {
  return (
    <div className="grid grid-cols-1 gap-space-xs">
      <div className="bg-surface-container-lowest p-space-sm rounded">
        <p className="font-label-sm text-label-sm uppercase text-on-surface-variant">Transaction status</p>
        <p className="font-body-sm text-body-sm break-all">{tx}</p>
      </div>
      <div className="bg-surface-container-lowest p-space-sm rounded">
        <p className="font-label-sm text-label-sm uppercase text-on-surface-variant">Execution result</p>
        <p className="font-body-sm text-body-sm break-all">{execution}</p>
      </div>
      <div className="bg-surface-container-lowest p-space-sm rounded">
        <p className="font-label-sm text-label-sm uppercase text-on-surface-variant">Payment evidence</p>
        <p className="font-body-sm text-body-sm break-all">{payment}</p>
      </div>
    </div>
  );
}
