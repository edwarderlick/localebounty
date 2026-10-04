import { beforeEach, describe, expect, it } from "vitest";
import { evaluateRefundPayment, evaluateReleasePayment, overallVerdict } from "../../src/live/evidence";
import { extractFinalizedFee } from "../../src/live/fees";
import {
  actionWriteAllowed,
  importSnapshotAllowsBind,
  isFinalizedSuccessful,
  isTerminalFailure,
  needsPaymentResume,
  needsTxResume,
  neverResubmit,
  overallVerdict as guardOverall,
  payoutWriteAllowed,
  retryFailedLaneAction,
  sessionCompatible,
  type WriteContext,
} from "../../src/live/guards";
import { LOCK_WEI } from "../../src/live/network";
import type { EoaBalances } from "../../src/live/rpc";
import {
  emptyLane,
  emptySession,
  invalidateUnsignedQuotes,
  LIVE_STORAGE_KEY,
  loadSession,
  saveSession,
  type ActionRecord,
  type LaneRecord,
  type LiveSession,
} from "../../src/live/persist";
import { currentQuoteBinding, quoteInvalidReason, quoteStillValid } from "../../src/live/quotes";
import { snapshotIsUnusedProbe, parseProbeSnapshot, snapshotMatchesOpenLock } from "../../src/live/snapshot";

const FUNDER = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x2222222222222222222222222222222222222222";
const OTHER = "0x5555555555555555555555555555555555555555";
const RELEASE_ADDR = "0x3333333333333333333333333333333333333333";
const REFUND_ADDR = "0x4444444444444444444444444444444444444444";
const ZERO = "0x0000000000000000000000000000000000000000";
const LOCK = LOCK_WEI.toString();

function ctx(overrides: Partial<WriteContext> = {}): WriteContext {
  return {
    funder: FUNDER,
    chainId: 61997,
    recipient: RECIPIENT,
    connected: true,
    ...overrides,
  };
}

function unusedSnap() {
  return {
    funder: ZERO,
    named_wallet: ZERO,
    locked_amount: 0,
    locked: false,
    payout_submitted: false,
    payout_kind: "",
  };
}

function openLockSnap(overrides: Record<string, unknown> = {}) {
  return {
    funder: FUNDER,
    named_wallet: RECIPIENT,
    locked_amount: LOCK,
    locked: true,
    payout_submitted: false,
    payout_kind: "",
    ...overrides,
  };
}

function payoutSnap(kind: "release" | "refund") {
  return { ...openLockSnap(), payout_submitted: true, payout_kind: kind };
}

function successAction(snapshot: unknown, contract?: string, txId = `0x${"ab".repeat(32)}`): ActionRecord {
  return {
    phase: "success",
    txId,
    statusName: "FINALIZED",
    executionName: "FINISHED_WITH_RETURN",
    parentSuccessful: true,
    snapshot,
    contractAddress: contract,
  };
}

function readyLane(kind: "release" | "refund"): LaneRecord {
  const address = kind === "release" ? RELEASE_ADDR : REFUND_ADDR;
  return {
    ...emptyLane(),
    address,
    deploy: successAction(unusedSnap(), address, `0x${"11".repeat(32)}`),
    lock: successAction(openLockSnap(), address, `0x${"22".repeat(32)}`),
    payout: { phase: "idle" },
    paymentEvidence: "UNPROVEN",
    paymentReason: "not measured",
  };
}

function completeLane(kind: "release" | "refund"): LaneRecord {
  const address = kind === "release" ? RELEASE_ADDR : REFUND_ADDR;
  return {
    ...readyLane(kind),
    payout: successAction(payoutSnap(kind), address, `0x${"33".repeat(32)}`),
    paymentEvidence: "YES",
    paymentReason: "EOA delta matched",
  };
}

