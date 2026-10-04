import { extractFinalizedFee, type FinalizedFee } from "../fees";
import { addressesEqual, jsonStringifySafe } from "../format";
import { PAYOUT_SUBMITTED_IS_NOT_PAYMENT, evaluateCancelRefund, parentSuccessIsNotPayment } from "../product/evidence";
import { matchingChildCredit, matchingOutgoingTo, type TransferEvidence } from "../product/transfers";
import { STATE_ACCEPTED, STATE_CANCELLED, STATE_EXPIRED, V2_RUNNER, V2_SOURCE_FILE } from "./constants";
import { isFinalizedWithReturn, laneRewardWei } from "./guards";
import type { LaneBRecoveryKind, ProductV2ActionRecord, ProductV2Session, Verdict } from "./persist";

export { PAYOUT_SUBMITTED_IS_NOT_PAYMENT };

function delta(after: string | null | undefined, before: string | null | undefined): bigint | null {
  if (after == null || before == null) return null;
  try {
    return BigInt(after) - BigInt(before);
  } catch {
    return null;
  }
}

export function feeFromAction(action: ProductV2ActionRecord): FinalizedFee {
  if (action.actualFeeAvailable && action.actualFeeWei) {
    return {
      available: true,
      feeWei: BigInt(action.actualFeeWei),
      source: action.actualFeeSource,
      reason: `Stored receipt fee ${action.actualFeeWei} wei (${action.actualFeeSource ?? "receipt"}).`,
    };
  }
  return extractFinalizedFee(action.receipt);
}

export type ExpirePaymentEval = {
  verdict: Verdict;
  reason: string;
  transferLabel: string;
  balanceLabel: string;
  funderDeltaWei: string | null;
  namedGainWei: string | null;
  callerDeltaWei: string | null;
};

