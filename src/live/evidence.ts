import { extractFinalizedFee, type FinalizedFee } from "./fees";
import { jsonStringifySafe } from "./format";
import { overallVerdict as overallFromGuards } from "./guards";
import { LOCK_WEI } from "./network";
import type { LiveSession, Verdict } from "./persist";
import type { EoaBalances } from "./rpc";

function delta(after: string | null | undefined, before: string | null | undefined): bigint | null {
  if (after == null || before == null) return null;
  try {
    return BigInt(after) - BigInt(before);
  } catch {
    return null;
  }
}

export function evaluateReleasePayment(before: EoaBalances | undefined, after: EoaBalances | undefined): {
  verdict: Verdict;
  reason: string;
  namedGainWei: string | null;
} {
  if (!before || !after) {
    return {
      verdict: "UNPROVEN",
      reason: "Missing before/after Studio-dev EOA balances for the named recipient.",
      namedGainWei: null,
    };
  }
  const namedGain = delta(after.namedWei, before.namedWei);
  if (namedGain == null) {
    return { verdict: "UNPROVEN", reason: "Named-wallet balance delta could not be computed.", namedGainWei: null };
  }
  if (namedGain === LOCK_WEI) {
    return {
      verdict: "YES",
      reason: `Named EOA gained exactly ${LOCK_WEI.toString()} wei (lock amount). Parent success was not treated as payment.`,
      namedGainWei: namedGain.toString(),
    };
  }
  return {
    verdict: "UNPROVEN",
    reason: `Named EOA delta is ${namedGain.toString()} wei, expected exactly ${LOCK_WEI.toString()} wei. Outgoing EthSend may still be pending, or Studio-dev did not credit the EOA.`,
    namedGainWei: namedGain.toString(),
  };
}

export function evaluateRefundPayment(
  before: EoaBalances | undefined,
  after: EoaBalances | undefined,
  actualFee: FinalizedFee,
): {
  verdict: Verdict;
  reason: string;
  funderDeltaWei: string | null;
  impliedFeeWei: string | null;
} {
  if (!before || !after) {
    return {
      verdict: "UNPROVEN",
      reason: "Missing before/after Studio-dev EOA balances for the funder.",
      funderDeltaWei: null,
      impliedFeeWei: null,
    };
  }
  const funderDelta = delta(after.funderWei, before.funderWei);
  const namedGain = delta(after.namedWei, before.namedWei);
  if (funderDelta == null || namedGain == null) {
    return {
      verdict: "UNPROVEN",
      reason: "Funder or named balance delta could not be computed.",
      funderDeltaWei: funderDelta?.toString() ?? null,
      impliedFeeWei: null,
    };
  }
  if (namedGain !== 0n) {
    return {
      verdict: "UNPROVEN",
      reason: `Refund must not credit the named wallet; named delta is ${namedGain.toString()} wei.`,
      funderDeltaWei: funderDelta.toString(),
      impliedFeeWei: (LOCK_WEI - funderDelta).toString(),
    };
  }
  const impliedFee = LOCK_WEI - funderDelta;
  if (!actualFee.available || actualFee.feeWei == null) {
    return {
      verdict: "UNPROVEN",
      reason: `Fee-adjusted refund is UNPROVEN. Implied fee from balances is ${impliedFee.toString()} wei, but ${actualFee.reason} Submitted feeValue is not used as proof.`,
      funderDeltaWei: funderDelta.toString(),
      impliedFeeWei: impliedFee.toString(),
    };
  }
  const expectedDelta = LOCK_WEI - actualFee.feeWei;
  if (funderDelta === expectedDelta) {
    return {
      verdict: "YES",
      reason: `Funder delta ${funderDelta.toString()} wei equals lock ${LOCK_WEI.toString()} minus receipt fee ${actualFee.feeWei.toString()} wei (${actualFee.source}).`,
      funderDeltaWei: funderDelta.toString(),
      impliedFeeWei: impliedFee.toString(),
    };
  }
  return {
    verdict: "UNPROVEN",
    reason: `Funder delta ${funderDelta.toString()} wei does not equal lock ${LOCK_WEI.toString()} minus receipt fee ${actualFee.feeWei.toString()} wei (expected delta ${expectedDelta.toString()}). ${actualFee.reason}`,
    funderDeltaWei: funderDelta.toString(),
    impliedFeeWei: impliedFee.toString(),
  };
}

export function overallVerdict(session: LiveSession, funder?: string, chainRecipient?: string) {
  return overallFromGuards(session, funder, chainRecipient ?? session.recipient);
}

export function buildEvidencePayload(input: {
  funder?: string;
  chainId?: number;
  session: LiveSession;
}): string {
  const overall = overallVerdict(input.session, input.funder, input.session.boundRecipient ?? input.session.recipient);
  return jsonStringifySafe(
    {
      label: "LocaleBounty Live Settlement Test — public evidence",
      network: {
        name: "GenLayer Studio Devnet",
        chainIdExpected: 61997,
        chainIdWallet: input.chainId ?? null,
        rpc: "https://studio-dev.genlayer.com/api",
      },
      funder: input.funder ?? null,
      boundFunder: input.session.boundFunder ?? null,
      namedRecipient: input.session.recipient || null,
      boundRecipient: input.session.boundRecipient ?? null,
      lockWei: LOCK_WEI.toString(),
      lockGen: "0.001",
      payoutPath: "eoa_external_eth_send",
      payoutApi: "gl.evm.contract_interface.emit_transfer",
      sdk: "genlayer-js@2.0.0-rc.1",
      overall,
      release: summarizeLane("release", input.session.release),
      refund: summarizeLane("refund", input.session.refund),
      note: "No private keys. Parent transaction success is not payment. Refund YES requires a receipt net fee, not a feeValue range. UNPROVEN if EOA deltas are missing or ambiguous.",
    },
    2,
  );
}

function summarizeLane(kind: string, lane: LiveSession["release"]) {
  const fee = extractFinalizedFee(lane.payout.receipt);
  return {
    kind,
    contractAddress: lane.address ?? null,
    imported: Boolean(lane.imported),
    deployTxId: lane.deploy.txId ?? null,
    lockTxId: lane.lock.txId ?? null,
    payoutTxId: lane.payout.txId ?? null,
    deploy: publicAction(lane.deploy),
    lock: publicAction(lane.lock),
    payout: publicAction(lane.payout),
    beforePayout: lane.beforePayout ?? null,
    afterWait: lane.afterWait ?? null,
    actualFeeWei: lane.payout.actualFeeWei ?? null,
    actualFeeSource: lane.payout.actualFeeSource ?? null,
    actualFeeAvailable: lane.payout.actualFeeAvailable ?? fee.available,
    paymentEvidence: lane.paymentEvidence,
    paymentReason: lane.paymentReason,
  };
}

function publicAction(action: LiveSession["release"]["deploy"]) {
  return {
    txId: action.txId ?? null,
    statusName: action.statusName ?? null,
    executionName: action.executionName ?? null,
    parentSuccessful: action.parentSuccessful ?? null,
    quotedValueWei: action.quotedValueWei ?? null,
    quotedFeeWei: action.quotedFeeWei ?? null,
    quotedBinding: action.quotedBinding ?? null,
    snapshot: action.snapshot ?? null,
    error: action.error ?? null,
  };
}

export { extractFinalizedFee };
