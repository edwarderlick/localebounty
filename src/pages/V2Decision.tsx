import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { AppPreview } from "../components/AppPreview";
import { CopyButton } from "../components/CopyButton";
import { Icon } from "../components/Icon";
import { V2StatusPill } from "../components/V2StatusPill";
import { WriteAttemptHistory } from "../components/WriteAttemptHistory";
import { WalletCard } from "../live/WalletCard";
import { useWallet } from "../live/WalletContext";
import { isUserRejection } from "../live/eip1193";
import { FEE_DEPOSIT_LABEL, formatError, formatGen } from "../live/format";
import { PAYOUT_SUBMITTED_IS_NOT_PAYMENT } from "../live/product/evidence";
import { applyTxSignCatch } from "../live/productUi/attemptHistory";
import { liveEvaluateSettlement } from "../live/productUi/settlement";
import { buildV2DecisionEvidence } from "../live/productUiV2/decisionEvidence";
import { estimateV2Write, loadV2ProductTask, signV2WriteBlocker, submitV2WriteTx, trackV2WriteTx } from "../live/productUiV2/writeFlow";
import { evaluateEstimateAllowed, failedEvaluateStillSubmitted, isTerminalFailure, needsWriteResume, neverResubmit } from "../live/productUiV2/guards";
import { STATE_APPROVED, STATE_REJECTED, STATE_SUBMITTED } from "../live/productUiV2/constants";
import { putV2Write, retryFailedV2Write, writeIdentityOrEmpty, type ProductUiV2WriteRecord } from "../live/productUiV2/writes";
import type { ProductV2Task } from "../live/productV2/task";
import { v2LibraryHref, v2TaskHref } from "../lib/paths";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "missing" }
  | { status: "ready"; task: ProductV2Task };

