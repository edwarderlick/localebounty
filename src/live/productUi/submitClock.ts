import { formatDuration, formatUnixLocal } from "../productTimeout/recoverClock";
import type { ProductTask } from "../product/task";
import { formatUnix } from "./status";

export type SubmitDeadlineView = {
  open: boolean;
  remainingSeconds: number;
  deadlineUnix: number;
  executionUnix: number;
  genvmUnix?: number;
  localDate: string;
  isoLabel: string;
  countdownLabel: string;
  gateLabel: string;
};

/** Execution/envelope clock is authoritative. A lagging GenVM quote clock cannot reopen signing. */
export function executionSubmitDeadlineView(
  task: Pick<ProductTask, "submit_by_unix">,
  executionUnix: number,
  genvmUnix?: number,
): SubmitDeadlineView {
  const deadline = Number.isFinite(task.submit_by_unix) ? Math.trunc(task.submit_by_unix) : 0;
  const now = Number.isFinite(executionUnix) ? Math.trunc(executionUnix) : 0;
  const remaining = Math.max(0, deadline - now);
  const open = Boolean(deadline) && now <= deadline;
  const genvmNote =
    genvmUnix != null
      ? ` Remembered GenVM ${genvmUnix} is the fee-simulation clock only and does not reopen signing.`
      : "";
  return {
    open,
    remainingSeconds: remaining,
    deadlineUnix: deadline,
    executionUnix: now,
    genvmUnix,
    localDate: deadline ? formatUnixLocal(deadline) : "(none)",
    isoLabel: formatUnix(deadline),
    countdownLabel: !deadline
      ? "get_task has not returned submit_by_unix yet."
      : open
        ? `Execution-clock submit deadline ${formatUnix(deadline)}. Remaining ${formatDuration(remaining)}. Signing is allowed until this instant.`
        : `Execution-clock submit deadline ${formatUnix(deadline)} has passed (now ${now}). A new signature is blocked.${genvmNote}`,
    gateLabel: !deadline
      ? "Submit Sign stays disabled until get_task reports submit_by_unix."
      : open
        ? `submit_by_unix ${deadline} is still open on the execution clock ${now}.`
        : `submit_by_unix ${deadline} is closed on the execution clock ${now}. Fee quotes may still mention a lagging GenVM clock; that clock cannot make this window appear open.`,
  };
}
