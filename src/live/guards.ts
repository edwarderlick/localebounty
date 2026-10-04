import { addressesEqual, isEoaAddress, isZeroAddress } from "./format";
import { LOCK_WEI, STUDIO_DEV_CHAIN_ID } from "./network";
import type { ActionName, ActionRecord, LaneKind, LaneRecord, LiveSession, Verdict } from "./persist";
import {
  parseProbeSnapshot,
  snapshotIsUnusedProbe,
  snapshotMatchesOpenLock,
  snapshotMatchesPayout,
  type GuardResult,
} from "./snapshot";

export type WriteContext = {
  funder?: string;
  chainId?: number;
  recipient: string;
  connected: boolean;
};

function fail(reason: string): GuardResult {
  return { ok: false, reason };
}

type TxActionRef = Pick<ActionRecord, "txId" | "parentSuccessful" | "statusName" | "phase">;

export function hasTxId(action: Pick<ActionRecord, "txId">): boolean {
  return Boolean(action.txId);
}

export function isFinalizedSuccessful(action: TxActionRef): boolean {
  return Boolean(
    action.txId &&
      action.parentSuccessful &&
      action.statusName === "FINALIZED" &&
      (action.phase === "success" || action.phase === "waiting" || action.phase === "submitted"),
  );
}

export function sessionHasEvidence(session: LiveSession): boolean {
  return (["release", "refund"] as LaneKind[]).some((kind) => {
    const lane = session[kind];
    return Boolean(lane.address || lane.deploy.txId || lane.lock.txId || lane.payout.txId || lane.imported);
  });
}

export function sessionCompatible(session: LiveSession, funder: string | undefined, recipient: string): GuardResult {
  if (!session.boundFunder && !session.boundRecipient) return { ok: true };
  if (session.boundFunder) {
    if (!funder) return fail(`Persisted evidence is bound to funder ${session.boundFunder}. Connect that wallet; do not mix accounts.`);
    if (!addressesEqual(session.boundFunder, funder)) {
      return fail(
        `Persisted evidence is bound to funder ${session.boundFunder}. Connected ${funder} is a different account. Clear tracking or reconnect the original funder.`,
      );
    }
  }
  if (session.boundRecipient && recipient) {
    if (!addressesEqual(session.boundRecipient, recipient)) {
      return fail(
        `Persisted evidence is bound to recipient ${session.boundRecipient}. The edited recipient ${recipient} would mix sessions. Clear tracking or restore the bound recipient.`,
      );
    }
  }
  return { ok: true };
}

export function bindSession(session: LiveSession, funder: string, recipient: string): LiveSession {
  return {
    ...session,
    boundFunder: session.boundFunder ?? funder,
    boundRecipient: session.boundRecipient ?? recipient,
  };
}

export function walletReady(ctx: WriteContext): GuardResult {
  if (!ctx.funder) {
    return fail(
      ctx.connected
        ? "Unlock the connected wallet. Tracking was not cleared."
        : "Connect a wallet first.",
    );
  }
  if (!ctx.connected) return fail("Connect a wallet first.");
  if (ctx.chainId !== STUDIO_DEV_CHAIN_ID) {
    return fail(`Wrong chain (${ctx.chainId ?? "unknown"}). Switch to Studio-dev ${STUDIO_DEV_CHAIN_ID}.`);
  }
  if (!isEoaAddress(ctx.recipient) || isZeroAddress(ctx.recipient)) {
    return fail("Enter a valid named recipient EOA.");
  }
  if (addressesEqual(ctx.recipient, ctx.funder)) {
    return fail("Named recipient must be a different EOA than the connected funder.");
  }
  return { ok: true };
}

export function instanceReadyForLock(lane: LaneRecord): GuardResult {
  if (!lane.address) return fail("Deploy or import a contract address first.");
  const parsed = parseProbeSnapshot(lane.deploy.snapshot);
  if (!parsed.ok) return fail(`Instance snapshot check failed: ${parsed.reason}`);
  const unused = snapshotIsUnusedProbe(parsed.snapshot);
  if (!unused.ok) return unused;
  if (lane.imported) return { ok: true };
  if (!isFinalizedSuccessful(lane.deploy) && !lane.deploy.txId) {
    return fail("Deploy is not finalized and successful, and this instance was not imported.");
  }
  if (lane.deploy.txId && !isFinalizedSuccessful(lane.deploy)) {
    return fail("Deploy transaction exists but is not finalized and successful yet. Not resubmitting.");
  }
  return { ok: true };
}