export function evaluateExpireRefund(input: {
  parentSuccessful: boolean;
  statusName?: string;
  executionName?: string;
  parentTxId?: string;
  rewardWei: bigint;
  funder: string;
  translator: string;
  caller: string;
  transfer: TransferEvidence | undefined;
  beforeFunderWei?: string;
  afterFunderWei?: string;
  beforeNamedWei?: string;
  afterNamedWei?: string;
  beforeCallerWei?: string;
  afterCallerWei?: string;
  actualFee: FinalizedFee;
}): ExpirePaymentEval {
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
    ? `Outgoing EthSend to stored funder ${input.funder} value ${input.rewardWei.toString()} wei; child value_credited true, recipient ${child?.to}, triggered_by ${child?.triggeredBy}${child?.txId ? ` (${child.txId})` : ""}. Caller ${input.caller} paid the write fee, not the escrow.`
    : `UNPROVEN. Child credit requires value_credited=true, exact stored-funder recipient, exact reward, and triggered_by equal to the expire parent. ${transfer.parseNote} ${parentNote}`;

  const funderDelta = delta(input.afterFunderWei, input.beforeFunderWei);
  const namedGain = delta(input.afterNamedWei, input.beforeNamedWei);
  const callerDelta = delta(input.afterCallerWei, input.beforeCallerWei);
  let balanceLabel = "UNPROVEN. Missing before/after Studio-dev EOA balances.";
  if (funderDelta != null && namedGain != null) {
    balanceLabel = `Funder delta ${funderDelta.toString()} wei; translator delta ${namedGain.toString()} wei; caller delta ${callerDelta?.toString() ?? "missing"} wei.`;
  }

  const empty: ExpirePaymentEval = {
    verdict: "UNPROVEN",
    reason: "",
    transferLabel,
    balanceLabel,
    funderDeltaWei: funderDelta?.toString() ?? null,
    namedGainWei: namedGain?.toString() ?? null,
    callerDeltaWei: callerDelta?.toString() ?? null,
  };

  if (!input.parentSuccessful || input.statusName !== "FINALIZED") {
    return { ...empty, reason: `Expire parent is not FINALIZED + isSuccessful. ${parentNote}` };
  }
  if (input.executionName !== "FINISHED_WITH_RETURN") {
    return { ...empty, reason: `Expire execution is ${input.executionName ?? "unknown"}, expected FINISHED_WITH_RETURN. ${parentNote}` };
  }
  if (!transferOk) {
    return {
      ...empty,
      reason: `Expire parent succeeded. ${parentNote} Outgoing EthSend to the stored funder for the exact reward and child value_credited are required. payout_submitted is not paid.`,
    };
  }
  if (funderDelta == null || namedGain == null || callerDelta == null || !input.actualFee.available || input.actualFee.feeWei == null) {
    return {
      ...empty,
      reason: `Transfer fields were parsed, but fee-adjusted balances are still UNPROVEN. ${input.actualFee.reason} ${parentNote}`,
    };
  }

  const fee = input.actualFee.feeWei;
  const callerIsFunder = addressesEqual(input.caller, input.funder);
  const callerIsTranslator = addressesEqual(input.caller, input.translator);

  if (callerIsFunder) {
    if (namedGain !== 0n) {
      return { ...empty, reason: `Named translator delta is ${namedGain.toString()} wei; expire refund must not credit the translator.` };
    }
    const expected = input.rewardWei - fee;
    if (funderDelta === expected) {
      return {
        verdict: "YES",
        reason: `Expire refund delivered to the stored funder (who also paid the write fee): funder delta ${funderDelta.toString()} wei equals reward ${input.rewardWei.toString()} minus receipt fee ${fee.toString()} wei. Translator delta 0. Outgoing EthSend and child value_credited matched. payout_submitted is not paid.`,
        transferLabel,
        balanceLabel: `${balanceLabel} Matches reward minus receipt fee.`,
        funderDeltaWei: funderDelta.toString(),
        namedGainWei: namedGain.toString(),
        callerDeltaWei: callerDelta.toString(),
      };
    }
    return {
      ...empty,
      reason: `Funder/caller delta ${funderDelta.toString()} wei does not equal reward minus receipt fee ${expected.toString()}. ${parentNote}`,
    };
  }

  if (funderDelta !== input.rewardWei) {
    return {
      ...empty,
      reason: `Third-party expire: funder delta ${funderDelta.toString()} wei must equal the exact reward ${input.rewardWei.toString()} wei (caller pays the write fee). ${parentNote}`,
    };
  }
  if (callerDelta !== -fee) {
    return {
      ...empty,
      reason: `Caller ${input.caller} delta ${callerDelta.toString()} wei must equal minus the expire receipt fee ${fee.toString()} wei. Refund still goes to the stored funder.`,
    };
  }
  if (callerIsTranslator) {
    if (namedGain !== -fee) {
      return {
        ...empty,
        reason: `Translator was the expire caller, so translator delta must equal minus the write fee (${fee.toString()} wei), not a reward credit.`,
      };
    }
  } else if (namedGain !== 0n) {
    return { ...empty, reason: `Named translator delta is ${namedGain.toString()} wei; expire refund must not credit the translator.` };
  }
  return {
    verdict: "YES",
    reason: `Expire refund delivered to stored funder ${input.funder} for exact reward ${input.rewardWei.toString()} wei. Caller ${input.caller} paid receipt fee ${fee.toString()} wei. Translator settlement is not the escrow. Outgoing EthSend and child value_credited matched. payout_submitted is not paid.`,
    transferLabel,
    balanceLabel: `${balanceLabel} Funder received exact reward; caller paid the write fee.`,
    funderDeltaWei: funderDelta.toString(),
    namedGainWei: namedGain.toString(),
    callerDeltaWei: callerDelta.toString(),
  };
}

