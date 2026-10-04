import { beforeEach, describe, expect, it } from "vitest";
import type { TransactionFeeEstimate } from "genlayer-js/types";
import { buildEvidencePayload } from "../../src/live/evidence";
import { jsonSafe, jsonStringifySafe } from "../../src/live/format";
import {
  emptySession,
  LIVE_STORAGE_KEY,
  loadSession,
  saveSession,
  type LiveSession,
} from "../../src/live/persist";

const FUNDER = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x2222222222222222222222222222222222222222";
const LOCK_TX = `0x${"22".repeat(32)}`;

/** Mirrors genlayer-js 2.0.0-rc.1 TransactionFeeEstimate / FeesDistribution (bigint fields). */
function realisticEstimate(): TransactionFeeEstimate {
  return {
    distribution: {
      leaderTimeunitsAllocation: 125n,
      validatorTimeunitsAllocation: 250n,
      appealRounds: 1n,
      executionBudgetPerRound: 786_500n,
      executionConsumed: 0n,
      totalMessageFees: 0n,
      rotations: [1n, 1n],
      maxPriceGenPerTimeUnit: 1n,
      storageFeeMaxGasPrice: 1n,
      receiptFeeMaxGasPrice: 1n,
    },
    feeValue: 123_456_789n,
    policy: {
      enabled: true,
      genPerTimeUnit: 1n,
      storageUnitPrice: 1n,
      receiptGasPrice: 1n,
      executionBudgetFloor: 1n,
    },
  };
}

function sessionWithLockTx(): LiveSession {
  const session = emptySession();
  session.recipient = RECIPIENT;
  session.boundFunder = FUNDER;
  session.boundRecipient = RECIPIENT;
  session.release.lock = {
    phase: "success",
    txId: LOCK_TX,
    statusName: "FINALIZED",
    parentSuccessful: true,
  };
  return session;
}

beforeEach(() => {
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    length: 0,
    key: () => null,
  };
});

describe("bigint fee estimate serialization", () => {
  it("reproduces: JSON.stringify of a realistic TransactionFeeEstimate throws on bigint distribution", () => {
    const estimate = realisticEstimate();
    expect(typeof estimate.distribution.leaderTimeunitsAllocation).toBe("bigint");
    expect(() => JSON.stringify(estimate)).toThrow(/Do not know how to serialize a BigInt/);
    expect(() => JSON.stringify({ quotedDistribution: estimate.distribution })).toThrow(
      /Do not know how to serialize a BigInt/,
    );
  });

  it("plain JSON.stringify of a session that stored estimate.distribution throws (the blank-page path)", () => {
    const session = sessionWithLockTx();
    session.release.deploy = {
      phase: "quoted",
      quotedFeeWei: realisticEstimate().feeValue.toString(),
      quotedValueWei: "0",
      quotedDistribution: realisticEstimate().distribution,
    };
    expect(() => JSON.stringify(session)).toThrow(/Do not know how to serialize a BigInt/);
  });

  it("saveSession does not throw; typed estimate stays out of storage; lock tx ID is kept", () => {
    const estimate = realisticEstimate();
    const inMemoryQuotes: Record<string, TransactionFeeEstimate> = {
      "release:deploy": estimate,
    };
    const session = sessionWithLockTx();
    session.release.deploy = {
      phase: "quoted",
      quotedFeeWei: estimate.feeValue.toString(),
      quotedValueWei: "0",
      quotedDistribution: estimate.distribution,
      quotedMessageAllocations: estimate.messageAllocations,
    };
    expect(() => saveSession(session)).not.toThrow();
    expect(inMemoryQuotes["release:deploy"]).toBe(estimate);
    expect(inMemoryQuotes["release:deploy"].distribution.leaderTimeunitsAllocation).toBe(125n);

    const raw = localStorage.getItem(LIVE_STORAGE_KEY);
    expect(raw).toBeTruthy();
    expect(() => JSON.parse(raw as string)).not.toThrow();
    const parsed = JSON.parse(raw as string) as LiveSession;
    expect(parsed.release.lock.txId).toBe(LOCK_TX);
    expect(parsed.release.deploy.quotedDistribution).toBeUndefined();
    expect(parsed.release.deploy.quotedFeeWei).toBe("123456789");

    const loaded = loadSession();
    expect(loaded.release.lock.txId).toBe(LOCK_TX);
    expect(loaded.boundFunder).toBe(FUNDER);
    expect(loaded.release.deploy.phase).toBe("quoted");
  });

  it("receipt, lifecycle, snapshot, and Copy evidence survive nested bigint", () => {
    const session = sessionWithLockTx();
    session.release.lock.receipt = { primary_fee_spent: 99n, nested: { value: 1n } };
    session.release.lock.lifecycle = { round: 3n };
    session.release.lock.snapshot = {
      funder: FUNDER,
      named_wallet: RECIPIENT,
      locked_amount: 1_000_000_000_000_000n,
      locked: true,
      payout_submitted: false,
    };
    expect(() => JSON.stringify(session)).toThrow(/BigInt/);
    expect(() => saveSession(session)).not.toThrow();
    const evidence = buildEvidencePayload({ funder: FUNDER, chainId: 61997, session });
    expect(() => JSON.parse(evidence)).not.toThrow();
    expect(evidence).toContain(LOCK_TX);
    expect(evidence).toContain("1000000000000000");
    expect(jsonSafe(session.release.lock.receipt)).toEqual({ primary_fee_spent: "99", nested: { value: "1" } });
    expect(jsonStringifySafe(realisticEstimate())).toContain("123456789");
  });

  it("does not persist a hung quoting phase, and reload idles it without dropping tx IDs", () => {
    const session = sessionWithLockTx();
    session.release.deploy = { phase: "quoting" };
    session.refund.deploy = { phase: "quoting" };
    saveSession(session);
    const stored = JSON.parse(localStorage.getItem(LIVE_STORAGE_KEY) as string) as LiveSession;
    expect(stored.release.deploy.phase).toBe("idle");
    expect(stored.refund.deploy.phase).toBe("idle");
    expect(stored.release.lock.txId).toBe(LOCK_TX);

    localStorage.setItem(
      LIVE_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        recipient: RECIPIENT,
        boundFunder: FUNDER,
        release: { deploy: { phase: "quoting" }, lock: { phase: "success", txId: LOCK_TX }, payout: { phase: "idle" }, paymentEvidence: "UNPROVEN", paymentReason: "" },
        refund: { deploy: { phase: "quoting" }, lock: { phase: "idle" }, payout: { phase: "idle" }, paymentEvidence: "UNPROVEN", paymentReason: "" },
      }),
    );
    const loaded = loadSession();
    expect(loaded.release.deploy.phase).toBe("idle");
    expect(loaded.refund.deploy.phase).toBe("idle");
    expect(loaded.release.lock.txId).toBe(LOCK_TX);
  });
});
