import { useCallback, useEffect, useRef, useState } from "react";
import { WriteAttemptHistory } from "./WriteAttemptHistory";
import { isUserRejection } from "../live/eip1193";
import { FEE_DEPOSIT_LABEL, formatError, formatGen } from "../live/format";
import { PAYOUT_SUBMITTED_IS_NOT_PAYMENT } from "../live/product/evidence";
import { expectedWalletSpendWei } from "../live/productUi/form";
import { applyTxSignCatch } from "../live/productUi/attemptHistory";
import type { ProductV2Task } from "../live/productV2/task";
import { acceptClockView, expireClockView } from "../live/productV2/expireClock";
import {
  acceptConfirmStored,
  acceptEstimateAllowed,
  cancelEstimateAllowed,
  expireEstimateAllowed,
  failedAcceptStillOpen,
  failedCancelStillUnaccepted,
  failedExpireStillUnsubmitted,
  failedRecoverStillSubmitted,
  isNamedTranslator,
  isTaskFunder,
  isTerminalFailure,
  needsWriteResume,
  neverResubmit,
  recoverEstimateAllowed,
  showV2Accept,
  showV2Cancel,
} from "../live/productUiV2/guards";
import {
  estimateV2Write,
  signV2WriteBlocker,
  submitV2WriteTx,
  trackV2WriteTx,
} from "../live/productUiV2/writeFlow";
import {
  putV2Write,
  retryFailedV2Write,
  writeIdentityOrEmpty,
  type ProductUiV2WriteRecord,
} from "../live/productUiV2/writes";
import { useWallet } from "../live/WalletContext";
import { shortenAddress } from "../lib/addresses";