describe("payout lock-gating", () => {
  it("disables estimate/sign until this lane has a lock transaction", () => {
    const lane: LaneRecord = {
      ...emptyLane(),
      address: RELEASE_ADDR,
      deploy: successAction(unusedSnap(), RELEASE_ADDR),
    };
    const result = payoutWriteAllowed(lane, ctx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/lock transaction/i);
  });

  it("disables payout while lock is only ACCEPTED even if isSuccessful is true", () => {
    const lane = readyLane("release");
    lane.lock.statusName = "ACCEPTED";
    lane.lock.phase = "waiting";
    const result = payoutWriteAllowed(lane, ctx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/FINALIZED/i);
  });

  it("disables payout when lock is FINALIZED but not isSuccessful", () => {
    const lane = readyLane("release");
    lane.lock.parentSuccessful = false;
    lane.lock.executionName = "FINISHED_WITH_ERROR";
    const result = payoutWriteAllowed(lane, ctx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/isSuccessful|FINALIZED/i);
  });

  it("disables payout when snapshot funder is not the connected wallet", () => {
    const lane = readyLane("release");
    lane.lock.snapshot = openLockSnap({ funder: OTHER });
    const result = payoutWriteAllowed(lane, ctx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/funder/i);
  });

  it("disables payout when snapshot named_wallet is not the entered recipient", () => {
    const lane = readyLane("release");
    lane.lock.snapshot = openLockSnap({ named_wallet: OTHER });
    const result = payoutWriteAllowed(lane, ctx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/named_wallet|recipient/i);
  });

  it("disables payout when locked_amount is not exactly 1000000000000000 wei", () => {
    const lane = readyLane("release");
    lane.lock.snapshot = openLockSnap({ locked_amount: "1000000000000001" });
    const result = payoutWriteAllowed(lane, ctx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/locked_amount/i);
  });

  it("disables payout when snapshot payout_submitted is already true", () => {
    const lane = readyLane("release");
    lane.lock.snapshot = openLockSnap({ payout_submitted: true });
    const result = payoutWriteAllowed(lane, ctx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/payout_submitted/i);
  });

  it("disables payout when lock contract address does not match the live instance", () => {
    const lane = readyLane("release");
    lane.lock.contractAddress = OTHER;
    const result = payoutWriteAllowed(lane, ctx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not the live instance/i);
  });

  it("allows payout estimate/sign only after FINALIZED successful lock + matching snapshot", () => {
    const lane = readyLane("release");
    expect(payoutWriteAllowed(lane, ctx())).toEqual({ ok: true });
    expect(actionWriteAllowed("release", "payout", lane, ctx())).toEqual({ ok: true });
  });

  it("never allows a second payout submit once a tx ID exists", () => {
    const lane = completeLane("release");
    const result = payoutWriteAllowed(lane, ctx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/already has transaction ID/i);
    expect(neverResubmit(lane.payout)).toBe("resume");
  });
});

describe("quote binding", () => {
  const base = {
    wallet: FUNDER,
    chainId: 61997,
    contract: RELEASE_ADDR,
    recipient: RECIPIENT,
    kind: "release" as const,
    name: "payout" as const,
    valueWei: "0",
  };

  it("binds wallet, chain 61997, contract, recipient, method, and attached value", () => {
    const stored = currentQuoteBinding(base);
    expect(stored).toEqual({
      wallet: FUNDER,
      chainId: 61997,
      contract: RELEASE_ADDR,
      recipient: RECIPIENT,
      method: "release_to_named_wallet",
      valueWei: "0",
    });
    expect(quoteStillValid(stored, stored)).toBe(true);
  });

  it("invalidates when wallet, chain, contract, recipient, method, or value changes", () => {
    const stored = currentQuoteBinding(base);
    expect(quoteStillValid(stored, currentQuoteBinding({ ...base, wallet: OTHER }))).toBe(false);
    expect(quoteInvalidReason(stored, currentQuoteBinding({ ...base, wallet: OTHER }))).toMatch(/wallet/i);
    expect(quoteStillValid(stored, currentQuoteBinding({ ...base, chainId: 61999 }))).toBe(false);
    expect(quoteInvalidReason(stored, currentQuoteBinding({ ...base, chainId: 61999 }))).toMatch(/chain/i);
    expect(quoteStillValid(stored, currentQuoteBinding({ ...base, contract: OTHER }))).toBe(false);
    expect(quoteInvalidReason(stored, currentQuoteBinding({ ...base, contract: OTHER }))).toMatch(/contract/i);
    expect(quoteStillValid(stored, currentQuoteBinding({ ...base, recipient: OTHER }))).toBe(false);
    expect(quoteInvalidReason(stored, currentQuoteBinding({ ...base, recipient: OTHER }))).toMatch(/recipient/i);
    expect(quoteStillValid(stored, currentQuoteBinding({ ...base, kind: "refund" }))).toBe(false);
    expect(quoteInvalidReason(stored, currentQuoteBinding({ ...base, kind: "refund" }))).toMatch(/method/i);
    expect(quoteStillValid(stored, currentQuoteBinding({ ...base, valueWei: LOCK }))).toBe(false);
    expect(quoteInvalidReason(stored, currentQuoteBinding({ ...base, valueWei: LOCK }))).toMatch(/value/i);
  });

  it("binds lock quotes to the recipient and exact lock wei", () => {
    const stored = currentQuoteBinding({
      ...base,
      name: "lock",
      valueWei: LOCK,
    });
    expect(stored.method).toBe("lock");
    expect(stored.recipient).toBe(RECIPIENT.toLowerCase());
    expect(stored.valueWei).toBe(LOCK);
    expect(quoteStillValid(stored, currentQuoteBinding({ ...base, name: "lock", recipient: OTHER, valueWei: LOCK }))).toBe(
      false,
    );
  });
});