export function importSnapshotAllowsBind(raw: unknown): GuardResult {
  const parsed = parseProbeSnapshot(raw);
  if (!parsed.ok) return parsed;
  return snapshotIsUnusedProbe(parsed.snapshot);
}

export function lockWriteAllowed(lane: LaneRecord, ctx: WriteContext): GuardResult {
  const ready = walletReady(ctx);
  if (!ready.ok) return ready;
  if (hasTxId(lane.lock)) return fail(`Lock already has transaction ID ${lane.lock.txId}. Resume tracking; do not resubmit.`);
  return instanceReadyForLock(lane);
}

export function payoutWriteAllowed(lane: LaneRecord, ctx: WriteContext): GuardResult {
  const ready = walletReady(ctx);
  if (!ready.ok) return ready;
  if (hasTxId(lane.payout)) {
    return fail(`Payout already has transaction ID ${lane.payout.txId}. Resume tracking; do not resubmit.`);
  }
  if (!lane.address) return fail("Need the lane contract address.");
  if (lane.lock.contractAddress && !addressesEqual(lane.lock.contractAddress, lane.address)) {
    return fail(
      `Lock was recorded against ${lane.lock.contractAddress}, not the live instance ${lane.address}.`,
    );
  }
  if (!lane.lock.txId) return fail("Payout is disabled until this lane records a lock transaction.");
  if (!isFinalizedSuccessful(lane.lock)) {
    return fail(
      `Payout is disabled until lock ${lane.lock.txId} is FINALIZED and isSuccessful (status=${lane.lock.statusName ?? "unknown"}, execution=${lane.lock.executionName ?? "unknown"}).`,
    );
  }
  const parsed = parseProbeSnapshot(lane.lock.snapshot);
  if (!parsed.ok) return fail(`Lock snapshot check failed: ${parsed.reason}`);
  if (!ctx.funder) return fail("Connect the funder wallet.");
  const match = snapshotMatchesOpenLock({
    snapshot: parsed.snapshot,
    funder: ctx.funder,
    recipient: ctx.recipient,
    contract: lane.address,
  });
  if (!match.ok) return match;
  return { ok: true };
}

export function actionWriteAllowed(_kind: LaneKind, name: ActionName, lane: LaneRecord, ctx: WriteContext): GuardResult {
  const ready = walletReady(ctx);
  if (!ready.ok) return ready;
  if (name === "deploy") {
    if (hasTxId(lane.deploy)) return fail(`Deploy already has transaction ID ${lane.deploy.txId}. Do not resubmit.`);
    return { ok: true };
  }
  if (name === "lock") return lockWriteAllowed(lane, ctx);
  return payoutWriteAllowed(lane, ctx);
}

export function needsTxResume(action: ActionRecord): boolean {
  return Boolean(action.txId) && !isFinalizedSuccessful(action) && !isTerminalFailure(action);
}

export function needsPaymentResume(lane: LaneRecord): boolean {
  return isFinalizedSuccessful(lane.payout) && lane.paymentEvidence !== "YES";
}

export function neverResubmit(action: Pick<ActionRecord, "txId">): "resume" | "submit" {
  return hasTxId(action) ? "resume" : "submit";
}

export function isTerminalFailure(action: Pick<ActionRecord, "txId" | "statusName" | "parentSuccessful">): boolean {
  if (!action.txId) return false;
  return action.statusName === "FINALIZED" && action.parentSuccessful === false;
}

/** User-started retry of a finalized failed write. Does not resubmit the old tx ID. */
export function retryFailedLaneAction(lane: LaneRecord, name: ActionName): LaneRecord {
  const action = lane[name];
  if (!isTerminalFailure(action)) return lane;
  const cleared: ActionRecord = { phase: "idle" };
  const next: LaneRecord = { ...lane, [name]: cleared, deployBlocker: name === "deploy" ? undefined : lane.deployBlocker };
  if (name === "deploy" && !isFinalizedSuccessful(lane.deploy)) {
    next.address = undefined;
    next.imported = undefined;
  }
  return next;
}

