import { useCallback, useEffect, useRef, useState } from "react";
import { isUserRejection } from "../live/eip1193";
import { FEE_DEPOSIT_LABEL, formatError, formatGen } from "../live/format";
import { PAYOUT_SUBMITTED_IS_NOT_PAYMENT } from "../live/product/evidence";
import type { ProductTask } from "../live/product/task";
import { expectedWalletSpendWei } from "../live/productUi/form";
import { productRecoveryClock } from "../live/productUi/recoverClock";
import { liveRefundEvidence, type RefundEvidenceView } from "../live/productUi/settlement";
import {
  estimateCancel,
  estimateRecover,
  signCancelBlocker,
  signRecoverBlocker,
  submitSettlementTx,
  trackWriteTx,
  writeIdentityOrEmpty,
} from "../live/productUi/writeFlow";
import {
  cancelEstimateAllowed,
  failedCancelStillOpen,
  failedRecoverStillSubmitted,
  isTaskFunder,
  isTerminalFailure,
  needsWriteResume,
  neverResubmit,
  recoverEstimateAllowed,
} from "../live/productUi/writeGuards";
import { WriteAttemptHistory } from "./WriteAttemptHistory";
import { applyTxSignCatch } from "../live/productUi/attemptHistory";
import { putWrite, retryFailedWrite, type ProductUiWriteRecord } from "../live/productUi/writes";
import { useWallet } from "../live/WalletContext";
import { shortenAddress } from "../lib/addresses";