describe("session isolation", () => {
  it("rejects a newly connected funder against persisted evidence", () => {
    const session: LiveSession = {
      ...emptySession(),
      boundFunder: FUNDER,
      boundRecipient: RECIPIENT,
      recipient: RECIPIENT,
      release: readyLane("release"),
    };
    const result = sessionCompatible(session, OTHER, RECIPIENT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/different account/i);
  });

  it("rejects an edited recipient against persisted evidence", () => {
    const session: LiveSession = {
      ...emptySession(),
      boundFunder: FUNDER,
      boundRecipient: RECIPIENT,
      recipient: OTHER,
    };
    const result = sessionCompatible(session, FUNDER, OTHER);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/mix sessions|bound recipient/i);
  });

  it("allows the original funder and recipient", () => {
    const session: LiveSession = {
      ...emptySession(),
      boundFunder: FUNDER,
      boundRecipient: RECIPIENT,
      recipient: RECIPIENT,
    };
    expect(sessionCompatible(session, FUNDER, RECIPIENT)).toEqual({ ok: true });
  });

  it("imports only an unused probe; already-locked or named instances fail", () => {
    expect(importSnapshotAllowsBind(unusedSnap())).toEqual({ ok: true });
    const locked = importSnapshotAllowsBind(openLockSnap());
    expect(locked.ok).toBe(false);
    const named = importSnapshotAllowsBind({
      ...unusedSnap(),
      funder: FUNDER,
    });
    expect(named.ok).toBe(false);
    const paid = importSnapshotAllowsBind({
      ...unusedSnap(),
      payout_submitted: true,
    });
    expect(paid.ok).toBe(false);
  });
});

describe("overall YES", () => {
  it("stays UNPROVEN until both lanes have deploy, lock, payout, snapshots, and EOA proof", () => {
    const session: LiveSession = {
      version: 2,
      recipient: RECIPIENT,
      boundFunder: FUNDER,
      boundRecipient: RECIPIENT,
      release: completeLane("release"),
      refund: readyLane("refund"),
    };
    const one = guardOverall(session, FUNDER, RECIPIENT);
    expect(one.verdict).toBe("UNPROVEN");
    expect(one.reason).toMatch(/refund/i);

    session.refund = completeLane("refund");
    const both = guardOverall(session, FUNDER, RECIPIENT);
    expect(both.verdict).toBe("YES");

    session.refund.paymentEvidence = "UNPROVEN";
    session.refund.paymentReason = "fee-adjusted refund is UNPROVEN";
    const unpaid = overallVerdict(session, FUNDER, RECIPIENT);
    expect(unpaid.verdict).toBe("UNPROVEN");
    expect(unpaid.reason).toMatch(/payment evidence/i);
  });

  it("is NO when a payout execution failed", () => {
    const session: LiveSession = {
      version: 2,
      recipient: RECIPIENT,
      boundFunder: FUNDER,
      boundRecipient: RECIPIENT,
      release: completeLane("release"),
      refund: completeLane("refund"),
    };
    session.refund.payout.phase = "failed";
    session.refund.payout.parentSuccessful = false;
    expect(guardOverall(session, FUNDER, RECIPIENT).verdict).toBe("NO");
  });
});