export function overallLaneAVerdict(session: ProductV2Session): { verdict: Verdict; reason: string } {
  const flag = `UNPROVEN. Stored paymentA is not proof. ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`;
  if (!session.sourceMatch || !session.address || !session.sourceVerifiedAddress || !addressesEqual(session.address, session.sourceVerifiedAddress)) {
    return { verdict: "UNPROVEN", reason: `V2 source is not bound to this deployed address. ${flag}` };
  }
  if (!session.localSourceSha256 || session.sourceVerifiedLocalSha256 !== session.localSourceSha256) {
    return { verdict: "UNPROVEN", reason: `V2 source is not bound to the current localebounty_v2.py SHA-256. ${flag}` };
  }
  if (!isFinalizedWithReturn(session.deploy) || !isFinalizedWithReturn(session.createA) || !isFinalizedWithReturn(session.cancelA)) {
    return { verdict: "UNPROVEN", reason: `Lane A writes are incomplete (need FINALIZED + FINISHED_WITH_RETURN). ${flag}` };
  }
  if (session.taskA?.state !== STATE_CANCELLED) {
    return { verdict: "UNPROVEN", reason: `get_task state is ${session.taskA?.state ?? "missing"}, expected cancelled. ${flag}` };
  }
  const reward = laneRewardWei(session, "A");
  if (reward == null) return { verdict: "UNPROVEN", reason: `Bound reward missing. ${flag}` };
  const funder = session.boundFunder ?? session.taskA.funder;
  const evalResult = evaluateCancelRefund({
    parentSuccessful: Boolean(session.cancelA.parentSuccessful),
    statusName: session.cancelA.statusName,
    executionName: session.cancelA.executionName,
    parentTxId: session.cancelA.txId,
    rewardWei: reward,
    funder,
    named: session.boundTranslator ?? session.translator,
    transfer: session.transferA,
    before: session.beforeCancelA,
    after: session.afterWaitA ?? session.afterCancelA,
    actualFee: feeFromAction(session.cancelA),
  });
  if (evalResult.verdict !== "YES") {
    return { verdict: "UNPROVEN", reason: `${evalResult.reason} payout_submitted=${String(session.taskA.payout_submitted)}. ${flag}` };
  }
  return {
    verdict: "YES",
    reason: `Lane A: V2 source match, unaccepted create, funder cancel FINALIZED + FINISHED_WITH_RETURN, exact EthSend, child credit, fee-adjusted funder delta. ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`,
  };
}

export function overallLaneBVerdict(session: ProductV2Session): { verdict: Verdict; reason: string } {
  const flag = `UNPROVEN. Stored paymentB is not proof. ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`;
  if (!session.sourceMatch || !session.address || !session.sourceVerifiedAddress || !addressesEqual(session.address, session.sourceVerifiedAddress)) {
    return { verdict: "UNPROVEN", reason: `V2 source is not bound to this deployed address. ${flag}` };
  }
  if (!isFinalizedWithReturn(session.deploy) || !isFinalizedWithReturn(session.createB) || !isFinalizedWithReturn(session.acceptB)) {
    return { verdict: "UNPROVEN", reason: `Lane B create/accept are incomplete. ${flag}` };
  }
  if (session.taskB?.state !== STATE_ACCEPTED && session.taskB?.state !== STATE_EXPIRED) {
    return { verdict: "UNPROVEN", reason: `get_task state is ${session.taskB?.state ?? "missing"} after accept. ${flag}` };
  }
  if ((session.taskB.accepted_at_unix ?? 0) <= 0) {
    return { verdict: "UNPROVEN", reason: `accepted_at_unix is missing after accept_task. ${flag}` };
  }
  if (!isFinalizedWithReturn(session.expireB) || session.taskB.state !== STATE_EXPIRED) {
    return { verdict: "UNPROVEN", reason: `expire_unsubmitted_task is not FINALIZED + FINISHED_WITH_RETURN with state expired. ${flag}` };
  }
  const reward = laneRewardWei(session, "B");
  if (reward == null) return { verdict: "UNPROVEN", reason: `Bound reward missing. ${flag}` };
  const evalResult = evaluateExpireRefund({
    parentSuccessful: Boolean(session.expireB.parentSuccessful),
    statusName: session.expireB.statusName,
    executionName: session.expireB.executionName,
    parentTxId: session.expireB.txId,
    rewardWei: reward,
    funder: session.boundFunder ?? session.taskB.funder,
    translator: session.boundTranslator ?? session.translator,
    caller: session.expireCaller ?? "",
    transfer: session.transferB,
    beforeFunderWei: session.beforeExpireB?.funderWei,
    afterFunderWei: (session.afterWaitB ?? session.afterExpireB)?.funderWei,
    beforeNamedWei: session.beforeExpireB?.namedWei,
    afterNamedWei: (session.afterWaitB ?? session.afterExpireB)?.namedWei,
    beforeCallerWei: session.beforeExpireCallerWei,
    afterCallerWei: session.afterExpireCallerWei,
    actualFee: feeFromAction(session.expireB),
  });
  if (evalResult.verdict !== "YES") {
    return { verdict: "UNPROVEN", reason: `${evalResult.reason} ${flag}` };
  }
  return {
    verdict: "YES",
    reason: `Lane B: accept FINALIZED + accepted_at_unix, funder cancel unavailable, expire after exclusive deadline refunded the stored funder. ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`,
  };
}

