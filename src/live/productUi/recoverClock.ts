import { formatDuration, formatUnixLocal, type RecoveryClockView } from "../productTimeout/recoverClock";

export type { RecoveryClockView };

/** Product UI copy: any caller may recover; the countdown never signs. */
export function productRecoveryClock(opensAtUnix: number | undefined, nowUnix: number): RecoveryClockView {
  const opens = opensAtUnix != null && Number.isFinite(opensAtUnix) ? Math.trunc(opensAtUnix) : 0;
  const now = Number.isFinite(nowUnix) ? Math.trunc(nowUnix) : 0;
  if (!opens) {
    return {
      open: false,
      remainingSeconds: 0,
      opensAtUnix: 0,
      nowUnix: now,
      localDate: "(none)",
      countdownLabel: "get_task has not returned recovery_opens_at_unix yet.",
      gateLabel: "Recover Sign stays disabled until get_task reports recovery_opens_at_unix. The countdown never sends a transaction.",
    };
  }
  const remaining = Math.max(0, opens - now);
  const open = now >= opens;
  return {
    open,
    remainingSeconds: remaining,
    opensAtUnix: opens,
    nowUnix: now,
    localDate: formatUnixLocal(opens),
    countdownLabel: open
      ? "Recovery is open. Any connected Studio-dev wallet may estimate and sign recover_undecided_task. The refund goes to the funder. The connected caller pays the write fee. Signing is not automatic."
      : `Recovery opens ${formatUnixLocal(opens)} (${opens}). Opens in ${formatDuration(remaining)}. Too early to sign. This countdown does not send a transaction.`,
    gateLabel: open
      ? `Contract recovery opening time ${opens} has been reached (clock ${now}).`
      : `Recover is disabled until the contract recovery opening time ${opens}. Current clock ${now}. The task stays submitted.`,
  };
}
