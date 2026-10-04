import {
  CREATE_SUBMIT_LEAD_SECONDS,
  MAX_RECOVERY_SECONDS,
  MIN_REVIEW_SECONDS,
} from "./constants";

export type DeadlineProbeStatus = "ok" | "past" | "far" | "early" | "other";

export type DeadlineProbe = (submitByUnix: number, recoverAfterUnix: number) => Promise<DeadlineProbeStatus>;

/**
 * Search seed only. Studio-dev GetTimestamp lagged wall clock by ~674 days in
 * 2026 measurements. Never used as the signed create deadline.
 */
export const GENVM_CLOCK_SEARCH_SEED_UNIX = 1_732_604_000;

const LAG_MEMORY_MS = 30 * 60 * 1000;
const BINARY_PRECISION_SECONDS = 600;
const MAX_DISCOVERY_PROBES = 22;

let cachedLagSeconds: number | undefined;
let cachedAtMs = 0;

export function classifyDeadlineUserError(message: string | undefined): DeadlineProbeStatus {
  if (!message) return "other";
  if (/submission deadline in the past/i.test(message)) return "past";
  if (/recovery deadline too far/i.test(message)) return "far";
  if (/recovery deadline too early/i.test(message)) return "early";
  return "other";
}

export function genvmUnixFromLag(lagSeconds: number, wallUnix = Math.floor(Date.now() / 1000)): number {
  return wallUnix - lagSeconds;
}

export function rememberGenvmLag(lagSeconds: number, nowMs = Date.now()): void {
  cachedLagSeconds = lagSeconds;
  cachedAtMs = nowMs;
}

export function rememberedLagSeconds(nowMs = Date.now()): number | undefined {
  if (cachedLagSeconds == null) return undefined;
  if (nowMs - cachedAtMs > LAG_MEMORY_MS) return undefined;
  return cachedLagSeconds;
}

export function rememberedGenvmUnix(wallUnix = Math.floor(Date.now() / 1000)): number | undefined {
  const lag = rememberedLagSeconds();
  if (lag == null) return undefined;
  return genvmUnixFromLag(lag, wallUnix);
}

export function clearRememberedGenvmLag(): void {
  cachedLagSeconds = undefined;
  cachedAtMs = 0;
}

export function cachedGenvmUnix(
  session: { genvmLagSeconds?: number },
  wallUnix = Math.floor(Date.now() / 1000),
): number | undefined {
  const mem = rememberedGenvmUnix(wallUnix);
  if (mem != null) return mem;
  if (session.genvmLagSeconds != null && Number.isFinite(session.genvmLagSeconds)) {
    rememberGenvmLag(session.genvmLagSeconds);
    return genvmUnixFromLag(session.genvmLagSeconds, wallUnix);
  }
  return undefined;
}

/** Clock used for create deadlines and stale checks. Never use eth_getBlockByNumber. */
export function genvmNowForSession(
  session: { genvmLagSeconds?: number; submitByUnix?: number },
  wallUnix = Math.floor(Date.now() / 1000),
): number {
  const cached = cachedGenvmUnix(session, wallUnix);
  if (cached != null) return cached;
  if (session.submitByUnix != null && session.submitByUnix < wallUnix - 24 * 60 * 60) {
    return session.submitByUnix - CREATE_SUBMIT_LEAD_SECONDS;
  }
  return wallUnix;
}

/**
 * Studio-dev GetTimestamp is not the browser clock and is not eth_getBlockByNumber.
 * create_task requires now < submit_by and recover_after - now <= 30 days.
 */