export function LiveTaskEscrowActions({
  task,
  onTask,
}: {
  task: ProductTask;
  onTask: (task: ProductTask) => void;
}) {
  const wallet = useWallet();
  const [nowUnix, setNowUnix] = useState(() => Math.floor(Date.now() / 1000));
  const [cancelRecord, setCancelRecord] = useState<ProductUiWriteRecord>(() =>
    writeIdentityOrEmpty({ wallet: wallet.address, chainId: wallet.chainId, taskId: task.task_id, action: "cancel" }),
  );
  const [recoverRecord, setRecoverRecord] = useState<ProductUiWriteRecord>(() =>
    writeIdentityOrEmpty({ wallet: wallet.address, chainId: wallet.chainId, taskId: task.task_id, action: "recover" }),
  );
  const resumed = useRef<string>("");

  useEffect(() => {
    const id = window.setInterval(() => setNowUnix(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(id);
  }, []);

  const persistCancel = useCallback(
    (next: ProductUiWriteRecord, nextTask?: ProductTask) => {
      putWrite(next);
      setCancelRecord(next);
      if (nextTask) onTask(nextTask);
      return next;
    },
    [onTask],
  );
  const persistRecover = useCallback(
    (next: ProductUiWriteRecord, nextTask?: ProductTask) => {
      putWrite(next);
      setRecoverRecord(next);
      if (nextTask) onTask(nextTask);
      return next;
    },
    [onTask],
  );

  useEffect(() => {
    if (!wallet.address || wallet.chainId == null) return;
    setCancelRecord(
      writeIdentityOrEmpty({ wallet: wallet.address, chainId: wallet.chainId, taskId: task.task_id, action: "cancel" }),
    );
    setRecoverRecord(
      writeIdentityOrEmpty({ wallet: wallet.address, chainId: wallet.chainId, taskId: task.task_id, action: "recover" }),
    );
  }, [task.task_id, wallet.address, wallet.chainId]);

  useEffect(() => {
    if (!wallet.address || wallet.chainId == null) return;
    const cancel = writeIdentityOrEmpty({
      wallet: wallet.address,
      chainId: wallet.chainId,
      taskId: task.task_id,
      action: "cancel",
    });
    const recover = writeIdentityOrEmpty({
      wallet: wallet.address,
      chainId: wallet.chainId,
      taskId: task.task_id,
      action: "recover",
    });
    const key = `${cancel.key}|${recover.key}|${cancel.txId ?? ""}|${recover.txId ?? ""}`;
    if (resumed.current === key) return;
    resumed.current = key;
    if (cancel.txId && (needsWriteResume(cancel) || cancel.statusName === "FINALIZED")) {
      void trackWriteTx(cancel, cancel.txId, persistCancel);
    }
    if (recover.txId && (needsWriteResume(recover) || recover.statusName === "FINALIZED")) {
      void trackWriteTx(recover, recover.txId, persistRecover);
    }
  }, [persistCancel, persistRecover, task.task_id, wallet.address, wallet.chainId]);

  const ctx = { wallet: wallet.address, chainId: wallet.chainId, connected: wallet.connected };
  const clock = productRecoveryClock(task.recovery_opens_at_unix, nowUnix);
  const showCancel = task.state === "open" && task.translation === "" && task.decision === "none";
  const showRecover = task.state === "submitted" && task.decision === "none";
  const funder = isTaskFunder(task, wallet.address);
  const cancelGuard = cancelEstimateAllowed({ task, record: cancelRecord, ctx });
  const recoverGuard = recoverEstimateAllowed({ task, record: recoverRecord, ctx, wallUnix: nowUnix });

  if (!showCancel && !showRecover && !cancelRecord.txId && !recoverRecord.txId) return null;

  const cancelBlurb = funder
    ? "Only the connected funder may estimate and sign cancel_task while the task is open with no stored translation. This refunds the funder. The named translator is not paid for unfinished work. Recheck wallet, chain, open task, empty translation, and the fee quote before signing."
    : `Only funder ${shortenAddress(task.funder)} may cancel. Connected wallet is a read-only viewer. While the task is open, the funder can still cancel before you submit.`;

  return (
    <div className="flex flex-col gap-space-md">
      {showCancel || cancelRecord.txId ? (
        <WritePanel
          title="cancel_task"
          blurb={cancelBlurb}
          record={cancelRecord}
          estimateOk={cancelGuard.ok}
          estimateReason={cancelGuard.ok ? undefined : cancelGuard.reason}
          retryable={failedCancelStillOpen(task, cancelRecord)}
          evidence={cancelRecord.txId ? liveRefundEvidence({ task, record: cancelRecord, expected: "cancel" }) : undefined}
          onEstimate={async () => {
            try {
              const identity = await wallet.verifyBeforeWrite();
              const next = await estimateCancel({ taskId: task.task_id, identity });
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
              if (cancelRecord.txId) await trackWriteTx(cancelRecord, cancelRecord.txId, persistCancel);
              return;
            }
            try {
              const identity = await wallet.verifyBeforeWrite();
              const blocker = await signCancelBlocker({ taskId: task.task_id, identity });
              if (!blocker.ok) {
                persistCancel(blocker.record, blocker.task);
                return;
              }
              if (!wallet.provider) throw new Error("Connect a wallet before signing.");
              persistCancel({ ...blocker.record, phase: "signing", error: undefined });
              const submitted = await submitSettlementTx({
                action: "cancel",
                record: blocker.record,
                task: blocker.task,
                identity,
                provider: wallet.provider,
                estimate: blocker.estimate,
              });
              persistCancel(submitted.record, blocker.task);
              await trackWriteTx(submitted.record, submitted.txId, persistCancel);
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
            persistCancel(retryFailedWrite(cancelRecord), task);
          }}
        />
      ) : null}

      {showRecover || recoverRecord.txId ? (
        <section className="bg-surface-container-lowest p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-sm">
          <h2 className="font-headline-sm text-headline-sm uppercase text-primary">Timeout recovery</h2>
          <p className="font-body-sm text-body-sm text-on-surface-variant">{clock.countdownLabel}</p>
          <p className="font-body-sm text-body-sm text-on-surface-variant">{clock.gateLabel}</p>
          <p className="font-body-sm text-body-sm">
            Refund recipient: funder {shortenAddress(task.funder)}. Fee payer: connected caller{" "}
            {wallet.address ? shortenAddress(wallet.address) : "(connect a wallet)"}.
          </p>
          <WritePanel
            title="recover_undecided_task"
            blurb="Any connected Studio-dev wallet may call recover_undecided_task after recovery_opens_at_unix. The refund goes to the funder. The connected caller pays the write fee. The countdown never signs."
            record={recoverRecord}
            estimateOk={recoverGuard.ok}
            estimateReason={recoverGuard.ok ? undefined : recoverGuard.reason}
            retryable={failedRecoverStillSubmitted(task, recoverRecord)}
            evidence={recoverRecord.txId ? liveRefundEvidence({ task, record: recoverRecord, expected: "recover" }) : undefined}
            onEstimate={async () => {
              try {
                const identity = await wallet.verifyBeforeWrite();
                const next = await estimateRecover({ taskId: task.task_id, identity });
                persistRecover(next.record, next.task);
              } catch (err) {
                persistRecover({
                  ...recoverRecord,
                  phase: "idle",
                  error: isUserRejection(err) ? "Wallet rejected the fee estimate." : formatError(err),
                });
              }
            }}
            onSign={async () => {
              if (neverResubmit(recoverRecord) === "resume" && !isTerminalFailure(recoverRecord)) {
                if (recoverRecord.txId) await trackWriteTx(recoverRecord, recoverRecord.txId, persistRecover);
                return;
              }
              try {
                const identity = await wallet.verifyBeforeWrite();
                const blocker = await signRecoverBlocker({ taskId: task.task_id, identity });
                if (!blocker.ok) {
                  persistRecover(blocker.record, blocker.task);
                  return;
                }
                if (!wallet.provider) throw new Error("Connect a wallet before signing.");
                persistRecover({ ...blocker.record, phase: "signing", error: undefined });
                const submitted = await submitSettlementTx({
                  action: "recover",
                  record: blocker.record,
                  task: blocker.task,
                  identity,
                  provider: wallet.provider,
                  estimate: blocker.estimate,
                });
                persistRecover(submitted.record, blocker.task);
                await trackWriteTx(submitted.record, submitted.txId, persistRecover);
              } catch (err) {
                persistRecover(
                  applyTxSignCatch(
                    writeIdentityOrEmpty({
                      wallet: wallet.address,
                      chainId: wallet.chainId,
                      taskId: task.task_id,
                      action: "recover",
                    }),
                    err,
                  ),
                );
              }
            }}
            onRetry={() => {
              resumed.current = "";
              persistRecover(retryFailedWrite(recoverRecord), task);
            }}
          />
        </section>
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
  evidence,
  onEstimate,
  onSign,
  onRetry,
}: {
  title: string;
  blurb: string;
  record: ProductUiWriteRecord;
  estimateOk: boolean;
  estimateReason?: string;
  retryable: boolean;
  evidence?: RefundEvidenceView;
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
      {evidence ? <EvidenceGrid evidence={evidence} /> : null}
    </section>
  );
}

function EvidenceGrid({ evidence }: { evidence: RefundEvidenceView }) {
  return (
    <div className="flex flex-col gap-space-sm pt-space-sm">
      <p className="font-label-sm text-label-sm uppercase tracking-widest text-tertiary-fixed">Separate evidence fields</p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-space-sm">
        <Mini kicker="01" title="Parent status" value={evidence.transactionStatus} />
        <Mini kicker="02" title="Execution" value={evidence.execution} />
        <Mini kicker="03" title="Contract state" value={evidence.contractDecision} />
        <Mini kicker="04" title="Outgoing EthSend" value={evidence.outgoingEthSend} />
        <Mini kicker="05" title="Child value_credited" value={evidence.childCredit} />
        <Mini kicker="06" title="Receipt fee" value={evidence.receiptFee} />
        <Mini kicker="07" title="EOA balance evidence" value={evidence.balanceEvidence} />
      </div>
      <p className="font-body-sm text-body-sm text-primary-fixed-dim">{evidence.paymentReason}</p>
      <p className="font-body-sm text-body-sm text-primary-fixed-dim">{PAYOUT_SUBMITTED_IS_NOT_PAYMENT}</p>
    </div>
  );
}

function Mini({ kicker, title, value }: { kicker: string; title: string; value: string }) {
  return (
    <div className="bg-surface-container/10 p-space-sm rounded flex flex-col gap-1">
      <span className="font-label-sm text-label-sm uppercase text-tertiary-fixed">
        {kicker} {title}
      </span>
      <p className="font-body-sm text-body-sm break-words">{value}</p>
    </div>
  );
}
