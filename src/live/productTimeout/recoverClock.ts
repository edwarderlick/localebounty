/** Display helpers for recovery_opens_at_unix. Gate writes on the contract unix, not wall clock. */

export function formatUnixLocal(unix: number): string {
  if (!Number.isFinite(unix) || unix <= 0) return "(none)";
  return new Date(unix * 1000).toLocaleString();
}

export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.trunc(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (hours > 0) return `${hours}h ${pad(minutes)}m ${pad(seconds)}s`;
  return `${minutes}m ${pad(seconds)}s`;
}

export type RecoveryClockView = {
  open: boolean;
  remainingSeconds: number;
  opensAtUnix: number;
  nowUnix: number;
  localDate: string;
  countdownLabel: string;
  gateLabel: string;
};

export function recoveryClockView(opensAtUnix: number | undefined, nowUnix: number): RecoveryClockView {
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
      gateLabel: "Recover Sign stays disabled until get_task reports recovery_opens_at_unix.",
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
      ? "Recovery is open. The funder may Estimate fee and explicitly Sign recover_undecided_task."
      : `Recovery opens in ${formatDuration(remaining)}. Too early to sign.`,
    gateLabel: open
      ? `Contract recovery opening time ${opens} has been reached (clock ${now}).`
      : `Recover is disabled until the contract recovery opening time ${opens}. Current clock ${now}. The task stays submitted.`,
  };
}