describe("resume, refresh, never resubmit", () => {
  it("resumes tracking of a stored tx that is not yet FINALIZED successful", () => {
    const action: ActionRecord = {
      phase: "waiting",
      txId: `0x${"cd".repeat(32)}`,
      statusName: "ACCEPTED",
      parentSuccessful: true,
    };
    expect(needsTxResume(action)).toBe(true);
    expect(neverResubmit(action)).toBe("resume");
    expect(isFinalizedSuccessful(action)).toBe(false);
  });

  it("resumes payment polling for a finalized payout whose transfer is UNPROVEN", () => {
    const lane = completeLane("release");
    lane.paymentEvidence = "UNPROVEN";
    lane.paymentReason = "Named EOA delta still pending";
    expect(needsPaymentResume(lane)).toBe(true);
    lane.paymentEvidence = "YES";
    expect(needsPaymentResume(lane)).toBe(false);
  });

  it("does not treat a failed action as a resume target that should be retried", () => {
    const action: ActionRecord = {
      phase: "failed",
      txId: `0x${"ee".repeat(32)}`,
      statusName: "FINALIZED",
      parentSuccessful: false,
    };
    expect(needsTxResume(action)).toBe(false);
    expect(neverResubmit(action)).toBe("resume");
  });
});

function bals(funderWei: string, namedWei: string, contractWei: string): EoaBalances {
  return {
    funder: FUNDER,
    named: RECIPIENT,
    contract: RELEASE_ADDR,
    funderWei,
    namedWei,
    contractWei,
    unixMs: 0,
  };
}

describe("refund fee evidence", () => {
  const before = bals("1000000000000000000", "0", LOCK);
  const afterExactLock = bals("1001000000000000000", "0", "0");
  const fee = 12_345n;
  const afterNet = bals((10n ** 18n + LOCK_WEI - fee).toString(), "0", "0");

  it("does not treat an implied fee inside feeValue as proof", () => {
    const missing = extractFinalizedFee({ feeValue: "999999" });
    expect(missing.available).toBe(false);
    const result = evaluateRefundPayment(before, afterNet, missing);
    expect(result.verdict).toBe("UNPROVEN");
    expect(result.reason).toMatch(/UNPROVEN/i);
    expect(result.reason).toMatch(/feeValue is not used as proof|Submitted feeValue/i);
  });

  it("YES only when funder delta equals lock minus receipt net fee", () => {
    const actual = extractFinalizedFee({ primary_fee_spent: fee.toString() });
    expect(actual.available).toBe(true);
    const yes = evaluateRefundPayment(before, afterNet, actual);
    expect(yes.verdict).toBe("YES");
    const no = evaluateRefundPayment(before, afterExactLock, actual);
    expect(no.verdict).toBe("UNPROVEN");
  });

  it("reads net fee from required minus refunded when spent is absent", () => {
    const actual = extractFinalizedFee({
      feeAccounting: { primary_fee_required: "1000", primary_fee_refunded: "400" },
    });
    expect(actual.available).toBe(true);
    expect(actual.feeWei).toBe(600n);
    expect(actual.source).toMatch(/required/);
  });

  it("release still requires an exact named-wallet credit of the lock", () => {
    const yes = evaluateReleasePayment(bals("0", "0", LOCK), bals("0", LOCK, "0"));
    expect(yes.verdict).toBe("YES");
    const short = evaluateReleasePayment(bals("0", "0", LOCK), bals("0", "1", "0"));
    expect(short.verdict).toBe("UNPROVEN");
  });
});

