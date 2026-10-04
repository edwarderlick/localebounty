import { extractFinalizedFee, type FinalizedFee } from "../fees";
import { addressesEqual, jsonStringifySafe } from "../format";
import { isFinalizedSuccessful } from "../guards";
import type { EoaBalances } from "../rpc";
import { STATE_CANCELLED } from "./constants";
import type { ProductSession, Verdict } from "./persist";
import { createdTaskMatchesBound, sessionRewardWei } from "./task";
import {
  childCreditRequirementNote,
  collectTransferEvidence,
  matchingChildCredit,
  matchingOutgoingTo,
  type TransferEvidence,
} from "./transfers";

function delta(after: string | null | undefined, before: string | null | undefined): bigint | null {
  if (after == null || before == null) return null;
  try {
    return BigInt(after) - BigInt(before);
  } catch {
    return null;
  }
}

export type CancelPaymentEval = {
  verdict: Verdict;
  reason: string;
  transferLabel: string;
  balanceLabel: string;
  funderDeltaWei: string | null;
  namedGainWei: string | null;
  impliedFeeWei: string | null;
};

export function parentSuccessIsNotPayment(statusName?: string, executionName?: string, parentSuccessful?: boolean): string {
  return `Transaction status ${statusName ?? "unknown"} and execution ${executionName ?? "unknown"} (parentSuccessful=${String(Boolean(parentSuccessful))}) are not transfer delivery and are not balance evidence.`;
}

export function evaluateCancelRefund(input: {
  parentSuccessful: boolean;
  statusName?: string;
  executionName?: string;
  parentTxId?: string;
  rewardWei: bigint;
  funder: string;
  named: string;
  transfer: TransferEvidence | undefined;
  before?: EoaBalances;
  after?: EoaBalances;
  actualFee: FinalizedFee;
}): CancelPaymentEval {
  const parentNote = parentSuccessIsNotPayment(input.statusName, input.executionName, input.parentSuccessful);
  const transfer = input.transfer ?? {
    outgoing: [],
    children: [],
    parseOk: false,
    parseNote: "No transfer evidence stored.",
  };

  const outgoing = matchingOutgoingTo(transfer, input.funder, input.rewardWei.toString());
  const child = matchingChildCredit(transfer, input.funder, input.rewardWei.toString(), input.parentTxId);
  const transferOk = Boolean(outgoing && child);
  const transferLabel = transferOk
    ? `Outgoing EthSend to funder ${input.funder} value ${input.rewardWei.toString()} wei; child value_credited true, recipient ${child?.to}, triggered_by ${child?.triggeredBy}${child?.txId ? ` (${child.txId})` : ""}.`
    : `UNPROVEN. ${childCreditRequirementNote(input.parentTxId)} ${transfer.parseNote} ${parentNote}`;

  const funderDelta = delta(input.after?.funderWei, input.before?.funderWei);
  const namedGain = delta(input.after?.namedWei, input.before?.namedWei);
  let balanceLabel = "UNPROVEN. Missing before/after Studio-dev EOA balances.";
  if (funderDelta != null && namedGain != null) {
    balanceLabel = `Funder delta ${funderDelta.toString()} wei; named translator delta ${namedGain.toString()} wei.`;
  }

  if (!input.parentSuccessful || input.statusName !== "FINALIZED") {
    return {
      verdict: "UNPROVEN",
      reason: `Cancel parent is not FINALIZED + isSuccessful. ${parentNote}`,
      transferLabel,
      balanceLabel,
      funderDeltaWei: funderDelta?.toString() ?? null,
      namedGainWei: namedGain?.toString() ?? null,
      impliedFeeWei: null,
    };
  }

  if (!transferOk) {
    return {
      verdict: "UNPROVEN",
      reason: `Cancel parent succeeded. ${parentNote} Outgoing EthSend to the funder for the exact reward and child value_credited are required before any refund claim.`,
      transferLabel,
      balanceLabel,
      funderDeltaWei: funderDelta?.toString() ?? null,
      namedGainWei: namedGain?.toString() ?? null,
      impliedFeeWei: null,
    };
  }

  if (funderDelta == null || namedGain == null || !input.before || !input.after) {
    return {
      verdict: "UNPROVEN",
      reason: `Transfer fields were parsed, but fee-adjusted funder delta is still UNPROVEN (missing EOA snapshots). ${parentNote}`,
      transferLabel,
      balanceLabel,
      funderDeltaWei: funderDelta?.toString() ?? null,
      namedGainWei: namedGain?.toString() ?? null,
      impliedFeeWei: null,
    };
  }

  if (namedGain !== 0n) {
    return {
      verdict: "UNPROVEN",
      reason: `Named translator delta is ${namedGain.toString()} wei; cancel refund must not credit the translator.`,
      transferLabel,
      balanceLabel,
      funderDeltaWei: funderDelta.toString(),
      namedGainWei: namedGain.toString(),
      impliedFeeWei: (input.rewardWei - funderDelta).toString(),
    };
  }

  if (!input.actualFee.available || input.actualFee.feeWei == null) {
    const implied = input.rewardWei - funderDelta;
    return {
      verdict: "UNPROVEN",
      reason: `Fee-adjusted refund is UNPROVEN. Implied fee from balances is ${implied.toString()} wei, but ${input.actualFee.reason} Submitted feeValue is not used as proof.`,
      transferLabel,
      balanceLabel,
      funderDeltaWei: funderDelta.toString(),
      namedGainWei: namedGain.toString(),
      impliedFeeWei: implied.toString(),
    };
  }

  const expectedDelta = input.rewardWei - input.actualFee.feeWei;
  if (funderDelta === expectedDelta) {
    return {
      verdict: "YES",
      reason: `Refund transfer delivered: funder delta ${funderDelta.toString()} wei equals reward ${input.rewardWei.toString()} minus receipt fee ${input.actualFee.feeWei.toString()} wei (${input.actualFee.source}). Named delta 0. Outgoing EthSend and child value_credited matched.`,
      transferLabel,
      balanceLabel: `${balanceLabel} Matches reward minus receipt fee.`,
      funderDeltaWei: funderDelta.toString(),
      namedGainWei: namedGain.toString(),
      impliedFeeWei: input.actualFee.feeWei.toString(),
    };
  }

  return {
    verdict: "UNPROVEN",
    reason: `Funder delta ${funderDelta.toString()} wei does not equal reward ${input.rewardWei.toString()} minus receipt fee ${input.actualFee.feeWei.toString()} wei (expected ${expectedDelta.toString()}). ${parentNote}`,
    transferLabel,
    balanceLabel,
    funderDeltaWei: funderDelta.toString(),
    namedGainWei: namedGain.toString(),
    impliedFeeWei: (input.rewardWei - funderDelta).toString(),
  };
}

