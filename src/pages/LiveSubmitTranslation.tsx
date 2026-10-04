import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { CopyButton } from "../components/CopyButton";
import { Icon } from "../components/Icon";
import { LiveStatusPill } from "../components/LiveStatusPill";
import { WriteAttemptHistory } from "../components/WriteAttemptHistory";
import { addressesEqual, FEE_DEPOSIT_LABEL, formatError, formatGen } from "../live/format";
import { isUserRejection } from "../live/eip1193";
import type { ProductTask } from "../live/product/task";
import { MAX_TEXT, PRODUCT_UI_CONTRACT, STATE_OPEN } from "../live/productUi/constants";
import { loadLiveProductTask } from "../live/productUi/taskLoad";
import {
  estimateSubmit,
  signSubmitBlocker,
  submitSubmitTx,
  trackWriteTx,
  writeIdentityOrEmpty,
} from "../live/productUi/writeFlow";
import { applyTxSignCatch } from "../live/productUi/attemptHistory";
import { rememberedGenvmUnix } from "../live/product/clock";
import { executionSubmitDeadlineView } from "../live/productUi/submitClock";
import {
  failedSubmitStillOpen,
  isNamedTranslator,
  isTerminalFailure,
  needsWriteResume,
  neverResubmit,
  submitEstimateAllowed,
  submitSignAllowed,
} from "../live/productUi/writeGuards";
import { putWrite, retryFailedWrite, type ProductUiWriteRecord } from "../live/productUi/writes";
import { WalletCard } from "../live/WalletCard";
import { useWallet } from "../live/WalletContext";
import { liveTaskHref } from "../lib/paths";
import { shortenAddress } from "../lib/addresses";
import { wordCount } from "../lib/status";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "missing" }
  | { status: "ready"; task: ProductTask };

