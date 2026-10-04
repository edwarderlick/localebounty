import { formatDuration, formatUnixLocal } from "../productTimeout/recoverClock";

export type ExpireClockView = {
  open: boolean;
  remainingSeconds: number;
  submitByUnix: number;
  nowUnix: number;
  localDate: string;
  countdownLabel: string;
  gateLabel: string;
};

/** Exclusive of the inclusive submit deadline: expire only when now > submit_by_unix. */
export function expireWindowOpen(submitByUnix: number | undefined, nowUnix: number): boolean {
  if (submitByUnix == null || !Number.isFinite(submitByUnix)) return false;
  return nowUnix > submitByUnix;
}

export function acceptWindowOpen(submitByUnix: number | undefined, nowUnix: number): boolean {
  if (submitByUnix == null || !Number.isFinite(submitByUnix)) return false;
  return nowUnix < submitByUnix;
}

/** Inclusive submit deadline: submit_translation is allowed while now <= submit_by_unix. */
export function submitTranslationWindowOpen(submitByUnix: number | undefined, nowUnix: number): boolean {
  if (submitByUnix == null || !Number.isFinite(submitByUnix)) return false;
  return nowUnix <= submitByUnix;
}

export function expireClockView(submitByUnix: number | undefined, nowUnix: number): ExpireClockView {
  const deadline = submitByUnix != null && Number.isFinite(submitByUnix) ? Math.trunc(submitByUnix) : 0;
  const now = Number.isFinite(nowUnix) ? Math.trunc(nowUnix) : 0;
  if (!deadline) {
    return {
      open: false,
      remainingSeconds: 0,
      submitByUnix: 0,
      nowUnix: now,
      localDate: "(none)",
      countdownLabel: "Lane B has no bound submit_by_unix yet.",
      gateLabel: "expire_unsubmitted_task stays disabled until create binds a submission window.",
    };
  }
  const remaining = Math.max(0, deadline + 1 - now);
  const open = now > deadline;
  return {
    open,
    remainingSeconds: remaining,
    submitByUnix: deadline,
    nowUnix: now,
    localDate: formatUnixLocal(deadline),
    countdownLabel: open
      ? "Submission deadline has passed (exclusive). Any connected Studio-dev wallet may Estimate and Sign expire_unsubmitted_task for an OPEN or ACCEPTED unsubmitted task."
      : `Expire opens after ${formatUnixLocal(deadline)} (now must be > submit_by). ${formatDuration(remaining)} remaining including the inclusive submit instant.`,
    gateLabel: open
      ? `Execution clock ${now} is after submit_by_unix ${deadline}. Expire does not require a successful accept when the task is still OPEN and unsubmitted.`
      : `expire_unsubmitted_task is disabled until now > ${deadline}. Current clock ${now}. At the exact deadline, accept_task is closed (needs now < submit_by). submit_translation for an accepted task is still allowed (now <= submit_by). Expire waits until now > submit_by.`,
  };
}

export function acceptClockView(submitByUnix: number | undefined, nowUnix: number): ExpireClockView {
  const deadline = submitByUnix != null && Number.isFinite(submitByUnix) ? Math.trunc(submitByUnix) : 0;
  const now = Number.isFinite(nowUnix) ? Math.trunc(nowUnix) : 0;
  if (!deadline) {
    return {
      open: false,
      remainingSeconds: 0,
      submitByUnix: 0,
      nowUnix: now,
      localDate: "(none)",
      countdownLabel: "Estimate lane B first to bind submit_by_unix. Exact remaining accept time appears before you Sign create.",
      gateLabel: "accept_task stays disabled until create binds a submission window and the named translator connects.",
    };
  }
  const remaining = Math.max(0, deadline - now);
  const open = now < deadline;
  return {
    open,
    remainingSeconds: remaining,
    submitByUnix: deadline,
    nowUnix: now,
    localDate: formatUnixLocal(deadline),
    countdownLabel: open
      ? `Accept window is open until ${formatUnixLocal(deadline)}. ${formatDuration(remaining)} remaining for wallet switch, Studio-dev finalization, and accept_task (now < submit_by).`
      : `Accept window closed (now >= submit_by ${deadline}). Recover with funder cancel while OPEN unaccepted, or expire_unsubmitted_task after the exclusive deadline.`,
    gateLabel: open
      ? `Execution clock ${now} is before submit_by_unix ${deadline}.`
      : `accept_task is disabled at clock ${now}; submit_by_unix is ${deadline}.`,
  };
}

export function selectedLeadPreview(leadSeconds: number): string {
  return `Selected Lane B accept window: ${formatDuration(leadSeconds)} from the clock used when you Sign create. Wallet switching and Studio-dev finalization consume part of that window.`;
}