export function laneDeployValidated(lane: LaneRecord): GuardResult {
  if (!lane.address) return fail("Lane has no contract address.");
  const parsed = parseProbeSnapshot(lane.deploy.snapshot ?? lane.lock.snapshot);
  if (!parsed.ok) return fail(`Deploy/import snapshot invalid: ${parsed.reason}`);
  if (lane.imported) {
    const unused = snapshotIsUnusedProbe(parsed.snapshot);
    if (!unused.ok && !isFinalizedSuccessful(lane.lock)) return unused;
  } else if (!isFinalizedSuccessful(lane.deploy)) {
    return fail("Deploy is not finalized and successful.");
  }
  return { ok: true };
}

export function laneLockValidated(lane: LaneRecord, funder: string, recipient: string): GuardResult {
  if (!isFinalizedSuccessful(lane.lock)) return fail("Lock is not finalized and successful.");
  if (!lane.address) return fail("Lane has no contract address for the lock snapshot.");
  if (lane.lock.contractAddress && !addressesEqual(lane.lock.contractAddress, lane.address)) {
    return fail(`Lock contract ${lane.lock.contractAddress} does not match live instance ${lane.address}.`);
  }
  const parsed = parseProbeSnapshot(lane.lock.snapshot);
  if (!parsed.ok) return fail(parsed.reason);
  return snapshotMatchesOpenLock({ snapshot: parsed.snapshot, funder, recipient, contract: lane.address });
}

export function lanePayoutValidated(lane: LaneRecord, kind: LaneKind, funder: string, recipient: string): GuardResult {
  if (!isFinalizedSuccessful(lane.payout)) return fail("Payout is not finalized and successful.");
  if (!lane.address) return fail("Lane has no contract address for the payout snapshot.");
  const parsed = parseProbeSnapshot(lane.payout.snapshot);
  if (!parsed.ok) return fail(parsed.reason);
  return snapshotMatchesPayout({ snapshot: parsed.snapshot, funder, recipient, contract: lane.address, kind });
}

export function laneComplete(input: {
  lane: LaneRecord;
  kind: LaneKind;
  funder: string;
  recipient: string;
}): GuardResult {
  const deploy = laneDeployValidated(input.lane);
  if (!deploy.ok) return fail(`${input.kind} deploy/import: ${deploy.reason}`);
  const lock = laneLockValidated(input.lane, input.funder, input.recipient);
  if (!lock.ok) return fail(`${input.kind} lock: ${lock.reason}`);
  const payout = lanePayoutValidated(input.lane, input.kind, input.funder, input.recipient);
  if (!payout.ok) return fail(`${input.kind} payout: ${payout.reason}`);
  if (input.lane.paymentEvidence !== "YES") {
    return fail(`${input.kind} payment evidence is ${input.lane.paymentEvidence}: ${input.lane.paymentReason}`);
  }
  return { ok: true };
}

export function overallVerdict(session: LiveSession, funder?: string, recipient?: string): { verdict: Verdict; reason: string } {
  if (session.release.payout.phase === "failed" || session.refund.payout.phase === "failed") {
    return {
      verdict: "NO",
      reason: "A payout write reached a failed execution or consensus result. Finalized/accepted alone is not success.",
    };
  }
  if (session.release.lock.phase === "failed" || session.refund.lock.phase === "failed") {
    return {
      verdict: "NO",
      reason: "A lock write reached a failed execution. Payout was not proven.",
    };
  }

  const compat = sessionCompatible(session, funder, recipient ?? session.recipient);
  if (!compat.ok) return { verdict: "UNPROVEN", reason: compat.reason };

  if (!funder || !recipient) {
    return { verdict: "UNPROVEN", reason: "Overall YES needs the bound funder connected and the bound recipient entered." };
  }

  const release = laneComplete({ lane: session.release, kind: "release", funder, recipient });
  const refund = laneComplete({ lane: session.refund, kind: "refund", funder, recipient });
  if (release.ok && refund.ok) {
    return {
      verdict: "YES",
      reason:
        "Both lanes have validated deploy/import, finalized successful lock, finalized successful payout, matching snapshots, and measured EOA balance proof.",
    };
  }
  const parts = [!release.ok ? release.reason : null, !refund.ok ? refund.reason : null].filter(Boolean);
  return { verdict: "UNPROVEN", reason: parts.join(" ") };
}

export function expectedValueWei(name: ActionName): string {
  return name === "lock" ? LOCK_WEI.toString() : "0";
}