export function V2TaskActions({
  task,
  onTask,
}: {
  task: ProductV2Task;
  onTask: (task: ProductV2Task) => void;
}) {
  const wallet = useWallet();
  const [nowUnix, setNowUnix] = useState(() => Math.floor(Date.now() / 1000));
  const [acceptRecord, setAcceptRecord] = useState<ProductUiV2WriteRecord>(() =>
    writeIdentityOrEmpty({ wallet: wallet.address, chainId: wallet.chainId, taskId: task.task_id, action: "accept" }),
  );
  const [cancelRecord, setCancelRecord] = useState<ProductUiV2WriteRecord>(() =>
    writeIdentityOrEmpty({ wallet: wallet.address, chainId: wallet.chainId, taskId: task.task_id, action: "cancel" }),
  );
  const [expireRecord, setExpireRecord] = useState<ProductUiV2WriteRecord>(() =>
    writeIdentityOrEmpty({ wallet: wallet.address, chainId: wallet.chainId, taskId: task.task_id, action: "expire" }),
  );
  const [recoverRecord, setRecoverRecord] = useState<ProductUiV2WriteRecord>(() =>
    writeIdentityOrEmpty({ wallet: wallet.address, chainId: wallet.chainId, taskId: task.task_id, action: "recover" }),
  );
  const resumed = useRef("");

  useEffect(() => {
    const id = window.setInterval(() => setNowUnix(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(id);
  }, []);

  const persistAccept = useCallback(
    (next: ProductUiV2WriteRecord, nextTask?: ProductV2Task) => {
      putV2Write(next);
      setAcceptRecord(next);
      if (nextTask) onTask(nextTask);
      return next;
    },
    [onTask],
  );
  const persistCancel = useCallback(
    (next: ProductUiV2WriteRecord, nextTask?: ProductV2Task) => {
      putV2Write(next);
      setCancelRecord(next);
      if (nextTask) onTask(nextTask);
      return next;
    },
    [onTask],
  );
  const persistExpire = useCallback(
    (next: ProductUiV2WriteRecord, nextTask?: ProductV2Task) => {
      putV2Write(next);
      setExpireRecord(next);
      if (nextTask) onTask(nextTask);
      return next;
    },
    [onTask],
  );
  const persistRecover = useCallback(
    (next: ProductUiV2WriteRecord, nextTask?: ProductV2Task) => {
      putV2Write(next);
      setRecoverRecord(next);
      if (nextTask) onTask(nextTask);
      return next;
    },
    [onTask],
  );

  useEffect(() => {
    if (!wallet.address || wallet.chainId == null) return;
    setAcceptRecord(
      writeIdentityOrEmpty({ wallet: wallet.address, chainId: wallet.chainId, taskId: task.task_id, action: "accept" }),
    );
    setCancelRecord(
      writeIdentityOrEmpty({ wallet: wallet.address, chainId: wallet.chainId, taskId: task.task_id, action: "cancel" }),
    );
    setExpireRecord(
      writeIdentityOrEmpty({ wallet: wallet.address, chainId: wallet.chainId, taskId: task.task_id, action: "expire" }),
    );
    setRecoverRecord(
      writeIdentityOrEmpty({ wallet: wallet.address, chainId: wallet.chainId, taskId: task.task_id, action: "recover" }),
    );
  }, [task.task_id, wallet.address, wallet.chainId]);

  useEffect(() => {
    if (!wallet.address || wallet.chainId == null) return;
    const accept = writeIdentityOrEmpty({
      wallet: wallet.address,
      chainId: wallet.chainId,
      taskId: task.task_id,
      action: "accept",
    });
    const cancel = writeIdentityOrEmpty({
      wallet: wallet.address,
      chainId: wallet.chainId,
      taskId: task.task_id,
      action: "cancel",
    });
    const expire = writeIdentityOrEmpty({
      wallet: wallet.address,
      chainId: wallet.chainId,
      taskId: task.task_id,
      action: "expire",
    });
    const recover = writeIdentityOrEmpty({
      wallet: wallet.address,
      chainId: wallet.chainId,
      taskId: task.task_id,
      action: "recover",
    });
    const key = `${accept.key}|${cancel.key}|${expire.key}|${recover.key}|${accept.txId ?? ""}|${cancel.txId ?? ""}|${expire.txId ?? ""}|${recover.txId ?? ""}`;
    if (resumed.current === key) return;
    resumed.current = key;
    if (accept.txId && (needsWriteResume(accept) || accept.statusName === "FINALIZED")) {
      void trackV2WriteTx(accept, accept.txId, persistAccept);
    }
    if (cancel.txId && (needsWriteResume(cancel) || cancel.statusName === "FINALIZED")) {
      void trackV2WriteTx(cancel, cancel.txId, persistCancel);
    }
    if (expire.txId && (needsWriteResume(expire) || expire.statusName === "FINALIZED")) {
      void trackV2WriteTx(expire, expire.txId, persistExpire);
    }
    if (recover.txId && (needsWriteResume(recover) || recover.statusName === "FINALIZED")) {
      void trackV2WriteTx(recover, recover.txId, persistRecover);
    }
  }, [persistAccept, persistCancel, persistExpire, persistRecover, task.task_id, wallet.address, wallet.chainId]);

  const ctx = { wallet: wallet.address, chainId: wallet.chainId, connected: wallet.connected };
  const canShowAccept = showV2Accept(task, nowUnix) || Boolean(acceptRecord.txId);
  const canShowCancel = showV2Cancel(task) || Boolean(cancelRecord.txId);
  const translator = isNamedTranslator(task, wallet.address);
  const funder = isTaskFunder(task, wallet.address);
  const acceptGuard = acceptEstimateAllowed({ task, record: acceptRecord, ctx, nowUnix });
  const cancelGuard = cancelEstimateAllowed({ task, record: cancelRecord, ctx });
  const expireGuard = expireEstimateAllowed({ task, record: expireRecord, ctx, wallUnix: nowUnix });
  const recoverGuard = recoverEstimateAllowed({ task, record: recoverRecord, ctx, wallUnix: nowUnix });
  const acceptConfirm = acceptConfirmStored(task);
  const expireView = expireClockView(task.submit_by_unix, nowUnix);
  const acceptView = acceptClockView(task.submit_by_unix, nowUnix);
  const unsubmitted = task.translation === "" && (task.state === "open" || task.state === "accepted");

  return (
    <div className="flex flex-col gap-space-md">
      {unsubmitted ? (
        <section className="bg-surface-container-lowest p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-sm">
          <h2 className="font-headline-sm text-headline-sm uppercase text-primary">Submission window</h2>
          <p className="font-body-sm text-body-sm text-on-surface-variant">{acceptView.countdownLabel}</p>
          <p className="font-body-sm text-body-sm text-on-surface-variant">{expireView.countdownLabel}</p>
          <p className="font-body-sm text-body-sm text-on-surface-variant">
            submit_by_unix {task.submit_by_unix} · local {expireView.localDate}. accept_task needs now &lt; submit_by.
            expire_unsubmitted_task needs now &gt; submit_by. recover_undecided_task uses recovery_opens_at_unix after a submitted task remains undecided.
          </p>
        </section>
      ) : null}

      {canShowAccept ? (
        <WritePanel
          title="accept_task"
          blurb={
            translator
              ? "Only the named translator may Estimate and Sign accept_task while the task is OPEN, unaccepted, and now < submit_by_unix. After FINALIZED success, get_task must show state=accepted and accepted_at_unix > 0."
              : `Only named translator ${shortenAddress(task.translator)} may accept. Demo roles are not used.`
          }
          record={acceptRecord}
          estimateOk={acceptGuard.ok}
          estimateReason={acceptGuard.ok ? undefined : acceptGuard.reason}
          retryable={failedAcceptStillOpen(task, acceptRecord, nowUnix)}
          confirm={
            acceptRecord.txId && acceptRecord.statusName === "FINALIZED"
              ? acceptConfirm.ok
                ? `get_task state=${task.state}, accepted_at_unix=${task.accepted_at_unix}.`
                : acceptConfirm.reason
              : undefined
          }
          onEstimate={async () => {
            try {
              const identity = await wallet.verifyBeforeWrite();
              const next = await estimateV2Write({
                action: "accept",
                taskId: task.task_id,
                identity,
                nowUnix,
              });
              persistAccept(next.record, next.task);
            } catch (err) {
              persistAccept({
                ...acceptRecord,
                phase: "idle",
                error: isUserRejection(err) ? "Wallet rejected the fee estimate." : formatError(err),
              });
            }
          }}
          onSign={async () => {
            if (neverResubmit(acceptRecord) === "resume" && !isTerminalFailure(acceptRecord)) {
              if (acceptRecord.txId) await trackV2WriteTx(acceptRecord, acceptRecord.txId, persistAccept);
              return;
            }
            try {
              const identity = await wallet.verifyBeforeWrite();
              const blocker = await signV2WriteBlocker({
                action: "accept",
                taskId: task.task_id,
                identity,
                nowUnix,
              });
              if (!blocker.ok) {
                persistAccept(blocker.record, blocker.task);
                return;
              }
              if (!wallet.provider) throw new Error("Connect a wallet before signing.");
              persistAccept({ ...blocker.record, phase: "signing", error: undefined });
              const submitted = await submitV2WriteTx({
                record: blocker.record,
                task: blocker.task,
                identity,
                provider: wallet.provider,
                estimate: blocker.estimate,
              });
              persistAccept(submitted.record, blocker.task);
              await trackV2WriteTx(submitted.record, submitted.txId, persistAccept);
            } catch (err) {
              persistAccept(
                applyTxSignCatch(
                  writeIdentityOrEmpty({
                    wallet: wallet.address,
                    chainId: wallet.chainId,
                    taskId: task.task_id,
                    action: "accept",
                  }),
                  err,
                ),
              );
            }
          }}
          onRetry={() => {
            resumed.current = "";
            persistAccept(retryFailedV2Write(acceptRecord), task);
          }}
        />
      ) : null}

      {canShowCancel ? (
        <WritePanel
          title="cancel_task"
          blurb={
            funder
              ? "Only the connected funder may Estimate and Sign cancel_task while the task is OPEN and unaccepted. After accept_task, funder cancel is unavailable."
              : `Only funder ${shortenAddress(task.funder)} may cancel. Connected wallet is a read-only viewer.`
          }
          record={cancelRecord}
          estimateOk={cancelGuard.ok}
          estimateReason={cancelGuard.ok ? undefined : cancelGuard.reason}
          retryable={failedCancelStillUnaccepted(task, cancelRecord)}
          confirm={
            cancelRecord.txId
              ? `Parent ${cancelRecord.statusName ?? "unknown"} · execution ${cancelRecord.executionName ?? "—"} · get_task state ${task.state}. Transfer delivery stays a separate field.`
              : undefined
          }
          onEstimate={async () => {
            try {
              const identity = await wallet.verifyBeforeWrite();
              const next = await estimateV2Write({
                action: "cancel",
                taskId: task.task_id,
                identity,
                nowUnix,
              });
              persistCancel(next.record, next.task);
            } catch (err) {
              persistCancel({
                ...cancelRecord,
                phase: "idle",
                error: isUserRejection(err) ? "Wallet rejected the fee estimate." : formatError(err),
              });
            }
          }}
          onSign={async () => {
            if (neverResubmit(cancelRecord) === "resume" && !isTerminalFailure(cancelRecord)) {
              if (cancelRecord.txId) await trackV2WriteTx(cancelRecord, cancelRecord.txId, persistCancel);
              return;
            }
            try {
              const identity = await wallet.verifyBeforeWrite();
              const blocker = await signV2WriteBlocker({
                action: "cancel",
                taskId: task.task_id,
                identity,
                nowUnix,
              });
              if (!blocker.ok) {
                persistCancel(blocker.record, blocker.task);
                return;
              }
              if (!wallet.provider) throw new Error("Connect a wallet before signing.");
              persistCancel({ ...blocker.record, phase: "signing", error: undefined });
              const submitted = await submitV2WriteTx({
                record: blocker.record,
                task: blocker.task,
                identity,
                provider: wallet.provider,
                estimate: blocker.estimate,
              });
              persistCancel(submitted.record, blocker.task);
              await trackV2WriteTx(submitted.record, submitted.txId, persistCancel);
            } catch (err) {
              persistCancel(
                applyTxSignCatch(
                  writeIdentityOrEmpty({
                    wallet: wallet.address,
                    chainId: wallet.chainId,
                    taskId: task.task_id,
                    action: "cancel",
                  }),
                  err,
                ),
              );
            }
          }}
          onRetry={() => {
            resumed.current = "";
            persistCancel(retryFailedV2Write(cancelRecord), task);
          }}
        />
      ) : null}

      {(expireGuard.ok || Boolean(expireRecord.txId)) ? (
        <WritePanel
          title="expire_unsubmitted_task"
          blurb="Any connected Studio-dev wallet may Estimate and Sign expire_unsubmitted_task for an OPEN or ACCEPTED unsubmitted V2 task after now > submit_by_unix. The refund recipient is the stored funder."
          record={expireRecord}
          estimateOk={expireGuard.ok}
          estimateReason={expireGuard.ok ? undefined : expireGuard.reason}
          retryable={failedExpireStillUnsubmitted(task, expireRecord, nowUnix)}
          confirm={
            expireRecord.txId
              ? `Parent ${expireRecord.statusName ?? "unknown"} · execution ${expireRecord.executionName ?? "—"} · get_task state ${task.state}. Transfer delivery stays a separate field.`
              : undefined
          }
          onEstimate={async () => {
            try {
              const identity = await wallet.verifyBeforeWrite();
              const next = await estimateV2Write({ action: "expire", taskId: task.task_id, identity, nowUnix });
              persistExpire(next.record, next.task);
            } catch (err) {
              persistExpire({ ...expireRecord, phase: "idle", error: isUserRejection(err) ? "Wallet rejected the fee estimate." : formatError(err) });
            }
          }}
          onSign={async () => {
            if (neverResubmit(expireRecord) === "resume" && !isTerminalFailure(expireRecord)) {
              if (expireRecord.txId) await trackV2WriteTx(expireRecord, expireRecord.txId, persistExpire);
              return;
            }
            try {
              const identity = await wallet.verifyBeforeWrite();
              const blocker = await signV2WriteBlocker({ action: "expire", taskId: task.task_id, identity, nowUnix });
              if (!blocker.ok) {
                persistExpire(blocker.record, blocker.task);
                return;
              }
              if (!wallet.provider) throw new Error("Connect a wallet before signing.");
              persistExpire({ ...blocker.record, phase: "signing", error: undefined });
              const submitted = await submitV2WriteTx({ record: blocker.record, task: blocker.task, identity, provider: wallet.provider, estimate: blocker.estimate });
              persistExpire(submitted.record, blocker.task);
              await trackV2WriteTx(submitted.record, submitted.txId, persistExpire);
            } catch (err) {
              persistExpire(applyTxSignCatch(writeIdentityOrEmpty({ wallet: wallet.address, chainId: wallet.chainId, taskId: task.task_id, action: "expire" }) as never, err) as ProductUiV2WriteRecord);
            }
          }}
          onRetry={() => {
            resumed.current = "";
            persistExpire(retryFailedV2Write(expireRecord), task);
          }}
        />
      ) : null}

      {(recoverGuard.ok || Boolean(recoverRecord.txId)) ? (
        <WritePanel
          title="recover_undecided_task"
          blurb="Any connected Studio-dev wallet may Estimate and Sign recover_undecided_task after recovery_opens_at_unix when a submitted task is still undecided. The refund recipient is the stored funder."
          record={recoverRecord}
          estimateOk={recoverGuard.ok}
          estimateReason={recoverGuard.ok ? undefined : recoverGuard.reason}
          retryable={failedRecoverStillSubmitted(task, recoverRecord)}
          confirm={
            recoverRecord.txId
              ? `Parent ${recoverRecord.statusName ?? "unknown"} · execution ${recoverRecord.executionName ?? "—"} · get_task state ${task.state}. Transfer delivery stays a separate field.`
              : undefined
          }
          onEstimate={async () => {
            try {
              const identity = await wallet.verifyBeforeWrite();
              const next = await estimateV2Write({ action: "recover", taskId: task.task_id, identity, nowUnix });
              persistRecover(next.record, next.task);
            } catch (err) {
              persistRecover({ ...recoverRecord, phase: "idle", error: isUserRejection(err) ? "Wallet rejected the fee estimate." : formatError(err) });
            }
          }}
          onSign={async () => {
            if (neverResubmit(recoverRecord) === "resume" && !isTerminalFailure(recoverRecord)) {
              if (recoverRecord.txId) await trackV2WriteTx(recoverRecord, recoverRecord.txId, persistRecover);
              return;
            }
            try {
              const identity = await wallet.verifyBeforeWrite();
              const blocker = await signV2WriteBlocker({ action: "recover", taskId: task.task_id, identity, nowUnix });
              if (!blocker.ok) {
                persistRecover(blocker.record, blocker.task);
                return;
              }
              if (!wallet.provider) throw new Error("Connect a wallet before signing.");
              persistRecover({ ...blocker.record, phase: "signing", error: undefined });
              const submitted = await submitV2WriteTx({ record: blocker.record, task: blocker.task, identity, provider: wallet.provider, estimate: blocker.estimate });
              persistRecover(submitted.record, blocker.task);
              await trackV2WriteTx(submitted.record, submitted.txId, persistRecover);
            } catch (err) {
              persistRecover(applyTxSignCatch(writeIdentityOrEmpty({ wallet: wallet.address, chainId: wallet.chainId, taskId: task.task_id, action: "recover" }) as never, err) as ProductUiV2WriteRecord);
            }
          }}
          onRetry={() => {
            resumed.current = "";
            persistRecover(retryFailedV2Write(recoverRecord), task);
          }}
        />
      ) : null}
    </div>
  );
}

function WritePanel({
  title,
  blurb,
  record,
  estimateOk,
  estimateReason,
  retryable,
  confirm,
  onEstimate,
  onSign,
  onRetry,
}: {
  title: string;
  blurb: string;
  record: ProductUiV2WriteRecord;
  estimateOk: boolean;
  estimateReason?: string;
  retryable: boolean;
  confirm?: string;
  onEstimate: () => Promise<void>;
  onSign: () => Promise<void>;
  onRetry: () => void;
}) {
  const feeWei = record.quotedFeeWei ? BigInt(record.quotedFeeWei) : null;
  const spendWei = feeWei != null ? expectedWalletSpendWei(0n, feeWei) : null;
  return (
    <section className="bg-primary-container text-inverse-on-surface p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-sm">
      <h2 className="font-headline-sm text-headline-sm uppercase">{title}</h2>
      <p className="font-body-sm text-body-sm text-primary-fixed-dim">{blurb}</p>
      <p className="font-body-sm text-body-sm text-primary-fixed-dim">
        {FEE_DEPOSIT_LABEL}: {feeWei != null ? formatGen(feeWei) : "not quoted"}. Expected wallet spend:{" "}
        {spendWei != null ? formatGen(spendWei) : "quote to see total"} (attached value 0).
      </p>
      <p className="font-body-sm text-body-sm text-primary-fixed-dim break-all">
        Tx: {record.txId ?? "none"} · {record.statusName ?? record.phase} · execution {record.executionName ?? "—"} ·
        parentSuccessful={String(Boolean(record.parentSuccessful))}
      </p>
      {confirm ? <p className="font-body-sm text-body-sm text-tertiary-fixed">{confirm}</p> : null}
      {record.error ? (
        <p className="bg-error-container text-on-error-container p-space-md rounded font-body-sm text-body-sm">{record.error}</p>
      ) : null}
      <div className="flex flex-wrap gap-space-sm">
        <button
          type="button"
          disabled={!estimateOk || record.phase === "quoting"}
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
              : !estimateOk || record.phase === "signing" || record.phase !== "quoted"
          }
          className="px-space-lg py-space-md bg-secondary-container text-on-secondary-container font-headline-sm text-title-lg uppercase rounded shadow-[4px_4px_0px_#00170b] disabled:opacity-50"
          onClick={() => void onSign()}
        >
          {record.txId && !isTerminalFailure(record)
            ? "Resume tracking"
            : record.phase === "signing"
              ? "Waiting for wallet…"
              : `Sign ${title}`}
        </button>
        {retryable ? (
          <button
            type="button"
            className="px-space-lg py-space-md bg-tertiary-fixed text-on-tertiary-fixed font-label-md text-label-md uppercase rounded shadow-[3px_3px_0px_#00170b]"
            onClick={onRetry}
          >
            New attempt
          </button>
        ) : null}
      </div>
      {estimateReason ? <p className="font-body-sm text-body-sm text-tertiary-fixed">{estimateReason}</p> : null}
      <WriteAttemptHistory entries={record.attemptHistory} currentTxId={record.txId} />
      <p className="font-body-sm text-body-sm text-primary-fixed-dim">
        Transaction status, execution, contract state, transfer delivery, and payment evidence stay separate.{" "}
        {PAYOUT_SUBMITTED_IS_NOT_PAYMENT}
      </p>
    </section>
  );
}
