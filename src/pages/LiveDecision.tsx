import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { AppPreview } from "../components/AppPreview";
import { CopyButton } from "../components/CopyButton";
import { Icon } from "../components/Icon";
import { LiveStatusPill } from "../components/LiveStatusPill";
import { isUserRejection } from "../live/eip1193";
import { FEE_DEPOSIT_LABEL, formatError, formatGen } from "../live/format";
import { PAYOUT_SUBMITTED_IS_NOT_PAYMENT } from "../live/product/evidence";
import type { ProductTask } from "../live/product/task";
import { STATE_APPROVED, STATE_REJECTED, STATE_SUBMITTED } from "../live/productUi/constants";
import { buildPublicDecisionEvidence } from "../live/productUi/decisionEvidence";
import { liveEvaluateSettlement } from "../live/productUi/settlement";
import { loadLiveProductTask } from "../live/productUi/taskLoad";
import {
  estimateEvaluate,
  signEvaluateBlocker,
  submitEvaluateTx,
  trackWriteTx,
  writeIdentityOrEmpty,
} from "../live/productUi/writeFlow";
import {
  evaluateEstimateAllowed,
  failedEvaluateStillSubmitted,
  isTerminalFailure,
  needsWriteResume,
  neverResubmit,
} from "../live/productUi/writeGuards";
import { WriteAttemptHistory } from "../components/WriteAttemptHistory";
import { applyTxSignCatch } from "../live/productUi/attemptHistory";
import { putWrite, retryFailedWrite, type ProductUiWriteRecord } from "../live/productUi/writes";
import { WalletCard } from "../live/WalletCard";
import { useWallet } from "../live/WalletContext";
import { liveLibraryHref, liveTaskHref } from "../lib/paths";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "missing" }
  | { status: "ready"; task: ProductTask };