export function laneBRecoveryVerdict(session: ProductV2Session): {
  verdict: Verdict;
  reason: string;
  kind: LaneBRecoveryKind;
} {
  const flag = `UNPROVEN. Unaccepted recovery is never Lane B YES. Stored paymentBRecovery is not proof. ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`;
  const acceptedIntended = isFinalizedWithReturn(session.acceptB) && (session.taskB?.accepted_at_unix ?? 0) > 0;
  if (acceptedIntended) {
    return {
      verdict: "UNPROVEN",
      kind: "none",
      reason: `Lane B acceptance succeeded (FINALIZED + accepted_at_unix). Recovery labels stay unused. Intended Lane B proof is overallLaneBVerdict. ${flag}`,
    };
  }
  if (!session.sourceMatch || !session.address || !session.sourceVerifiedAddress || !addressesEqual(session.address, session.sourceVerifiedAddress)) {
    return { verdict: "UNPROVEN", kind: "none", reason: `V2 source is not bound to this deployed address. ${flag}` };
  }
  if (!isFinalizedWithReturn(session.deploy) || !isFinalizedWithReturn(session.createB)) {
    return { verdict: "UNPROVEN", kind: "none", reason: `Lane B create is incomplete. ${flag}` };
  }
  const reward = laneRewardWei(session, "B");
  if (reward == null) return { verdict: "UNPROVEN", kind: "none", reason: `Bound reward missing. ${flag}` };
  const funder = session.boundFunder ?? session.taskB?.funder ?? "";
  const named = session.boundTranslator ?? session.translator;

  if (isFinalizedWithReturn(session.cancelB)) {
    if (session.taskB?.state !== STATE_CANCELLED) {
      return {
        verdict: "UNPROVEN",
        kind: "unaccepted_cancel",
        reason: `get_task state is ${session.taskB?.state ?? "missing"}, expected cancelled. ${flag}`,
      };
    }
    if ((session.taskB.accepted_at_unix ?? 0) > 0) {
      return {
        verdict: "UNPROVEN",
        kind: "unaccepted_cancel",
        reason: `accepted_at_unix is ${session.taskB.accepted_at_unix}; unaccepted cancel recovery requires 0. ${flag}`,
      };
    }
    const evalResult = evaluateCancelRefund({
      parentSuccessful: Boolean(session.cancelB.parentSuccessful),
      statusName: session.cancelB.statusName,
      executionName: session.cancelB.executionName,
      parentTxId: session.cancelB.txId,
      rewardWei: reward,
      funder,
      named,
      transfer: session.transferCancelB,
      before: session.beforeCancelB,
      after: session.afterWaitCancelB ?? session.afterCancelB,
      actualFee: feeFromAction(session.cancelB),
    });
    if (evalResult.verdict !== "YES") {
      return {
        verdict: "UNPROVEN",
        kind: "unaccepted_cancel",
        reason: `${evalResult.reason} This is unaccepted cancel recovery, never Lane B YES. ${flag}`,
      };
    }
    return {
      verdict: "YES",
      kind: "unaccepted_cancel",
      reason: `Unaccepted cancel recovery: OPEN unaccepted funder cancel FINALIZED + FINISHED_WITH_RETURN, exact EthSend, child credit, fee-adjusted funder delta. This is not Lane B YES. ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`,
    };
  }

  if (isFinalizedWithReturn(session.expireB)) {
    if (session.taskB?.state !== STATE_EXPIRED) {
      return {
        verdict: "UNPROVEN",
        kind: "unaccepted_expire",
        reason: `get_task state is ${session.taskB?.state ?? "missing"}, expected expired. ${flag}`,
      };
    }
    if ((session.taskB.accepted_at_unix ?? 0) > 0) {
      return {
        verdict: "UNPROVEN",
        kind: "none",
        reason: `accepted_at_unix is set without a finalized accept record. Intended Lane B YES stays UNPROVEN; this is not labeled unaccepted recovery. ${flag}`,
      };
    }
    const evalResult = evaluateExpireRefund({
      parentSuccessful: Boolean(session.expireB.parentSuccessful),
      statusName: session.expireB.statusName,
      executionName: session.expireB.executionName,
      parentTxId: session.expireB.txId,
      rewardWei: reward,
      funder,
      translator: named,
      caller: session.expireCaller ?? "",
      transfer: session.transferB,
      beforeFunderWei: session.beforeExpireB?.funderWei,
      afterFunderWei: (session.afterWaitB ?? session.afterExpireB)?.funderWei,
      beforeNamedWei: session.beforeExpireB?.namedWei,
      afterNamedWei: (session.afterWaitB ?? session.afterExpireB)?.namedWei,
      beforeCallerWei: session.beforeExpireCallerWei,
      afterCallerWei: session.afterExpireCallerWei,
      actualFee: feeFromAction(session.expireB),
    });
    if (evalResult.verdict !== "YES") {
      return {
        verdict: "UNPROVEN",
        kind: "unaccepted_expire",
        reason: `${evalResult.reason} This is unaccepted expire recovery, never Lane B YES. ${flag}`,
      };
    }
    return {
      verdict: "YES",
      kind: "unaccepted_expire",
      reason: `Unaccepted expire recovery: OPEN unsubmitted expire after the exclusive deadline refunded the stored funder. This is not Lane B YES. ${PAYOUT_SUBMITTED_IS_NOT_PAYMENT}`,
    };
  }

  return {
    verdict: "UNPROVEN",
    kind: "none",
    reason: `No unaccepted recovery write is FINALIZED with FINISHED_WITH_RETURN yet. ${flag}`,
  };
}