describe("unsigned quote invalidation and persist version", () => {
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

  it("strips unsigned quotes but keeps actions that already have a tx ID", () => {
    const session = emptySession();
    session.release.payout = {
      phase: "quoted",
      quotedFeeWei: "1",
      quotedValueWei: "0",
      quotedBinding: currentQuoteBinding({
        wallet: FUNDER,
        chainId: 61997,
        contract: RELEASE_ADDR,
        recipient: RECIPIENT,
        kind: "release",
        name: "payout",
        valueWei: "0",
      }),
    };
    session.release.lock = successAction(openLockSnap(), RELEASE_ADDR);
    const next = invalidateUnsignedQuotes(session);
    expect(next.release.payout.quotedBinding).toBeUndefined();
    expect(next.release.payout.phase).toBe("idle");
    expect(next.release.lock.txId).toBeTruthy();
  });

  it("discards v1 persisted evidence instead of mixing it", () => {
    localStorage.setItem(LIVE_STORAGE_KEY, JSON.stringify({ version: 1, boundFunder: OTHER, recipient: OTHER }));
    const loaded = loadSession();
    expect(loaded.version).toBe(2);
    expect(loaded.boundFunder).toBeUndefined();
    saveSession({ ...emptySession(), boundFunder: FUNDER, boundRecipient: RECIPIENT, recipient: RECIPIENT });
    expect(loadSession().boundFunder?.toLowerCase()).toBe(FUNDER);
  });
});

describe("terminal failure retry", () => {
  it("treats FINALIZED + isSuccessful false as a terminal failure", () => {
    const action: ActionRecord = {
      phase: "failed",
      txId: `0x${"cf".repeat(32)}`,
      statusName: "FINALIZED",
      executionName: "FINISHED_WITH_ERROR",
      parentSuccessful: false,
    };
    expect(isTerminalFailure(action)).toBe(true);
    expect(neverResubmit(action)).toBe("resume");
  });

  it("does not treat ACCEPTED + FINISHED_WITH_ERROR as finished — keep tracking", () => {
    const action: ActionRecord = {
      phase: "waiting",
      txId: `0x${"49".repeat(32)}`,
      statusName: "ACCEPTED",
      executionName: "FINISHED_WITH_ERROR",
      parentSuccessful: false,
    };
    expect(isTerminalFailure(action)).toBe(false);
    expect(needsTxResume(action)).toBe(true);
  });

  it("clears a failed deploy without resubmitting the old hash, and drops the failed contract", () => {
    const lane: LaneRecord = {
      ...emptyLane(),
      address: RELEASE_ADDR,
      deployBlocker: "BudgetTooLow leftover",
      deploy: {
        phase: "failed",
        txId: `0x${"cf".repeat(32)}`,
        statusName: "FINALIZED",
        executionName: "FINISHED_WITH_ERROR",
        parentSuccessful: false,
        contractAddress: RELEASE_ADDR,
        error: "Not successful",
      },
    };
    const next = retryFailedLaneAction(lane, "deploy");
    expect(next.deploy.txId).toBeUndefined();
    expect(next.deploy.phase).toBe("idle");
    expect(next.address).toBeUndefined();
    expect(next.deployBlocker).toBeUndefined();
    expect(neverResubmit(next.deploy)).toBe("submit");
    expect(retryFailedLaneAction(lane, "lock")).toEqual(lane);
  });
});

describe("snapshot helpers", () => {
  it("parses get_snapshot and rejects unused-probe mismatches", () => {
    const parsed = parseProbeSnapshot(unusedSnap());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(snapshotIsUnusedProbe(parsed.snapshot)).toEqual({ ok: true });
    const locked = parseProbeSnapshot(openLockSnap());
    expect(locked.ok).toBe(true);
    if (locked.ok) {
      expect(snapshotIsUnusedProbe(locked.snapshot).ok).toBe(false);
      expect(snapshotMatchesOpenLock({ snapshot: locked.snapshot, funder: FUNDER, recipient: RECIPIENT, contract: RELEASE_ADDR })).toEqual({
        ok: true,
      });
    }
  });
});
