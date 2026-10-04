import { beforeEach, describe, expect, it } from "vitest";
import {
  classifyDeadlineUserError,
  clearRememberedGenvmLag,
  clocksTooFarForSharedWindow,
  createDeadlinesFromGenvm,
  createSignNowUnix,
  discoverGenvmUnix,
  GENVM_CLOCK_SEARCH_SEED_UNIX,
  genvmNowForSession,
  rememberedGenvmUnix,
} from "../../src/live/product/clock";
import { CREATE_SUBMIT_LEAD_SECONDS, MAX_RECOVERY_SECONDS, MIN_REVIEW_SECONDS } from "../../src/live/product/constants";

const GENVM_NOW = GENVM_CLOCK_SEARCH_SEED_UNIX;

function probeAt(now: number) {
  return async (submitBy: number, recoverAfter: number) => {
    if (submitBy <= now) return "past" as const;
    if (recoverAfter < submitBy + MIN_REVIEW_SECONDS) return "early" as const;
    if (recoverAfter - now > MAX_RECOVERY_SECONDS) return "far" as const;
    return "ok" as const;
  };
}

beforeEach(() => {
  clearRememberedGenvmLag();
});

describe("classifyDeadlineUserError", () => {
  it("maps create_task UserError strings", () => {
    expect(classifyDeadlineUserError("submission deadline in the past")).toBe("past");
    expect(classifyDeadlineUserError("Studio-dev contract rejected the call: recovery deadline too far")).toBe("far");
    expect(classifyDeadlineUserError("recovery deadline too early")).toBe("early");
    expect(classifyDeadlineUserError("zero value rejected")).toBe("other");
  });
});

describe("createDeadlinesFromGenvm", () => {
  it("keeps recover_after inside MAX_RECOVERY_SECONDS of GenVM now", () => {
    const deadlines = createDeadlinesFromGenvm(GENVM_NOW);
    expect(deadlines.submitByUnix).toBe(GENVM_NOW + CREATE_SUBMIT_LEAD_SECONDS);
    expect(deadlines.recoverAfterUnix).toBe(deadlines.submitByUnix + MIN_REVIEW_SECONDS);
    expect(deadlines.recoverAfterUnix - GENVM_NOW).toBeLessThanOrEqual(MAX_RECOVERY_SECONDS);
  });
});

describe("discoverGenvmUnix", () => {
  it("returns wall time when create_task accepts wall-clock deadlines", async () => {
    const wall = GENVM_NOW;
    const now = await discoverGenvmUnix(probeAt(wall), wall);
    expect(now).toBe(wall);
    expect(rememberedGenvmUnix(wall + 10)).toBe(wall + 10);
  });

  it("finds a lagged GetTimestamp near the search seed without using the browser clock", async () => {
    const wall = GENVM_NOW + 58_232_328;
    let probes = 0;
    const probe = async (submitBy: number, recoverAfter: number) => {
      probes += 1;
      return probeAt(GENVM_NOW)(submitBy, recoverAfter);
    };
    const now = await discoverGenvmUnix(probe, wall);
    expect(now).toBeGreaterThanOrEqual(GENVM_NOW - 600);
    expect(now).toBeLessThan(GENVM_NOW + CREATE_SUBMIT_LEAD_SECONDS);
    const deadlines = createDeadlinesFromGenvm(now);
    expect(deadlines.submitByUnix).toBeGreaterThan(GENVM_NOW);
    expect(deadlines.recoverAfterUnix - GENVM_NOW).toBeLessThanOrEqual(MAX_RECOVERY_SECONDS);
    expect(probes).toBeLessThanOrEqual(12);
  });

  it("reuses the in-memory lag so a second discover does not probe", async () => {
    const wall = GENVM_NOW + 58_232_328;
    await discoverGenvmUnix(probeAt(GENVM_NOW), wall);
    let probes = 0;
    const now = await discoverGenvmUnix(async (submitBy, recoverAfter) => {
      probes += 1;
      return probeAt(GENVM_NOW)(submitBy, recoverAfter);
    }, wall + 5);
    expect(probes).toBe(0);
    expect(now).toBeGreaterThan(GENVM_NOW - 700);
  });
});

describe("sim vs execution clock split", () => {
  it("detects a GetTimestamp lag larger than the 30-day create window", () => {
    const genvmNow = GENVM_CLOCK_SEARCH_SEED_UNIX;
    const wall = genvmNow + 58_232_328;
    expect(clocksTooFarForSharedWindow(genvmNow, wall)).toBe(true);
    expect(createSignNowUnix(genvmNow, wall)).toEqual({ nowUnix: wall, clock: "utc" });
  });

  it("signs on GetTimestamp when the clocks share a 30-day window", () => {
    const genvmNow = GENVM_CLOCK_SEARCH_SEED_UNIX;
    const wall = genvmNow + 3600;
    expect(clocksTooFarForSharedWindow(genvmNow, wall)).toBe(false);
    expect(createSignNowUnix(genvmNow, wall)).toEqual({ nowUnix: genvmNow, clock: "genvm" });
  });
});

describe("genvmNowForSession", () => {
  it("uses persisted lag instead of wall time", () => {
    const wall = GENVM_NOW + 58_232_328;
    const now = genvmNowForSession({ genvmLagSeconds: wall - GENVM_NOW }, wall);
    expect(now).toBe(GENVM_NOW);
  });

  it("derives GetTimestamp from already-bound 2024 deadlines when lag is missing", () => {
    const wall = GENVM_NOW + 58_232_328;
    const submitByUnix = GENVM_NOW + CREATE_SUBMIT_LEAD_SECONDS;
    const now = genvmNowForSession({ submitByUnix }, wall);
    expect(now).toBe(GENVM_NOW);
  });
});