function publicAction(action: ProductV2ActionRecord) {
  return {
    phase: action.phase,
    txId: action.txId ?? null,
    statusName: action.statusName ?? null,
    executionName: action.executionName ?? null,
    parentSuccessful: action.parentSuccessful ?? null,
    quotedFeeWei: action.quotedFeeWei ?? null,
    quotedValueWei: action.quotedValueWei ?? null,
    actualFeeWei: action.actualFeeWei ?? null,
    actualFeeSource: action.actualFeeSource ?? null,
    error: action.error ?? null,
  };
}

export function buildLaneAEvidencePayload(input: { wallet?: string; chainId?: number; session: ProductV2Session }): string {
  const overall = overallLaneAVerdict(input.session);
  return jsonStringifySafe({
    label: "LocaleBounty Live Product V2 Phase C2 — Lane A (create unaccepted, funder cancel)",
    live_result: overall.verdict,
    live_result_note:
      overall.verdict === "YES"
        ? overall.reason
        : "UNPROVEN until a funded browser wallet completes this lane. No invented receipts, fees, or payouts.",
    network: {
      name: "GenLayer Studio Devnet",
      chainIdExpected: 61997,
      chainIdWallet: input.chainId ?? null,
      rpc: "https://studio-dev.genlayer.com/api",
    },
    contract: {
      file: V2_SOURCE_FILE,
      runner: V2_RUNNER,
      address: input.session.address ?? null,
      localSourceSha256: input.session.localSourceSha256 ?? null,
      deployedSourceSha256: input.session.deployedSourceSha256 ?? null,
      sourceMatch: input.session.sourceMatch,
      sourceVerifyStatus: input.session.sourceVerifyStatus,
      sourceVerifyReason: input.session.sourceVerifyReason,
    },
    boundFunder: input.session.boundFunder ?? null,
    boundTranslator: input.session.boundTranslator ?? null,
    boundRewardWei: input.session.boundRewardAWei ?? null,
    clientNonce: input.session.nonceA ?? null,
    expectedTaskId: input.session.taskIdA ?? null,
    submitByUnix: input.session.submitA ?? null,
    recoverAfterUnix: input.session.recoverA ?? null,
    deploy: publicAction(input.session.deploy),
    create: publicAction(input.session.createA),
    cancel: publicAction(input.session.cancelA),
    get_task: input.session.taskA ?? null,
    transfer: input.session.transferA ?? null,
    beforeCancel: input.session.beforeCancelA ?? null,
    afterCancel: input.session.afterWaitA ?? input.session.afterCancelA ?? null,
    paymentEvidence: overall.verdict,
    paymentReason: overall.reason,
    payout_submitted_is_not_paid: PAYOUT_SUBMITTED_IS_NOT_PAYMENT,
  });
}

