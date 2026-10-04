import { jsonSafe, jsonStringifySafe } from "./format";
import type { EoaBalances } from "./rpc";
import type { QuoteBinding } from "./quotes";

export type Verdict = "YES" | "NO" | "UNPROVEN";
export type LaneKind = "release" | "refund";
export type ActionName = "deploy" | "lock" | "payout";

export type ActionRecord = {
  phase: "idle" | "quoting" | "quoted" | "signing" | "submitted" | "waiting" | "success" | "failed" | "rejected";
  quotedValueWei?: string;
  quotedFeeWei?: string;
  quotedDistribution?: unknown;
  quotedMessageAllocations?: unknown;
  quotedBinding?: QuoteBinding;
  quotedAt?: number;
  txId?: string;
  submittedAt?: number;
  statusName?: string;
  executionName?: string;
  lifecycle?: unknown;
  parentSuccessful?: boolean;
  error?: string;
  snapshot?: unknown;
  contractAddress?: string;
  receipt?: unknown;
  actualFeeWei?: string;
  actualFeeSource?: string;
  actualFeeAvailable?: boolean;
  executionError?: string;
};

export type LaneRecord = {
  address?: string;
  imported?: boolean;
  deployBlocker?: string;
  deploy: ActionRecord;
  lock: ActionRecord;
  payout: ActionRecord;
  beforeLock?: EoaBalances;
  afterLock?: EoaBalances;
  beforePayout?: EoaBalances;
  afterParent?: EoaBalances;
  afterWait?: EoaBalances;
  waitSamples?: EoaBalances[];
  paymentEvidence: Verdict;
  paymentReason: string;
};

export type LiveSession = {
  version: 2;
  recipient: string;
  boundFunder?: string;
  boundRecipient?: string;
  release: LaneRecord;
  refund: LaneRecord;
};

export const LIVE_STORAGE_KEY = "localebounty.live-settlement.v2";

function emptyAction(): ActionRecord {
  return { phase: "idle" };
}

export function emptyLane(): LaneRecord {
  return {
    deploy: emptyAction(),
    lock: emptyAction(),
    payout: emptyAction(),
    paymentEvidence: "UNPROVEN",
    paymentReason: "No Studio-dev payout has been measured yet.",
  };
}

export function emptySession(): LiveSession {
  return {
    version: 2,
    recipient: "",
    release: emptyLane(),
    refund: emptyLane(),
  };
}

function durableAction(action: ActionRecord): ActionRecord {
  if (action.txId) return action;
  if (action.phase === "quoting" || action.phase === "signing" || action.phase === "submitted" || action.phase === "waiting") {
    return { ...action, phase: "idle" };
  }
  return action;
}

function deployIsTerminalFailure(action: ActionRecord): boolean {
  if (!action.txId) return false;
  return action.statusName === "FINALIZED" && action.parentSuccessful === false;
}

function durableLane(lane: LaneRecord): LaneRecord {
  const next: LaneRecord = {
    ...lane,
    deploy: durableAction(lane.deploy),
    lock: durableAction(lane.lock),
    payout: durableAction(lane.payout),
  };
  if (next.deploy.txId) {
    // A later GenLayer hash replaces leftover pre-submit copy (BudgetTooLow, wallet disconnect).
    next.deployBlocker = undefined;
  }
  if (deployIsTerminalFailure(next.deploy) && !next.imported) {
    // Failed deploy receipts can still name a contract. Do not treat that as a live instance.
    next.address = undefined;
  }
  return next;
}

/** Drop in-flight quoting/signing that never got a tx ID so reload cannot stick on Estimating… */
export function resetTransientPhases(session: LiveSession): LiveSession {
  return {
    ...session,
    release: durableLane(session.release),
    refund: durableLane(session.refund),
  };
}