export function LiveDecision() {
  const { id } = useParams();
  const wallet = useWallet();
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [record, setRecord] = useState<ProductUiWriteRecord>(() =>
    writeIdentityOrEmpty({ wallet: wallet.address, chainId: wallet.chainId, taskId: id ?? "", action: "evaluate" }),
  );
  const resumedKey = useRef("");

  const persistRecord = useCallback((next: ProductUiWriteRecord, task?: ProductTask) => {
    putWrite(next);
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
    void (async () => {
      try {
        const task = await loadLiveProductTask(id);
        if (cancelled) return;
        setLoad({ status: "ready", task });
      } catch (err) {
        if (cancelled) return;
        setLoad({ status: "error", message: formatError(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    if (!id || !wallet.address || wallet.chainId == null) return;
    setRecord(
      writeIdentityOrEmpty({
        wallet: wallet.address,
        chainId: wallet.chainId,
        taskId: id,
        action: "evaluate",
      }),
    );
  }, [id, wallet.address, wallet.chainId]);

  useEffect(() => {
    if (!id || !wallet.address || wallet.chainId == null) return;
    const stored = writeIdentityOrEmpty({
      wallet: wallet.address,
      chainId: wallet.chainId,
      taskId: id,
      action: "evaluate",
    });
    if (!stored.txId) return;
    if (resumedKey.current === stored.key) return;
    resumedKey.current = stored.key;
    if (needsWriteResume(stored) || stored.statusName === "FINALIZED") {
      void trackWriteTx(stored, stored.txId, persistRecord);
    }
  }, [id, persistRecord, wallet.address, wallet.chainId]);

  if (!id || load.status === "missing") {
    return (
      <div className="max-w-3xl mx-auto px-gutter py-space-2xl">
        <h1 className="font-headline-md text-headline-md">Task not found</h1>
        <Link to="/v1" className="inline-block mt-space-md font-label-md text-label-md uppercase text-secondary">
          Back to task board
        </Link>
      </div>
    );
  }

  if (load.status === "loading") {
    return (
      <div className="max-w-3xl mx-auto px-gutter py-space-2xl">
        <p className="font-body-lg text-body-lg text-on-surface-variant">Reading get_task…</p>
      </div>
    );
  }

  if (load.status === "error") {
    return (
      <div className="max-w-3xl mx-auto px-gutter py-space-2xl">
        <h1 className="font-headline-md text-headline-md">get_task failed</h1>
        <p className="font-body-md text-body-md break-all">{load.message}</p>
      </div>
    );
  }

  const task = load.task;
  const ctx = { wallet: wallet.address, chainId: wallet.chainId, connected: wallet.connected };
  const estimateGuard = evaluateEstimateAllowed({ task, record, ctx });
  const retryable = failedEvaluateStillSubmitted(task, record);
  const settled = liveEvaluateSettlement({ task, record });
  const evidenceJson = buildPublicDecisionEvidence({
    task,
    record,
    wallet: wallet.address,
    chainId: wallet.chainId,
  });
  const approved = task.state === STATE_APPROVED;
  const rejected = task.state === STATE_REJECTED;
  const previewBody = approved && task.translation ? task.translation : task.source_text;

  async function onEstimate() {
    if (!id) return;
    try {
      const identity = await wallet.verifyBeforeWrite();
      const next = await estimateEvaluate({ taskId: id, identity });
      persistRecord(next.record, next.task);
    } catch (err) {
      persistRecord({
        ...writeIdentityOrEmpty({ wallet: wallet.address, chainId: wallet.chainId, taskId: id, action: "evaluate" }),
        phase: "idle",
        error: isUserRejection(err) ? "Wallet rejected the fee estimate." : formatError(err),
      });
    }
  }

  async function onSign() {
    if (!id) return;
    if (neverResubmit(record) === "resume" && !isTerminalFailure(record)) {
      if (record.txId) await trackWriteTx(record, record.txId, persistRecord);
      return;
    }
    try {
      const identity = await wallet.verifyBeforeWrite();
      const blocker = await signEvaluateBlocker({ taskId: id, identity });
      if (!blocker.ok) {
        persistRecord(blocker.record, blocker.task);
        return;
      }
      if (!wallet.provider) throw new Error("Connect a wallet before signing.");
      persistRecord({ ...blocker.record, phase: "signing", error: undefined });
      const submitted = await submitEvaluateTx({
        record: blocker.record,
        task: blocker.task,
        identity,
        provider: wallet.provider,
        estimate: blocker.estimate,
      });
      persistRecord(submitted.record, blocker.task);
      await trackWriteTx(submitted.record, submitted.txId, persistRecord);
    } catch (err) {
      const live = writeIdentityOrEmpty({
        wallet: wallet.address,
        chainId: wallet.chainId,
        taskId: id,
        action: "evaluate",
      });
      persistRecord(applyTxSignCatch(live, err));
    }
  }

  function onNewAttempt() {
    if (!retryable) return;
    resumedKey.current = "";
    persistRecord(retryFailedWrite(record), task);
  }

  return (
    <div className="w-full px-gutter py-space-xl max-w-7xl mx-auto flex flex-col gap-space-xl">
      <div className="flex flex-wrap items-center gap-space-sm font-label-sm text-label-sm uppercase text-on-surface-variant">
        <Link to={liveTaskHref(task.task_id)} className="inline-flex items-center gap-1 hover:text-primary">
          <Icon name="arrow_back" className="text-sm" />
          Task detail
        </Link>
        <span>/</span>
        <span className="text-primary break-all">{task.task_id}</span>
      </div>

      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-space-md">
        <div className="max-w-3xl flex flex-col gap-space-sm">
          <div className="flex flex-wrap items-center gap-space-sm">
            <span className="inline-flex px-space-sm py-0.5 bg-tertiary-fixed text-on-tertiary-fixed font-label-sm text-label-sm uppercase rounded rotate-[-2deg] shadow-[2px_2px_0px_#00170b]">
              Live evaluate_task
            </span>
            <LiveStatusPill state={task.state} />
          </div>
          <h1 className="font-headline-lg text-headline-lg-mobile md:text-headline-lg text-primary tracking-tight">
            Validation & decision
          </h1>
          <p className="font-body-lg text-body-lg text-on-surface-variant">
            Any connected Studio-dev wallet may call evaluate_task. The connected account pays the freshly quoted fee
            deposit. The AI decision is whatever get_task stores after execution — approval is not assumed.
          </p>
        </div>
        <CopyButton value={task.task_id} label="Copy task id" />
      </div>

      <section className="bg-surface-container-lowest p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-md">
        <h2 className="font-headline-sm text-headline-sm uppercase text-primary">Submitted translation</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-space-md">
          <div>
            <p className="font-label-sm text-label-sm uppercase text-on-surface-variant">Source ({task.source_locale})</p>
            <p className="font-title-md text-title-md text-primary mt-space-xs whitespace-pre-wrap">{task.source_text}</p>
          </div>
          <div>
            <p className="font-label-sm text-label-sm uppercase text-on-surface-variant">
              Stored translation ({task.target_locale})
            </p>
            <p className="font-title-md text-title-md text-primary mt-space-xs whitespace-pre-wrap">
              {task.translation || "get_task has an empty translation."}
            </p>
            {task.translation ? <CopyButton value={task.translation} label="Copy translation" /> : null}
          </div>
        </div>
        <p className="font-body-sm text-body-sm text-on-surface-variant">
          {settled.contractDecision}. payout_submitted={String(task.payout_submitted)}. {PAYOUT_SUBMITTED_IS_NOT_PAYMENT}
        </p>
        {approved ? (
          <div className="p-space-md rounded bg-primary-fixed text-on-primary-fixed">
            <p className="font-title-lg text-title-lg uppercase">Approved</p>
            <p className="font-body-sm text-body-sm mt-space-xs">Contract decision is approved. Transfer and balance stay separate fields.</p>
          </div>
        ) : null}
        {rejected ? (
          <div className="p-space-md rounded bg-secondary-fixed text-on-secondary-fixed">
            <p className="font-title-lg text-title-lg uppercase">Rejected</p>
            <p className="font-body-sm text-body-sm mt-space-xs">
              Contract decision is rejected. This translation is not an approved library entry.
            </p>
          </div>
        ) : null}
        {task.state === STATE_SUBMITTED && record.txId && isTerminalFailure(record) ? (
          <div className="p-space-md rounded bg-tertiary-fixed text-on-tertiary-fixed">
            <p className="font-title-lg text-title-lg uppercase">Evaluation failed closed</p>
            <p className="font-body-sm text-body-sm mt-space-xs">
              Parent {record.txId} is FINALIZED without isSuccessful. The task stays submitted for a deliberate New
              attempt. Do not resubmit that hash.
            </p>
          </div>
        ) : null}
      </section>

      <section className="flex flex-col gap-space-md">
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-space-sm">
          <h2 className="font-headline-sm text-headline-sm uppercase text-primary">Separate evidence fields</h2>
          <CopyButton value={evidenceJson} label="Copy evidence JSON" />
        </div>
        <p className="font-body-sm text-body-sm text-on-surface-variant max-w-3xl">
          Copy evidence JSON uses get_task plus this browser’s evaluate snapshots and receipt. Create and submit hashes
          appear only when this browser stored them for this task. Missing fields are omitted.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-space-md">
          <Cell kicker="Field 01" title="Transaction status" value={settled.transactionStatus} />
          <Cell kicker="Field 02" title="Execution result" value={settled.execution} />
          <Cell kicker="Field 03" title="Contract decision" value={settled.contractDecision} />
          <Cell kicker="Field 04" title="Outgoing EthSend" value={settled.outgoingEthSend ?? settled.transferDelivery} />
          <Cell kicker="Field 05" title="Child credit" value={settled.childCredit ?? "UNPROVEN"} />
          <Cell kicker="Field 06" title="Receipt fee" value={settled.receiptFee ?? "UNPROVEN"} />
          <Cell kicker="Field 07" title="Fee equation" value={settled.feeEquation ?? "UNPROVEN"} />
          <Cell kicker="Field 08" title="Balance evidence" value={settled.balanceEvidence} />
        </div>
        <p className="font-body-sm text-body-sm text-on-surface-variant">
          Verdict {settled.paymentEvidence}. {settled.paymentReason}
        </p>
      </section>

      <WalletCard />

      <section className="bg-primary-container text-inverse-on-surface p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-md">
        <h2 className="font-headline-sm text-headline-sm uppercase">evaluate_task</h2>
        <p className="font-body-md text-body-md text-primary-fixed-dim max-w-3xl">
          Fee payer: {wallet.address ?? "connect a wallet"}. {FEE_DEPOSIT_LABEL}:{" "}
          {record.quotedFeeWei ? formatGen(BigInt(record.quotedFeeWei)) : "not quoted"}. Attached value is 0. This is not
          restricted to the funder.
        </p>
        {record.error ? (
          <p className="bg-error-container text-on-error-container p-space-md rounded font-body-sm text-body-sm">
            {record.error}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-space-sm">
          <button
            type="button"
            disabled={!estimateGuard.ok || record.phase === "quoting"}
            className="px-space-lg py-space-md bg-surface-container text-on-surface font-label-md text-label-md uppercase rounded shadow-[3px_3px_0px_#00170b] disabled:opacity-50"
            onClick={() => void onEstimate()}
          >
            {record.phase === "quoting" ? "Estimating…" : "Estimate fee"}
          </button>
          <button
            type="button"
            disabled={
              record.txId && !isTerminalFailure(record)
                ? neverResubmit(record) !== "resume"
                : !estimateGuard.ok || record.phase === "signing" || record.phase !== "quoted"
            }
            className="px-space-lg py-space-md bg-secondary-container text-on-secondary-container font-headline-sm text-title-lg uppercase rounded shadow-[4px_4px_0px_#00170b] disabled:opacity-50"
            onClick={() => void onSign()}
          >
            {record.txId && !isTerminalFailure(record)
              ? "Resume tracking"
              : record.phase === "signing"
                ? "Waiting for wallet…"
                : "Sign evaluate_task"}
          </button>
          {retryable ? (
            <button
              type="button"
              className="px-space-lg py-space-md bg-tertiary-fixed text-on-tertiary-fixed font-label-md text-label-md uppercase rounded shadow-[3px_3px_0px_#00170b]"
              onClick={onNewAttempt}
            >
              New attempt
            </button>
          ) : null}
        </div>
        <WriteAttemptHistory entries={record.attemptHistory} currentTxId={record.txId} />
        {!estimateGuard.ok ? (
          <p className="font-body-sm text-body-sm text-tertiary-fixed">{estimateGuard.reason}</p>
        ) : null}
      </section>

      <AppPreview
        body={previewBody}
        locale={approved ? task.target_locale : task.source_locale}
        caption={
          approved
            ? "Preview injects the approved on-chain translation. This is a CSS mock, not a live in-app host."
            : rejected
              ? "Rejected translation is not shown as approved. Preview stays on the source string."
              : "Preview stays on the source until get_task reports approved."
        }
      />

      {approved ? (
        <Link
          to={liveLibraryHref()}
          className="inline-flex items-center gap-space-sm font-label-md text-label-md uppercase text-secondary"
        >
          Open live string library
          <Icon name="arrow_forward" />
        </Link>
      ) : (
        <Link to="/v1" className="inline-flex items-center gap-space-sm font-label-md text-label-md uppercase text-secondary">
          Back to task board
          <Icon name="arrow_forward" />
        </Link>
      )}
    </div>
  );
}

function Cell({ title, kicker, value }: { title: string; kicker: string; value: string }) {
  return (
    <div className="bg-surface-container-lowest p-space-md rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-xs">
      <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">{kicker}</span>
      <h3 className="font-title-lg text-title-lg text-primary uppercase">{title}</h3>
      <p className="font-body-sm text-body-sm text-primary break-words">{value}</p>
    </div>
  );
}