export async function discoverGenvmUnix(
  probe: DeadlineProbe,
  wallUnix = Math.floor(Date.now() / 1000),
): Promise<number> {
  const remembered = rememberedGenvmUnix(wallUnix);
  if (remembered != null) return remembered;

  let probes = 0;
  const classifyAt = async (submitBy: number): Promise<DeadlineProbeStatus> => {
    probes += 1;
    if (probes > MAX_DISCOVERY_PROBES) {
      throw new Error(
        "Studio-dev GetTimestamp discovery used too many fee-estimate probes. Wait a minute for the 30 sim_estimate/min limit, then Estimate again.",
      );
    }
    return probe(submitBy, submitBy + MIN_REVIEW_SECONDS);
  };

  const finish = (now: number): number => {
    rememberGenvmLag(wallUnix - now);
    return now;
  };

  const findNowInRange = async (pastBound: number, futureBound: number): Promise<number> => {
    let low = pastBound;
    let high = futureBound;
    for (let i = 0; i < 18 && high - low > BINARY_PRECISION_SECONDS; i++) {
      const mid = Math.floor((low + high) / 2);
      const midStatus = await classifyAt(mid);
      if (midStatus === "past") low = mid;
      else high = mid;
    }
    if (high - low >= CREATE_SUBMIT_LEAD_SECONDS) {
      throw new Error(
        "Could not pin Studio-dev GetTimestamp inside the create_task lead window. Estimate again; do not use the browser clock.",
      );
    }
    return finish(low);
  };

  const findPastBound = async (okSubmit: number): Promise<number> => {
    let cursor = Math.max(0, okSubmit - CREATE_SUBMIT_LEAD_SECONDS);
    let step = 3600;
    let status = await classifyAt(cursor);
    while (status !== "past" && cursor > 0) {
      cursor = Math.max(0, cursor - step);
      step = Math.min(step * 2, Math.max(cursor, 1));
      status = await classifyAt(cursor);
    }
    if (status !== "past") {
      throw new Error("Could not find a past bound for Studio-dev GetTimestamp. Estimate again.");
    }
    return cursor;
  };

  const high = wallUnix + CREATE_SUBMIT_LEAD_SECONDS;
  const wallStatus = await classifyAt(high);
  if (wallStatus === "ok") return finish(wallUnix);
  if (wallStatus === "past") {
    throw new Error("Studio-dev GetTimestamp is ahead of the browser clock. Estimate again.");
  }
  if (wallStatus !== "far") {
    throw new Error(
      "Could not find a create_task deadline window on Studio-dev GetTimestamp. Estimate again; do not use the browser clock.",
    );
  }

  const seedSubmit = GENVM_CLOCK_SEARCH_SEED_UNIX + CREATE_SUBMIT_LEAD_SECONDS;
  if (seedSubmit > 0 && seedSubmit < high) {
    const seedStatus = await classifyAt(seedSubmit);
    if (seedStatus === "past") {
      return findNowInRange(seedSubmit, high);
    }
    if (seedStatus === "ok") {
      const pastBound = await findPastBound(seedSubmit);
      return findNowInRange(pastBound, seedSubmit);
    }
  }

  let cursor = seedSubmit > 0 && seedSubmit < high ? seedSubmit : high;
  let status: DeadlineProbeStatus = "far";
  let step = MAX_RECOVERY_SECONDS;
  let pastBound = 0;
  while (status === "far" && cursor - step > 0) {
    cursor -= step;
    step = Math.min(step * 2, cursor);
    status = await classifyAt(cursor);
    if (status === "past") {
      pastBound = cursor;
      break;
    }
    if (status === "ok") {
      pastBound = await findPastBound(cursor);
      return findNowInRange(pastBound, cursor);
    }
  }
  if (status !== "past") {
    throw new Error(
      "Could not find a create_task deadline window on Studio-dev GetTimestamp. Estimate again; do not use the browser clock.",
    );
  }
  return findNowInRange(pastBound, high);
}

/**
 * Fee simulation uses Studio-dev GetTimestamp (~2024 on this runner).
 * Consensus execution `_tx_unix()` can follow the UTC envelope clock (~2026).
 * MAX_RECOVERY_SECONDS is 30 days, so one deadline window cannot satisfy both.
 */
export function clocksTooFarForSharedWindow(
  genvmNow: number,
  wallUnix = Math.floor(Date.now() / 1000),
): boolean {
  const slack = MAX_RECOVERY_SECONDS - MIN_REVIEW_SECONDS - CREATE_SUBMIT_LEAD_SECONDS;
  return Math.abs(wallUnix - genvmNow) > slack;
}

export type CreateDeadlineClock = "genvm" | "utc";

export function createSignNowUnix(
  genvmNow: number,
  wallUnix = Math.floor(Date.now() / 1000),
): { nowUnix: number; clock: CreateDeadlineClock } {
  if (clocksTooFarForSharedWindow(genvmNow, wallUnix)) {
    return { nowUnix: wallUnix, clock: "utc" };
  }
  return { nowUnix: genvmNow, clock: "genvm" };
}

export function createDeadlinesFromGenvm(nowUnix: number): { submitByUnix: number; recoverAfterUnix: number } {
  const submitByUnix = nowUnix + CREATE_SUBMIT_LEAD_SECONDS;
  const recoverAfterUnix = submitByUnix + MIN_REVIEW_SECONDS;
  if (recoverAfterUnix - nowUnix > MAX_RECOVERY_SECONDS) {
    throw new Error("Internal deadline window exceeds MAX_RECOVERY_SECONDS.");
  }
  return { submitByUnix, recoverAfterUnix };
}
