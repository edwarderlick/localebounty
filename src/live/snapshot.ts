import { addressesEqual, isEoaAddress, isZeroAddress } from "./format";
import { LOCK_WEI } from "./network";
import { isRecord } from "./eip1193";

export type ProbeSnapshot = {
  funder: string;
  namedWallet: string;
  lockedAmount: bigint;
  locked: boolean;
  payoutSubmitted: boolean;
  payoutKind: string;
  contractBalance?: bigint;
};

export type GuardResult = { ok: true } | { ok: false; reason: string };

function asBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function asBigInt(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return BigInt(value.trim());
  return undefined;
}

function asAddress(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!isEoaAddress(trimmed)) return undefined;
  return trimmed;
}

export function parseProbeSnapshot(raw: unknown): { ok: true; snapshot: ProbeSnapshot } | { ok: false; reason: string } {
  if (!isRecord(raw)) return { ok: false, reason: "get_snapshot() did not return an object." };
  if ("read_error" in raw) return { ok: false, reason: `get_snapshot() failed: ${String(raw.read_error)}` };
  const funder = asAddress(raw.funder);
  const namedWallet = asAddress(raw.named_wallet ?? raw.namedWallet);
  const lockedAmount = asBigInt(raw.locked_amount ?? raw.lockedAmount);
  const locked = asBool(raw.locked);
  const payoutSubmitted = asBool(raw.payout_submitted ?? raw.payoutSubmitted);
  if (!funder) return { ok: false, reason: "Snapshot missing funder address." };
  if (!namedWallet) return { ok: false, reason: "Snapshot missing named_wallet address." };
  if (lockedAmount == null) return { ok: false, reason: "Snapshot missing locked_amount." };
  if (locked == null) return { ok: false, reason: "Snapshot missing locked flag." };
  if (payoutSubmitted == null) return { ok: false, reason: "Snapshot missing payout_submitted flag." };
  return {
    ok: true,
    snapshot: {
      funder,
      namedWallet,
      lockedAmount,
      locked,
      payoutSubmitted,
      payoutKind: typeof raw.payout_kind === "string" ? raw.payout_kind : typeof raw.payoutKind === "string" ? raw.payoutKind : "",
      contractBalance: asBigInt(raw.contract_balance ?? raw.contractBalance),
    },
  };
}

export function snapshotIsUnusedProbe(snapshot: ProbeSnapshot): GuardResult {
  if (snapshot.payoutSubmitted) {
    return { ok: false, reason: "Imported instance already has payout_submitted; it is not a fresh probe." };
  }
  if (snapshot.locked || snapshot.lockedAmount !== 0n) {
    return { ok: false, reason: "Imported instance is already locked. This test must lock from the connected funder in-app." };
  }
  if (!isZeroAddress(snapshot.funder)) {
    return { ok: false, reason: "Imported instance already names a funder. Import only an unused settlement_probe." };
  }
  if (!isZeroAddress(snapshot.namedWallet)) {
    return { ok: false, reason: "Imported instance already names a recipient. Import only an unused settlement_probe." };
  }
  return { ok: true };
}

export function snapshotMatchesOpenLock(input: {
  snapshot: ProbeSnapshot;
  funder: string;
  recipient: string;
  contract: string;
}): GuardResult {
  const { snapshot, funder, recipient, contract } = input;
  if (!isEoaAddress(contract) || isZeroAddress(contract)) {
    return { ok: false, reason: "Snapshot check needs the live contract address." };
  }
  if (!addressesEqual(snapshot.funder, funder)) {
    return {
      ok: false,
      reason: `Snapshot funder ${snapshot.funder} does not match connected wallet ${funder}.`,
    };
  }
  if (!addressesEqual(snapshot.namedWallet, recipient)) {
    return {
      ok: false,
      reason: `Snapshot named_wallet ${snapshot.namedWallet} does not match entered recipient ${recipient}.`,
    };
  }
  if (snapshot.lockedAmount !== LOCK_WEI) {
    return {
      ok: false,
      reason: `Snapshot locked_amount is ${snapshot.lockedAmount.toString()} wei, expected ${LOCK_WEI.toString()}.`,
    };
  }
  if (!snapshot.locked) {
    return { ok: false, reason: "Snapshot locked flag is false." };
  }
  if (snapshot.payoutSubmitted) {
    return { ok: false, reason: "Snapshot payout_submitted is already true; payout would be a second emit." };
  }
  return { ok: true };
}

export function snapshotMatchesPayout(input: {
  snapshot: ProbeSnapshot;
  funder: string;
  recipient: string;
  contract: string;
  kind: "release" | "refund";
}): GuardResult {
  const open = snapshotMatchesOpenLock({
    snapshot: { ...input.snapshot, payoutSubmitted: false },
    funder: input.funder,
    recipient: input.recipient,
    contract: input.contract,
  });
  if (!open.ok) return open;
  if (!input.snapshot.payoutSubmitted) {
    return { ok: false, reason: "Payout snapshot does not show payout_submitted." };
  }
  const expectedKind = input.kind;
  if (input.snapshot.payoutKind && input.snapshot.payoutKind !== expectedKind) {
    return {
      ok: false,
      reason: `Snapshot payout_kind is ${input.snapshot.payoutKind}, expected ${expectedKind}.`,
    };
  }
  return { ok: true };
}