export function LiveSubmitTranslation() {
  const { id } = useParams();
  const wallet = useWallet();
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [text, setText] = useState("");
  const [record, setRecord] = useState<ProductUiWriteRecord>(() =>
    writeIdentityOrEmpty({ wallet: wallet.address, chainId: wallet.chainId, taskId: id ?? "", action: "submit" }),
  );
  const [nowUnix, setNowUnix] = useState(() => Math.floor(Date.now() / 1000));
  const resumedKey = useRef("");

  const persistRecord = useCallback((next: ProductUiWriteRecord, task?: ProductTask) => {
    putWrite(next);
    setRecord(next);
    if (task) setLoad({ status: "ready", task });
    return next;
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNowUnix(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(timer);
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
        setText(task.translation || "");
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
    const stored = writeIdentityOrEmpty({
      wallet: wallet.address,
      chainId: wallet.chainId,
      taskId: id,
      action: "submit",
    });
    setRecord(stored);
    if (stored.boundTranslation && !stored.txId) setText(stored.boundTranslation);
  }, [id, wallet.address, wallet.chainId]);

  useEffect(() => {
    if (!id || !wallet.address || wallet.chainId == null) return;
    const stored = writeIdentityOrEmpty({
      wallet: wallet.address,
      chainId: wallet.chainId,
      taskId: id,
      action: "submit",
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
        <p className="font-body-md text-body-md mt-space-sm">This id is not a live contract task.</p>
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
  const named = isNamedTranslator(task, wallet.address);
  const ctx = { wallet: wallet.address, chainId: wallet.chainId, connected: wallet.connected };
  const estimateGuard = submitEstimateAllowed({
    task,
    record,
    ctx,
    translation: text,
    wallUnix: nowUnix,
  });
  const signGuard = submitSignAllowed({
    task,
    record,
    ctx,
    translation: text,
    wallUnix: nowUnix,
  });
  const deadline = executionSubmitDeadlineView(task, nowUnix, record.rememberedGenvmUnix ?? rememberedGenvmUnix(nowUnix));
  const retryable = failedSubmitStillOpen(task, record);
  const writable = named && task.state === STATE_OPEN && task.translation === "" && !record.txId;
  const chars = text.length;

  async function onEstimate() {
    if (!id) return;
    try {
      const identity = await wallet.verifyBeforeWrite();
      const next = await estimateSubmit({ taskId: id, translation: text, identity });
      persistRecord(next.record, next.task);
    } catch (err) {
      persistRecord(
        withError(
          writeIdentityOrEmpty({ wallet: wallet.address, chainId: wallet.chainId, taskId: id, action: "submit" }),
          isUserRejection(err) ? "Wallet rejected the fee estimate." : formatError(err),
        ),
      );
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
      const blocker = await signSubmitBlocker({ taskId: id, translation: text, identity });
      if (!blocker.ok) {
        persistRecord(blocker.record, blocker.task);
        return;
      }
      if (!wallet.provider) throw new Error("Connect a wallet before signing.");
      persistRecord({ ...blocker.record, phase: "signing", error: undefined });
      const submitted = await submitSubmitTx({
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
        action: "submit",
      });
      persistRecord(applyTxSignCatch(live, err));
    }
  }

  function onNewAttempt() {
    if (!retryable) return;
    resumedKey.current = "";
    persistRecord(retryFailedWrite(record), task);
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (record.phase === "quoted" && signGuard.ok) void onSign();
    else void onEstimate();
  }

  return (
    <div className="w-full px-gutter py-space-xl max-w-7xl mx-auto flex flex-col gap-space-xl">
      <div className="flex flex-wrap items-center justify-between gap-space-md">
        <Link
          to={liveTaskHref(task.task_id)}
          className="inline-flex items-center gap-1 font-label-sm text-label-sm uppercase text-on-surface-variant hover:text-primary"
        >
          <Icon name="arrow_back" className="text-sm" />
          Back to task detail
        </Link>
        <div className="flex items-center gap-space-sm">
          <LiveStatusPill state={task.state} />
          <span className="font-label-sm text-label-sm uppercase bg-tertiary-fixed text-on-tertiary-fixed px-space-sm py-0.5 rounded shadow-[2px_2px_0px_#00170b] rotate-[-2deg]">
            Live get_task
          </span>
        </div>
      </div>

      <div className="flex flex-col md:flex-row md:items-end justify-between gap-space-md">
        <div>
          <h1 className="font-display-lg text-display-lg-mobile md:text-headline-lg text-primary uppercase tracking-tight">
            Submit translation
          </h1>
          <p className="font-body-lg text-body-lg text-on-surface-variant mt-space-xs">
            {task.string_key} · {PRODUCT_UI_CONTRACT.slice(0, 8)}…{PRODUCT_UI_CONTRACT.slice(-4)} · submit_translation
          </p>
          {task.state === STATE_OPEN && task.translation === "" ? (
            <p className="font-body-sm text-body-sm text-secondary mt-space-sm max-w-2xl">
              The funder may cancel this open task before submit_translation is finalized. Off-chain draft work is not
              protected by the deployed contract.
            </p>
          ) : null}
        </div>
        <CopyButton value={task.task_id} label="Copy task id" />
      </div>

      {!writable ? (
        <div className="bg-surface-container-high p-space-md rounded shadow-[2px_2px_0px_#00170b]">
          <p className="font-title-md text-title-md text-primary">Read-only view</p>
          <p className="font-body-md text-body-md text-on-surface-variant mt-space-xs">
            {named
              ? task.translation
                ? "This task already has a stored translation. The named translator cannot overwrite it here."
                : estimateGuard.ok
                  ? "Estimate the fee, then sign in the wallet."
                  : estimateGuard.reason
              : `Only the named translator ${shortenAddress(task.translator)} may estimate and sign submit_translation. Everyone else sees the source and stored text.`}
          </p>
        </div>
      ) : null}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-space-xl">
        <div className="lg:col-span-5 flex flex-col gap-space-md">
          <section className="bg-surface-container-lowest p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-md">
            <h2 className="font-headline-sm text-headline-sm uppercase text-primary">Source & directives</h2>
            <p className="font-label-sm text-label-sm uppercase text-on-surface-variant">
              {task.source_locale} → {task.target_locale}
            </p>
            <blockquote className="font-title-lg text-title-lg text-primary border-l-4 border-l-secondary-container pl-space-md italic">
              “{task.source_text}”
            </blockquote>
            <p className="font-body-sm text-body-sm text-on-surface-variant">
              {wordCount(task.source_text)} words · {task.source_text.length} characters
            </p>
            <p className="font-body-md text-body-md text-on-surface-variant">
              <span className="font-label-sm text-label-sm uppercase">Context: </span>
              {task.app_context || "No app context stored."}
            </p>
            <p className="font-body-md text-body-md text-on-surface-variant">
              <span className="font-label-sm text-label-sm uppercase">Intended meaning: </span>
              {task.intended_meaning}
            </p>
            <div>
              <p className="font-label-sm text-label-sm uppercase text-on-surface-variant">Semantic criteria</p>
              <p className="font-body-md text-body-md text-primary whitespace-pre-wrap mt-space-xs">{task.semantic_criteria}</p>
            </div>
          </section>
        </div>

        <form onSubmit={onSubmit} className="lg:col-span-7 flex flex-col gap-space-md">
          <section className="bg-surface-container-lowest p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-md">
            <div className="flex items-center justify-between">
              <h2 className="font-headline-sm text-headline-sm uppercase text-primary">Target string</h2>
              <span className="font-label-sm text-label-sm uppercase text-on-surface-variant">
                {chars} / {MAX_TEXT} chars
              </span>
            </div>
            <textarea
              rows={6}
              readOnly={!writable}
              className="w-full bg-surface-container-low p-space-md font-title-lg text-title-lg text-primary outline-none rounded resize-y"
              placeholder="Write the translation…"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <CopyButton value={text} label="Copy translation" />
          </section>

          <WalletCard />

          <section className="bg-primary-container text-inverse-on-surface p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-sm">
            <p className="font-title-md text-title-md">Fee deposit and tracking</p>
            <p className="font-body-sm text-body-sm text-primary-fixed-dim">{deadline.countdownLabel}</p>
            <p className="font-body-sm text-body-sm text-primary-fixed-dim">{deadline.gateLabel}</p>
            <p className="font-body-sm text-body-sm text-primary-fixed-dim">
              {FEE_DEPOSIT_LABEL}: {record.quotedFeeWei ? formatGen(BigInt(record.quotedFeeWei)) : "not quoted"}. Attached
              value is 0. Recheck wallet, chain, open task, empty stored translation, execution-clock deadline, text, and quote before signing.
            </p>
            <p className="font-body-sm text-body-sm text-primary-fixed-dim break-all">
              Tx: {record.txId ?? "none"} · {record.statusName ?? record.phase} · execution {record.executionName ?? "—"} ·
              parentSuccessful={String(Boolean(record.parentSuccessful))}
            </p>
            {record.error ? (
              <p className="bg-error-container text-on-error-container p-space-md rounded font-body-sm text-body-sm">
                {record.error}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-space-sm pt-space-sm">
              <button
                type="button"
                disabled={!estimateGuard.ok || record.phase === "quoting"}
                className="px-space-lg py-space-md bg-surface-container text-on-surface font-label-md text-label-md uppercase rounded shadow-[3px_3px_0px_#00170b] disabled:opacity-50"
                onClick={() => void onEstimate()}
              >
                {record.phase === "quoting" ? "Estimating…" : "Estimate fee"}
              </button>
              <button
                type="submit"
                disabled={
                  record.txId && !isTerminalFailure(record)
                    ? neverResubmit(record) !== "resume"
                    : !signGuard.ok || record.phase === "signing"
                }
                className="px-space-lg py-space-md bg-secondary-container text-on-secondary-container font-headline-sm text-title-lg uppercase rounded shadow-[4px_4px_0px_#00170b] disabled:opacity-50"
              >
                {record.txId && !isTerminalFailure(record)
                  ? "Resume tracking"
                  : record.phase === "signing"
                    ? "Waiting for wallet…"
                    : "Sign submit_translation"}
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
            {!named && wallet.address ? (
              <p className="font-body-sm text-body-sm text-tertiary-fixed">
                Connected {shortenAddress(wallet.address)} is not the named translator. Connected equals translator:{" "}
                {String(addressesEqual(wallet.address, task.translator))}.
              </p>
            ) : null}
            {!signGuard.ok && writable ? (
              <p className="font-body-sm text-body-sm text-primary-fixed-dim">{signGuard.reason}</p>
            ) : null}
          </section>
        </form>
      </div>
    </div>
  );
}

function withError(record: ProductUiWriteRecord, error: string): ProductUiWriteRecord {
  return { ...record, phase: record.txId ? record.phase : "idle", error };
}