export function loadSession(): LiveSession {
  try {
    const raw = localStorage.getItem(LIVE_STORAGE_KEY);
    if (!raw) return emptySession();
    const parsed = JSON.parse(raw) as Partial<LiveSession>;
    if (parsed.version !== 2) return emptySession();
    return {
      version: 2,
      recipient: typeof parsed.recipient === "string" ? parsed.recipient : "",
      boundFunder: typeof parsed.boundFunder === "string" ? parsed.boundFunder : undefined,
      boundRecipient: typeof parsed.boundRecipient === "string" ? parsed.boundRecipient : undefined,
      release: durableLane({ ...emptyLane(), ...(parsed.release ?? {}) }),
      refund: durableLane({ ...emptyLane(), ...(parsed.refund ?? {}) }),
    };
  } catch {
    return emptySession();
  }
}

function txIdFallback(session: LiveSession): LiveSession {
  const strip = (lane: LaneRecord): LaneRecord => ({
    ...emptyLane(),
    address: lane.address,
    imported: lane.imported,
    deploy: { phase: lane.deploy.phase, txId: lane.deploy.txId, statusName: lane.deploy.statusName, executionName: lane.deploy.executionName, parentSuccessful: lane.deploy.parentSuccessful },
    lock: { phase: lane.lock.phase, txId: lane.lock.txId, statusName: lane.lock.statusName, executionName: lane.lock.executionName, parentSuccessful: lane.lock.parentSuccessful },
    payout: { phase: lane.payout.phase, txId: lane.payout.txId, statusName: lane.payout.statusName, executionName: lane.payout.executionName, parentSuccessful: lane.payout.parentSuccessful },
    paymentEvidence: lane.paymentEvidence,
    paymentReason: lane.paymentReason,
  });
  return {
    version: 2,
    recipient: session.recipient,
    boundFunder: session.boundFunder,
    boundRecipient: session.boundRecipient,
    release: strip(session.release),
    refund: strip(session.refund),
  };
}

/**
 * Persist JSON-safe display evidence only. Typed genlayer-js fee estimates
 * (bigint FeesDistribution) stay in the in-memory quote ref, never here.
 */
export function saveSession(session: LiveSession): void {
  const display: LiveSession = {
    ...session,
    release: durableLane(omitTypedQuoteBlobs(session.release)),
    refund: durableLane(omitTypedQuoteBlobs(session.refund)),
  };
  try {
    localStorage.setItem(LIVE_STORAGE_KEY, jsonStringifySafe(jsonSafe(display)));
  } catch {
    try {
      localStorage.setItem(LIVE_STORAGE_KEY, jsonStringifySafe(jsonSafe(txIdFallback(session))));
    } catch {
      // Never throw out of persist: a stringify failure must not blank the page or drop tx IDs from memory.
    }
  }
}

function omitTypedQuoteBlobs(lane: LaneRecord): LaneRecord {
  const strip = (action: ActionRecord): ActionRecord => ({
    ...action,
    quotedDistribution: undefined,
    quotedMessageAllocations: undefined,
  });
  return {
    ...lane,
    deploy: strip(lane.deploy),
    lock: strip(lane.lock),
    payout: strip(lane.payout),
  };
}

export function clearSession(): LiveSession {
  const next = emptySession();
  saveSession(next);
  return next;
}

export function invalidateQuotedAction(action: ActionRecord): ActionRecord {
  if (action.txId) return action;
  if (action.phase !== "quoted" && action.phase !== "quoting" && !action.quotedBinding) return action;
  return {
    ...action,
    phase: "idle",
    quotedBinding: undefined,
    quotedFeeWei: undefined,
    quotedValueWei: undefined,
    quotedDistribution: undefined,
    quotedMessageAllocations: undefined,
    error: action.phase === "quoted" ? "Fee quote invalidated. Estimate again before signing." : action.error,
  };
}

export function invalidateUnsignedQuotes(session: LiveSession): LiveSession {
  const strip = (lane: LaneRecord): LaneRecord => ({
    ...lane,
    deploy: invalidateQuotedAction(lane.deploy),
    lock: invalidateQuotedAction(lane.lock),
    payout: invalidateQuotedAction(lane.payout),
  });
  return { ...session, release: strip(session.release), refund: strip(session.refund) };
}