export const PAYOUT_SUBMITTED_IS_NOT_PAYMENT =
  "Contract payout_submitted is not child delivery and is not balance proof.";

export function overallProductVerdict(session: ProductSession): { verdict: Verdict; reason: string } {
  const storedFlag =
    `UNPROVEN. Stored paymentEvidence is not proof. The overall verdict is recomputed from the bound create reward, get_task, cancel state, transfer, fee, and balances. ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`;
  if (session.deploy.phase === "failed" || session.create.phase === "failed" || session.cancel.phase === "failed") {
    return {
      verdict: "UNPROVEN",
      reason: `A Phase A write reached FINALIZED without isSuccessful, or is still incomplete. ${storedFlag}`,
    };
  }
  if (
    !session.sourceMatch ||
    !session.address ||
    !session.sourceVerifiedAddress ||
    !addressesEqual(session.address, session.sourceVerifiedAddress)
  ) {
    return {
      verdict: "UNPROVEN",
      reason: `Source is not bound to this deployed address. ${storedFlag}`,
    };
  }
  if (!session.localSourceSha256 || session.sourceVerifiedLocalSha256 !== session.localSourceSha256) {
    return {
      verdict: "UNPROVEN",
      reason: `Source is not bound to the current PRODUCT_SOURCE SHA-256. ${storedFlag}`,
    };
  }
  if (!isFinalizedSuccessful(session.deploy) || !isFinalizedSuccessful(session.create) || !isFinalizedSuccessful(session.cancel)) {
    return {
      verdict: "UNPROVEN",
      reason: `Phase A writes are incomplete. ${storedFlag}`,
    };
  }
  if (session.cancel.executionName !== "FINISHED_WITH_RETURN") {
    return {
      verdict: "UNPROVEN",
      reason: `Cancel execution is ${session.cancel.executionName ?? "unknown"}, expected FINISHED_WITH_RETURN. ${storedFlag}`,
    };
  }
  const rewardWei = sessionRewardWei(session);
  if (rewardWei == null) {
    return {
      verdict: "UNPROVEN",
      reason: `Create reward is not bound to the create transaction. ${storedFlag}`,
    };
  }
  const funder = session.boundFunder;
  const translator = session.boundTranslator ?? session.translator;
  if (!funder || !translator) {
    return {
      verdict: "UNPROVEN",
      reason: `Bound funder/translator missing. ${storedFlag}`,
    };
  }
  const created = createdTaskMatchesBound({
    task: session.createTask,
    funder,
    translator,
    rewardWei: rewardWei.toString(),
    clientNonce: session.clientNonce ?? "",
    expectedTaskId: session.expectedTaskId ?? "",
    submitByUnix: session.submitByUnix ?? 0,
    recoverAfterUnix: session.recoverAfterUnix ?? 0,
  });
  if (!created.ok) {
    return {
      verdict: "UNPROVEN",
      reason: `Create/get_task evidence does not match the bound session: ${created.reason} ${storedFlag}`,
    };
  }
  if (session.cancelTask?.state !== STATE_CANCELLED) {
    return {
      verdict: "UNPROVEN",
      reason: `Cancel contract state is ${session.cancelTask?.state ?? "unknown"}, expected cancelled. ${storedFlag}`,
    };
  }
  let actualFee: FinalizedFee;
  if (session.cancel.actualFeeAvailable && session.cancel.actualFeeWei) {
    try {
      actualFee = {
        available: true,
        feeWei: BigInt(session.cancel.actualFeeWei),
        source: session.cancel.actualFeeSource,
        reason: `Stored receipt fee ${session.cancel.actualFeeWei} wei.`,
      };
    } catch {
      actualFee = extractFinalizedFee(session.cancel.receipt);
    }
  } else {
    actualFee = extractFinalizedFee(session.cancel.receipt);
  }
  const evalResult = evaluateCancelRefund({
    parentSuccessful: Boolean(session.cancel.parentSuccessful),
    statusName: session.cancel.statusName,
    executionName: session.cancel.executionName,
    parentTxId: session.cancel.txId,
    rewardWei,
    funder,
    named: translator,
    transfer: session.transfer,
    before: session.beforeCancel,
    after: session.afterWait ?? session.afterParent,
    actualFee,
  });
  if (evalResult.verdict !== "YES") {
    return {
      verdict: "UNPROVEN",
      reason: `${evalResult.reason} payout_submitted=${String(session.cancelTask?.payout_submitted ?? session.createTask?.payout_submitted ?? false)}. ${storedFlag}`,
    };
  }
  return {
    verdict: "YES",
    reason:
      `Phase A deploy, source match bound to this address and PRODUCT_SOURCE SHA-256, create get_task match, cancel FINALIZED + FINISHED_WITH_RETURN, transfer delivery, and fee-adjusted funder delta are proven from live evidence. ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`,
  };
}