export function buildLaneBEvidencePayload(input: { wallet?: string; chainId?: number; session: ProductV2Session }): string {
  const overall = overallLaneBVerdict(input.session);
  const recovery = laneBRecoveryVerdict(input.session);
  return jsonStringifySafe({
    label: "LocaleBounty Live Product V2 Phase C2 — Lane B (accept, no submit, expire)",
    live_result: overall.verdict,
    live_result_note:
      overall.verdict === "YES"
        ? overall.reason
        : "Lane B YES stays UNPROVEN until a finalized successful accept, nonzero accepted_at_unix, and a later successful expiry with exact refund delivery. Unaccepted cancel or unaccepted expire is labeled recovery and is never Lane B YES. No invented receipts.",
    network: {
      name: "GenLayer Studio Devnet",
      chainIdExpected: 61997,
      chainIdWallet: input.chainId ?? null,
      rpc: "https://studio-dev.genlayer.com/api",
    },
    contract: {
      file: V2_SOURCE_FILE,
      runner: V2_RUNNER,
      address: input.session.address ?? null,
      localSourceSha256: input.session.localSourceSha256 ?? null,
      deployedSourceSha256: input.session.deployedSourceSha256 ?? null,
      sourceMatch: input.session.sourceMatch,
    },
    boundFunder: input.session.boundFunder ?? null,
    boundTranslator: input.session.boundTranslator ?? null,
    expireCaller: input.session.expireCaller ?? null,
    boundRewardWei: input.session.boundRewardBWei ?? null,
    clientNonce: input.session.nonceB ?? null,
    expectedTaskId: input.session.taskIdB ?? null,
    submitByUnix: input.session.submitB ?? null,
    recoverAfterUnix: input.session.recoverB ?? null,
    laneBLeadSeconds: input.session.laneBLeadSeconds,
    accepted_at_unix: input.session.taskB?.accepted_at_unix ?? null,
    funder_cancel_after_accept: "unavailable",
    deploy: publicAction(input.session.deploy),
    create: publicAction(input.session.createB),
    cancel: publicAction(input.session.cancelB),
    accept: publicAction(input.session.acceptB),
    expire: publicAction(input.session.expireB),
    get_task: input.session.taskB ?? null,
    transfer: input.session.transferB ?? null,
    transferCancel: input.session.transferCancelB ?? null,
    beforeExpire: input.session.beforeExpireB ?? null,
    afterExpire: input.session.afterWaitB ?? input.session.afterExpireB ?? null,
    beforeExpireCallerWei: input.session.beforeExpireCallerWei ?? null,
    afterExpireCallerWei: input.session.afterExpireCallerWei ?? null,
    beforeCancel: input.session.beforeCancelB ?? null,
    afterCancel: input.session.afterWaitCancelB ?? input.session.afterCancelB ?? null,
    paymentEvidence: overall.verdict,
    paymentReason: overall.reason,
    recoveryKind: recovery.kind,
    recoveryEvidence: recovery.verdict,
    recoveryReason: recovery.reason,
    payout_submitted_is_not_paid: PAYOUT_SUBMITTED_IS_NOT_PAYMENT,
  });
}