export function V2Decision() {
  const { id } = useParams();
  const wallet = useWallet();
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [record, setRecord] = useState<ProductUiV2WriteRecord>(() =>
    writeIdentityOrEmpty({ wallet: wallet.address, chainId: wallet.chainId, taskId: id ?? "", action: "evaluate" }),
  );
  const resumedKey = useRef("");

  const persistRecord = useCallback((next: ProductUiV2WriteRecord, task?: ProductV2Task) => {
    putV2Write(next);
    setRecord(next);
    if (task) setLoad({ status: "ready", task });
    return next;
  }, []);

  useEffect(() => {
    if (!id) {
      setLoad({ status: "missing" });
      return;
    }
    let cancelled = false;
    setLoad({ status: "loading" });
    void loadV2ProductTask(id)
      .then((task) => {
        if (!cancelled) setLoad({ status: "ready", task });
      })
      .catch((err) => {
        if (!cancelled) setLoad({ status: "error", message: formatError(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    if (!id || !wallet.address || wallet.chainId == null) return;
    setRecord(writeIdentityOrEmpty({ wallet: wallet.address, chainId: wallet.chainId, taskId: id, action: "evaluate" }));
  }, [id, wallet.address, wallet.chainId]);

  useEffect(() => {
    if (!id || !wallet.address || wallet.chainId == null) return;
    const stored = writeIdentityOrEmpty({ wallet: wallet.address, chainId: wallet.chainId, taskId: id, action: "evaluate" });
    if (!stored.txId || resumedKey.current === stored.key) return;
    resumedKey.current = stored.key;
    if (needsWriteResume(stored) || stored.statusName === "FINALIZED") {
      void trackV2WriteTx(stored, stored.txId, persistRecord);
    }
  }, [id, persistRecord, wallet.address, wallet.chainId]);

  if (!id || load.status === "missing") return <Shell>Task not found.</Shell>;
  if (load.status === "loading") return <Shell>Reading get_task...</Shell>;
  if (load.status === "error") return <Shell>get_task failed: {load.message}</Shell>;

  const task = load.task;
  const ctx = { wallet: wallet.address, chainId: wallet.chainId, connected: wallet.connected };
  const estimateGuard = evaluateEstimateAllowed({ task, record, ctx });
  const retryable = failedEvaluateStillSubmitted(task, record);
  const settled = liveEvaluateSettlement({ task, record: record as never });
  const evidenceJson = buildV2DecisionEvidence({ task, record, wallet: wallet.address, chainId: wallet.chainId });
  const approved = task.state === STATE_APPROVED;
  const rejected = task.state === STATE_REJECTED;
  const previewBody = approved && task.translation ? task.translation : task.source_text;

  async function onEstimate() {
    if (!id) return;
    try {
      const identity = await wallet.verifyBeforeWrite();
      const next = await estimateV2Write({ action: "evaluate", taskId: id, identity, nowUnix: Math.floor(Date.now() / 1000) });
      persistRecord(next.record, next.task);
    } catch (err) {
      persistRecord({ ...record, phase: "idle", error: isUserRejection(err) ? "Wallet rejected the fee estimate." : formatError(err) });
    }
  }

  async function onSign() {
    if (!id) return;
    if (neverResubmit(record) === "resume" && !isTerminalFailure(record)) {
      if (record.txId) await trackV2WriteTx(record, record.txId, persistRecord);
      return;
    }
    try {
      const identity = await wallet.verifyBeforeWrite();
      const blocker = await signV2WriteBlocker({ action: "evaluate", taskId: id, identity, nowUnix: Math.floor(Date.now() / 1000) });
      if (!blocker.ok) {
        persistRecord(blocker.record, blocker.task);
        return;
      }
      if (!wallet.provider) throw new Error("Connect a wallet before signing.");
      persistRecord({ ...blocker.record, phase: "signing", error: undefined });
      const submitted = await submitV2WriteTx({ record: blocker.record, task: blocker.task, identity, provider: wallet.provider, estimate: blocker.estimate });
      persistRecord(submitted.record, blocker.task);
      await trackV2WriteTx(submitted.record, submitted.txId, persistRecord);
    } catch (err) {
      persistRecord(applyTxSignCatch(writeIdentityOrEmpty({ wallet: wallet.address, chainId: wallet.chainId, taskId: id, action: "evaluate" }) as never, err) as ProductUiV2WriteRecord);
    }
  }

  return (
    <div className="w-full px-gutter py-space-xl max-w-7xl mx-auto flex flex-col gap-space-xl">
      <div className="flex flex-wrap items-center gap-space-sm font-label-sm text-label-sm uppercase text-on-surface-variant">
        <Link to={v2TaskHref(task.task_id)} className="inline-flex items-center gap-1 hover:text-primary">
          <Icon name="arrow_back" className="text-sm" />
          V2 task detail
        </Link>
        <span>/</span>
        <span className="text-primary break-all">{task.task_id}</span>
      </div>
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-space-md">
        <div className="max-w-3xl flex flex-col gap-space-sm">
          <div className="flex flex-wrap items-center gap-space-sm">
            <span className="inline-flex px-space-sm py-0.5 bg-tertiary-fixed text-on-tertiary-fixed font-label-sm text-label-sm uppercase rounded rotate-[-2deg] shadow-[2px_2px_0px_#00170b]">V2 evaluate_task</span>
            <V2StatusPill state={task.state} />
          </div>
          <h1 className="font-headline-lg text-headline-lg-mobile md:text-headline-lg text-primary tracking-tight">Validation & decision</h1>
          <p className="font-body-lg text-body-lg text-on-surface-variant">Any connected Studio-dev wallet may call evaluate_task. The displayed result is the stored contract decision: {task.decision}.</p>
        </div>
        <CopyButton value={task.task_id} label="Copy task id" />
      </div>

      <section className="bg-surface-container-lowest p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-md">
        <h2 className="font-headline-sm text-headline-sm uppercase text-primary">Submitted translation</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-space-md">
          <div><p className="font-label-sm text-label-sm uppercase text-on-surface-variant">Source</p><p className="font-title-md text-title-md text-primary mt-space-xs whitespace-pre-wrap">{task.source_text}</p></div>
          <div><p className="font-label-sm text-label-sm uppercase text-on-surface-variant">Stored translation</p><p className="font-title-md text-title-md text-primary mt-space-xs whitespace-pre-wrap">{task.translation || "get_task has an empty translation."}</p></div>
        </div>
        <p className="font-body-sm text-body-sm text-on-surface-variant">{settled.contractDecision}. payout_submitted={String(task.payout_submitted)}. {PAYOUT_SUBMITTED_IS_NOT_PAYMENT}</p>
        {approved ? <Banner title="Approved" body="Contract decision is approved. Transfer and balance proof stay separate." /> : null}
        {rejected ? <Banner title="Rejected" body="Contract decision is rejected. This translation is not an approved library entry." /> : null}
        {task.state === STATE_SUBMITTED && record.txId && isTerminalFailure(record) ? <Banner title="Evaluation failed closed" body="The parent transaction finalized without successful execution. The task remains submitted for a deliberate new attempt." /> : null}
      </section>

      <section className="flex flex-col gap-space-md">
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-space-sm">
          <h2 className="font-headline-sm text-headline-sm uppercase text-primary">Separate evidence fields</h2>
          <CopyButton value={evidenceJson} label="Copy V2 evidence JSON" />
        </div>
        <p className="font-body-sm text-body-sm text-on-surface-variant max-w-3xl">
          Copy JSON exports only hashes, snapshots, receipts, child credits, and library entries stored in this signing browser for this V2 task. Missing values are omitted, not inferred.
        </p>
        {task.task_id.toLowerCase() === "7e1974679cc5f3423573e8cf52b2446ed2a3de6bf4ad5415054f8532bf2c6352" ? (
          <p className="font-body-sm text-body-sm text-on-surface-variant max-w-3xl">
            Historical signing-browser proof for this exact task is archived in the{" "}
            <a className="underline text-primary" href="https://github.com/edwarderlick/localebounty/blob/ed8706f69b2810f99a503e9a21f98b6c7c2f7905/docs/evidence/2026-10-03-v2-approved-decision-copy-evidence.json" target="_blank" rel="noopener noreferrer">V2 evidence JSON</a>.
            Its SHA-256 is EA2D071FB84DC3363CE93FA3F31CAA926EE822B74ACEFACA42B76DE3B39D2FBC. This browser’s evidence fields remain independent and may be UNPROVEN without the original signing snapshots.
          </p>
        ) : null}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-space-md">
          <Cell title="Transaction status" value={settled.transactionStatus} />
          <Cell title="Execution result" value={settled.execution} />
          <Cell title="Contract decision" value={settled.contractDecision} />
          <Cell title="Outgoing EthSend" value={settled.outgoingEthSend ?? settled.transferDelivery} />
          <Cell title="Child credit" value={settled.childCredit ?? "UNPROVEN"} />
          <Cell title="Receipt fee" value={settled.receiptFee ?? "UNPROVEN"} />
          <Cell title="Fee equation" value={settled.feeEquation ?? "UNPROVEN"} />
          <Cell title="Balance evidence" value={settled.balanceEvidence} />
        </div>
        <p className="font-body-sm text-body-sm text-on-surface-variant">Verdict {settled.paymentEvidence}. {settled.paymentReason}</p>
      </section>

      <WalletCard />
      <section className="bg-primary-container text-inverse-on-surface p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-md">
        <h2 className="font-headline-sm text-headline-sm uppercase">evaluate_task</h2>
        <p className="font-body-md text-body-md text-primary-fixed-dim">{FEE_DEPOSIT_LABEL}: {record.quotedFeeWei ? formatGen(BigInt(record.quotedFeeWei)) : "not quoted"}. Attached value is 0. This is not restricted to the funder.</p>
        {record.error ? <p className="bg-error-container text-on-error-container p-space-md rounded font-body-sm text-body-sm">{record.error}</p> : null}
        <div className="flex flex-wrap gap-space-sm">
          <button type="button" disabled={!estimateGuard.ok || record.phase === "quoting"} className="px-space-lg py-space-md bg-surface-container text-on-surface font-label-md text-label-md uppercase rounded shadow-[3px_3px_0px_#00170b] disabled:opacity-50" onClick={() => void onEstimate()}>{record.phase === "quoting" ? "Estimating..." : "Estimate fee"}</button>
          <button type="button" disabled={record.txId && !isTerminalFailure(record) ? neverResubmit(record) !== "resume" : !estimateGuard.ok || record.phase === "signing" || record.phase !== "quoted"} className="px-space-lg py-space-md bg-secondary-container text-on-secondary-container font-headline-sm text-title-lg uppercase rounded shadow-[4px_4px_0px_#00170b] disabled:opacity-50" onClick={() => void onSign()}>{record.txId && !isTerminalFailure(record) ? "Resume tracking" : record.phase === "signing" ? "Waiting for wallet..." : "Sign evaluate_task"}</button>
          {retryable ? <button type="button" className="px-space-lg py-space-md bg-tertiary-fixed text-on-tertiary-fixed font-label-md text-label-md uppercase rounded shadow-[3px_3px_0px_#00170b]" onClick={() => { resumedKey.current = ""; persistRecord(retryFailedV2Write(record), task); }}>New attempt</button> : null}
        </div>
        <WriteAttemptHistory entries={record.attemptHistory} currentTxId={record.txId} />
        {!estimateGuard.ok ? <p className="font-body-sm text-body-sm text-tertiary-fixed">{estimateGuard.reason}</p> : null}
      </section>

      <AppPreview body={previewBody} locale={approved ? task.target_locale : task.source_locale} caption={approved ? "Preview injects the approved on-chain translation." : "Preview stays on the source until get_task reports approved."} />
      {approved ? <Link to={v2LibraryHref()} className="inline-flex items-center gap-space-sm font-label-md text-label-md uppercase text-secondary">Open V2 string library<Icon name="arrow_forward" /></Link> : null}
    </div>
  );
}

function Banner({ title, body }: { title: string; body: string }) {
  return <div className="p-space-md rounded bg-primary-fixed text-on-primary-fixed"><p className="font-title-lg text-title-lg uppercase">{title}</p><p className="font-body-sm text-body-sm mt-space-xs">{body}</p></div>;
}

function Cell({ title, value }: { title: string; value: string }) {
  return <div className="bg-surface-container-lowest p-space-md rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-xs"><h3 className="font-title-lg text-title-lg text-primary uppercase">{title}</h3><p className="font-body-sm text-body-sm text-primary break-words">{value}</p></div>;
}

function Shell({ children }: { children: ReactNode }) {
  return <div className="max-w-3xl mx-auto px-gutter py-space-2xl font-body-lg text-body-lg text-on-surface-variant">{children}</div>;
}