export function buildProductEvidencePayload(input: {
  funder?: string;
  chainId?: number;
  session: ProductSession;
}): string {
  const overall = overallProductVerdict(input.session);
  const fee = extractFinalizedFee(input.session.cancel.receipt);
  return jsonStringifySafe(
    {
      label: "LocaleBounty Live Product Test Phase A — public evidence",
      live_result: overall.verdict,
      live_result_note:
        overall.verdict === "YES"
          ? overall.reason
          : "UNPROVEN until a funded browser wallet completes this page. No invented receipts, fees, or payouts.",
      network: {
        name: "GenLayer Studio Devnet",
        chainIdExpected: 61997,
        chainIdWallet: input.chainId ?? null,
        rpc: "https://studio-dev.genlayer.com/api",
      },
      contract: {
        file: "contracts/localebounty.py",
        runner: "py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng",
        address: input.session.address ?? null,
        localSourceSha256: input.session.localSourceSha256 ?? null,
        deployedSourceSha256: input.session.deployedSourceSha256 ?? null,
        sourceMatch: input.session.sourceMatch,
        sourceVerifyStatus: input.session.sourceVerifyStatus,
        sourceVerifyReason: input.session.sourceVerifyReason,
      },
      funder: input.funder ?? null,
      boundFunder: input.session.boundFunder ?? null,
      translator: input.session.translator || null,
      boundTranslator: input.session.boundTranslator ?? null,
      rewardGenEntered: input.session.rewardGen || null,
      boundRewardWei: input.session.boundRewardWei ?? null,
      boundRewardGen: input.session.boundRewardGen ?? null,
      sourceVerifiedAddress: input.session.sourceVerifiedAddress ?? null,
      sourceVerifiedLocalSha256: input.session.sourceVerifiedLocalSha256 ?? null,
      clientNonce: input.session.clientNonce ?? null,
      expectedTaskId: input.session.expectedTaskId ?? null,
      submitByUnix: input.session.submitByUnix ?? null,
      recoverAfterUnix: input.session.recoverAfterUnix ?? null,
      historicalProbePayoutFeeNote:
        "Earlier experimental probe payout write actual fee was 0.000126304500000823 GEN (126304500000823 wei). That is not 0.126 GEN. The quote is a fee deposit required upfront; unused deposit is returned. Quotes on this page are fetched live.",
      deploy: publicAction(input.session.deploy),
      create: publicAction(input.session.create),
      cancel: publicAction(input.session.cancel),
      createTask: input.session.createTask ?? null,
      cancelTask: input.session.cancelTask ?? null,
      transfer: input.session.transfer ?? null,
      feeFigures: {
        createQuotedAttachedWei: input.session.create.quotedValueWei ?? null,
        createQuotedFeeWei: input.session.create.quotedFeeWei ?? null,
        cancelQuotedFeeWei: input.session.cancel.quotedFeeWei ?? null,
        cancelActualFeeWei: input.session.cancel.actualFeeWei ?? null,
        cancelActualFeeSource: input.session.cancel.actualFeeSource ?? null,
        cancelActualFeeAvailable: input.session.cancel.actualFeeAvailable ?? fee.available,
      },
      balances: {
        beforeCreate: input.session.beforeCreate ?? null,
        afterCreate: input.session.afterCreate ?? null,
        beforeCancel: input.session.beforeCancel ?? null,
        afterParent: input.session.afterParent ?? null,
        afterWait: input.session.afterWait ?? null,
      },
      transactionStatus: input.session.cancel.statusName ?? input.session.create.statusName ?? input.session.deploy.statusName ?? null,
      executionResult: input.session.cancel.executionName ?? input.session.create.executionName ?? input.session.deploy.executionName ?? null,
      contractState: input.session.cancelTask?.state ?? input.session.createTask?.state ?? null,
      payout_submitted: input.session.cancelTask?.payout_submitted ?? input.session.createTask?.payout_submitted ?? null,
      payoutSubmittedNote: PAYOUT_SUBMITTED_IS_NOT_PAYMENT,
      transferDelivery: input.session.transfer?.parseNote ?? null,
      balanceEvidence: input.session.paymentReason,
      paymentEvidence: input.session.paymentEvidence,
      overall,
      note: "No private keys. Wallet confirmation is not GenLayer success. Parent isSuccessful is not refund paid. Public screens at / use a different persist. /demo stays demo.",
    },
    2,
  );
}

function publicAction(action: ProductSession["deploy"]) {
  return {
    txId: action.txId ?? null,
    statusName: action.statusName ?? null,
    executionName: action.executionName ?? null,
    parentSuccessful: action.parentSuccessful ?? null,
    quotedValueWei: action.quotedValueWei ?? null,
    quotedFeeWei: action.quotedFeeWei ?? null,
    quotedBinding: action.quotedBinding ?? null,
    actualFeeWei: action.actualFeeWei ?? null,
    actualFeeSource: action.actualFeeSource ?? null,
    receipt: action.receipt ?? null,
    error: action.error ?? null,
    contractAddress: action.contractAddress ?? null,
  };
}

export { collectTransferEvidence, extractFinalizedFee };
