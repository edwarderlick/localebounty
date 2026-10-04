import { jsonSafe, jsonStringifySafe } from "../format";
import type { Verdict } from "../persist";
import type { EoaBalances } from "../rpc";
import { rememberGenvmLag, type CreateDeadlineClock } from "../product/clock";
import type { TransferEvidence } from "../product/transfers";
import { LANE_B_SUBMIT_LEAD_SECONDS, PRODUCT_V2_STORAGE_KEY, normalizeLaneBLeadSeconds, type ProductV2ActionName } from "./constants";
import type { ProductV2QuoteBinding } from "./quotes";
import type { ProductV2Task } from "./task";

export type { Verdict, ProductV2ActionName };

export type LaneBRecoveryKind = "none" | "unaccepted_cancel" | "unaccepted_expire";

export type ProductV2ActionRecord = {
  phase: "idle" | "quoting" | "quoted" | "signing" | "submitted" | "waiting" | "success" | "failed" | "rejected";
  quotedValueWei?: string;
  quotedFeeWei?: string;
  quotedDistribution?: unknown;
  quotedMessageAllocations?: unknown;
  quotedBinding?: ProductV2QuoteBinding;
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

export type ProductV2Session = {
  version: 1;
  translator: string;
  rewardGen: string;
  boundFunder?: string;
  boundTranslator?: string;
  localSourceSha256?: string;
  deployedSourceSha256?: string | null;
  sourceMatch: boolean;
  sourceVerifyStatus: "idle" | "match" | "mismatch" | "UNPROVEN";
  sourceVerifyReason: string;
  sourceVerifiedAddress?: string;
  sourceVerifiedLocalSha256?: string;
  address?: string;
  deploy: ProductV2ActionRecord;
  createA: ProductV2ActionRecord;
  cancelA: ProductV2ActionRecord;
  createB: ProductV2ActionRecord;
  cancelB: ProductV2ActionRecord;
  acceptB: ProductV2ActionRecord;
  expireB: ProductV2ActionRecord;
  nonceA?: string;
  taskIdA?: string;
  submitA?: number;
  recoverA?: number;
  boundRewardAWei?: string;
  nonceB?: string;
  taskIdB?: string;
  submitB?: number;
  recoverB?: number;
  boundRewardBWei?: string;
  laneBLeadSeconds: number;
  genvmLagSeconds?: number;
  createDeadlineClock?: CreateDeadlineClock;
  taskA?: ProductV2Task;
  taskB?: ProductV2Task;
  transferA?: TransferEvidence;
  transferB?: TransferEvidence;
  transferCancelB?: TransferEvidence;
  beforeCreateA?: EoaBalances;
  afterCreateA?: EoaBalances;
  beforeCancelA?: EoaBalances;
  afterCancelA?: EoaBalances;
  afterWaitA?: EoaBalances;
  waitSamplesA?: EoaBalances[];
  beforeCreateB?: EoaBalances;
  afterCreateB?: EoaBalances;
  beforeCancelB?: EoaBalances;
  afterCancelB?: EoaBalances;
  afterWaitCancelB?: EoaBalances;
  waitSamplesCancelB?: EoaBalances[];
  beforeAcceptB?: EoaBalances;
  afterAcceptB?: EoaBalances;
  beforeExpireB?: EoaBalances;
  afterExpireB?: EoaBalances;
  afterWaitB?: EoaBalances;
  waitSamplesB?: EoaBalances[];
  expireCaller?: string;
  beforeExpireCallerWei?: string;
  afterExpireCallerWei?: string;
  paymentA: Verdict;
  paymentAReason: string;
  paymentB: Verdict;
  paymentBReason: string;
  paymentBRecovery: Verdict;
  paymentBRecoveryReason: string;
  paymentBRecoveryKind: LaneBRecoveryKind;
};

function emptyAction(): ProductV2ActionRecord {
  return { phase: "idle" };
}

export function emptyProductV2Session(): ProductV2Session {
  return {
    version: 1,
    translator: "",
    rewardGen: "",
    sourceMatch: false,
    sourceVerifyStatus: "idle",
    sourceVerifyReason: "Source has not been checked against Studio-dev yet.",
    deploy: emptyAction(),
    createA: emptyAction(),
    cancelA: emptyAction(),
    createB: emptyAction(),
    cancelB: emptyAction(),
    acceptB: emptyAction(),
    expireB: emptyAction(),
    laneBLeadSeconds: LANE_B_SUBMIT_LEAD_SECONDS,
    paymentA: "UNPROVEN",
    paymentAReason:
      "Lane A stays UNPROVEN until a funded wallet deploys V2, creates an unaccepted task, and cancels it. Direct tests are not live YES.",
    paymentB: "UNPROVEN",
    paymentBReason:
      "Lane B YES stays UNPROVEN until the named translator accepts, accepted_at_unix is nonzero, and expire_unsubmitted_task refunds the stored funder after the exclusive deadline.",
    paymentBRecovery: "UNPROVEN",
    paymentBRecoveryReason:
      "Unaccepted recovery (funder cancel while open, or expire after the deadline with no accept) is labeled separately and is never Lane B YES.",
    paymentBRecoveryKind: "none",
  };
}

function durableAction(action: ProductV2ActionRecord): ProductV2ActionRecord {
  if (action.txId) return action;
  if (action.phase === "quoting" || action.phase === "signing" || action.phase === "submitted" || action.phase === "waiting") {
    return { ...action, phase: "idle" };
  }
  return action;
}

function deployIsTerminalFailure(action: ProductV2ActionRecord): boolean {
  if (!action.txId) return false;
  return action.statusName === "FINALIZED" && action.parentSuccessful === false;
}

function durableSession(session: ProductV2Session): ProductV2Session {
  const next: ProductV2Session = {
    ...session,
    deploy: durableAction(session.deploy),
    createA: durableAction(session.createA),
    cancelA: durableAction(session.cancelA),
    createB: durableAction(session.createB),
    cancelB: durableAction(session.cancelB),
    acceptB: durableAction(session.acceptB),
    expireB: durableAction(session.expireB),
    laneBLeadSeconds: normalizeLaneBLeadSeconds(session.laneBLeadSeconds),
  };
  if (deployIsTerminalFailure(next.deploy)) {
    next.address = undefined;
  }
  if (next.createA.txId && !next.boundRewardAWei) {
    next.boundRewardAWei = next.createA.quotedValueWei ?? next.taskA?.rewardWei;
  }
  if (next.createB.txId && !next.boundRewardBWei) {
    next.boundRewardBWei = next.createB.quotedValueWei ?? next.taskB?.rewardWei;
  }
  if (next.sourceMatch && (!next.sourceVerifiedAddress || !next.sourceVerifiedLocalSha256 || !next.address)) {
    next.sourceMatch = false;
    next.sourceVerifyStatus = "UNPROVEN";
    next.sourceVerifyReason =
      "Persisted source match is missing an address or localebounty_v2.py SHA-256 binding. Recheck gen_getContractCode before create.";
  }
  if (next.genvmLagSeconds != null && Number.isFinite(next.genvmLagSeconds)) {
    rememberGenvmLag(next.genvmLagSeconds);
  }
  return next;
}

export function resetProductV2TransientPhases(session: ProductV2Session): ProductV2Session {
  return durableSession(session);
}

function asAction(raw: unknown): ProductV2ActionRecord {
  if (!raw || typeof raw !== "object") return emptyAction();
  return { ...emptyAction(), ...(raw as ProductV2ActionRecord) };
}

function asTask(raw: unknown): ProductV2Task | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  return raw as ProductV2Task;
}

export function loadProductV2Session(): ProductV2Session {
  try {
    const raw = localStorage.getItem(PRODUCT_V2_STORAGE_KEY);
    if (!raw) return emptyProductV2Session();
    const parsed = JSON.parse(raw) as Partial<ProductV2Session>;
    if (parsed.version !== 1) return emptyProductV2Session();
    return durableSession({
      ...emptyProductV2Session(),
      translator: typeof parsed.translator === "string" ? parsed.translator : "",
      rewardGen: typeof parsed.rewardGen === "string" ? parsed.rewardGen : "",
      boundFunder: typeof parsed.boundFunder === "string" ? parsed.boundFunder : undefined,
      boundTranslator: typeof parsed.boundTranslator === "string" ? parsed.boundTranslator : undefined,
      localSourceSha256: typeof parsed.localSourceSha256 === "string" ? parsed.localSourceSha256 : undefined,
      deployedSourceSha256:
        typeof parsed.deployedSourceSha256 === "string"
          ? parsed.deployedSourceSha256
          : parsed.deployedSourceSha256 === null
            ? null
            : undefined,
      sourceMatch: Boolean(parsed.sourceMatch),
      sourceVerifyStatus: parsed.sourceVerifyStatus ?? "idle",
      sourceVerifyReason:
        typeof parsed.sourceVerifyReason === "string" ? parsed.sourceVerifyReason : emptyProductV2Session().sourceVerifyReason,
      sourceVerifiedAddress: typeof parsed.sourceVerifiedAddress === "string" ? parsed.sourceVerifiedAddress : undefined,
      sourceVerifiedLocalSha256:
        typeof parsed.sourceVerifiedLocalSha256 === "string" ? parsed.sourceVerifiedLocalSha256 : undefined,
      address: typeof parsed.address === "string" ? parsed.address : undefined,
      deploy: asAction(parsed.deploy),
      createA: asAction(parsed.createA),
      cancelA: asAction(parsed.cancelA),
      createB: asAction(parsed.createB),
      cancelB: asAction(parsed.cancelB),
      acceptB: asAction(parsed.acceptB),
      expireB: asAction(parsed.expireB),
      nonceA: typeof parsed.nonceA === "string" ? parsed.nonceA : undefined,
      taskIdA: typeof parsed.taskIdA === "string" ? parsed.taskIdA : undefined,
      submitA: typeof parsed.submitA === "number" ? parsed.submitA : undefined,
      recoverA: typeof parsed.recoverA === "number" ? parsed.recoverA : undefined,
      boundRewardAWei: typeof parsed.boundRewardAWei === "string" ? parsed.boundRewardAWei : undefined,
      nonceB: typeof parsed.nonceB === "string" ? parsed.nonceB : undefined,
      taskIdB: typeof parsed.taskIdB === "string" ? parsed.taskIdB : undefined,
      submitB: typeof parsed.submitB === "number" ? parsed.submitB : undefined,
      recoverB: typeof parsed.recoverB === "number" ? parsed.recoverB : undefined,
      boundRewardBWei: typeof parsed.boundRewardBWei === "string" ? parsed.boundRewardBWei : undefined,
      laneBLeadSeconds: normalizeLaneBLeadSeconds(parsed.laneBLeadSeconds),
      genvmLagSeconds:
        typeof parsed.genvmLagSeconds === "number" && Number.isFinite(parsed.genvmLagSeconds)
          ? parsed.genvmLagSeconds
          : undefined,
      createDeadlineClock:
        parsed.createDeadlineClock === "utc" || parsed.createDeadlineClock === "genvm" ? parsed.createDeadlineClock : undefined,
      taskA: asTask(parsed.taskA),
      taskB: asTask(parsed.taskB),
      transferA: parsed.transferA,
      transferB: parsed.transferB,
      transferCancelB: parsed.transferCancelB,
      beforeCreateA: parsed.beforeCreateA,
      afterCreateA: parsed.afterCreateA,
      beforeCancelA: parsed.beforeCancelA,
      afterCancelA: parsed.afterCancelA,
      afterWaitA: parsed.afterWaitA,
      waitSamplesA: parsed.waitSamplesA,
      beforeCreateB: parsed.beforeCreateB,
      afterCreateB: parsed.afterCreateB,
      beforeCancelB: parsed.beforeCancelB,
      afterCancelB: parsed.afterCancelB,
      afterWaitCancelB: parsed.afterWaitCancelB,
      waitSamplesCancelB: parsed.waitSamplesCancelB,
      beforeAcceptB: parsed.beforeAcceptB,
      afterAcceptB: parsed.afterAcceptB,
      beforeExpireB: parsed.beforeExpireB,
      afterExpireB: parsed.afterExpireB,
      afterWaitB: parsed.afterWaitB,
      waitSamplesB: parsed.waitSamplesB,
      expireCaller: typeof parsed.expireCaller === "string" ? parsed.expireCaller : undefined,
      beforeExpireCallerWei: typeof parsed.beforeExpireCallerWei === "string" ? parsed.beforeExpireCallerWei : undefined,
      afterExpireCallerWei: typeof parsed.afterExpireCallerWei === "string" ? parsed.afterExpireCallerWei : undefined,
      paymentA: parsed.paymentA === "YES" || parsed.paymentA === "NO" ? parsed.paymentA : "UNPROVEN",
      paymentAReason: typeof parsed.paymentAReason === "string" ? parsed.paymentAReason : emptyProductV2Session().paymentAReason,
      paymentB: parsed.paymentB === "YES" || parsed.paymentB === "NO" ? parsed.paymentB : "UNPROVEN",
      paymentBReason: typeof parsed.paymentBReason === "string" ? parsed.paymentBReason : emptyProductV2Session().paymentBReason,
      paymentBRecovery:
        parsed.paymentBRecovery === "YES" || parsed.paymentBRecovery === "NO" ? parsed.paymentBRecovery : "UNPROVEN",
      paymentBRecoveryReason:
        typeof parsed.paymentBRecoveryReason === "string"
          ? parsed.paymentBRecoveryReason
          : emptyProductV2Session().paymentBRecoveryReason,
      paymentBRecoveryKind:
        parsed.paymentBRecoveryKind === "unaccepted_cancel" || parsed.paymentBRecoveryKind === "unaccepted_expire"
          ? parsed.paymentBRecoveryKind
          : "none",
    });
  } catch {
    return emptyProductV2Session();
  }
}

function omitTypedQuoteBlobs(action: ProductV2ActionRecord): ProductV2ActionRecord {
  return {
    ...action,
    quotedDistribution: undefined,
    quotedMessageAllocations: undefined,
  };
}

export function saveProductV2Session(session: ProductV2Session): void {
  const display: ProductV2Session = durableSession({
    ...session,
    deploy: omitTypedQuoteBlobs(session.deploy),
    createA: omitTypedQuoteBlobs(session.createA),
    cancelA: omitTypedQuoteBlobs(session.cancelA),
    createB: omitTypedQuoteBlobs(session.createB),
    cancelB: omitTypedQuoteBlobs(session.cancelB),
    acceptB: omitTypedQuoteBlobs(session.acceptB),
    expireB: omitTypedQuoteBlobs(session.expireB),
  });
  try {
    localStorage.setItem(PRODUCT_V2_STORAGE_KEY, jsonStringifySafe(jsonSafe(display)));
  } catch {
    try {
      localStorage.setItem(
        PRODUCT_V2_STORAGE_KEY,
        jsonStringifySafe(
          jsonSafe({
            version: 1,
            translator: session.translator,
            rewardGen: session.rewardGen,
            boundFunder: session.boundFunder,
            boundTranslator: session.boundTranslator,
            address: session.address,
            deploy: { phase: session.deploy.phase, txId: session.deploy.txId, statusName: session.deploy.statusName, executionName: session.deploy.executionName, parentSuccessful: session.deploy.parentSuccessful },
            createA: { phase: session.createA.phase, txId: session.createA.txId, statusName: session.createA.statusName, executionName: session.createA.executionName, parentSuccessful: session.createA.parentSuccessful },
            cancelA: { phase: session.cancelA.phase, txId: session.cancelA.txId, statusName: session.cancelA.statusName, executionName: session.cancelA.executionName, parentSuccessful: session.cancelA.parentSuccessful },
            createB: { phase: session.createB.phase, txId: session.createB.txId, statusName: session.createB.statusName, executionName: session.createB.executionName, parentSuccessful: session.createB.parentSuccessful },
            cancelB: { phase: session.cancelB.phase, txId: session.cancelB.txId, statusName: session.cancelB.statusName, executionName: session.cancelB.executionName, parentSuccessful: session.cancelB.parentSuccessful },
            acceptB: { phase: session.acceptB.phase, txId: session.acceptB.txId, statusName: session.acceptB.statusName, executionName: session.acceptB.executionName, parentSuccessful: session.acceptB.parentSuccessful },
            expireB: { phase: session.expireB.phase, txId: session.expireB.txId, statusName: session.expireB.statusName, executionName: session.expireB.executionName, parentSuccessful: session.expireB.parentSuccessful },
            nonceA: session.nonceA,
            taskIdA: session.taskIdA,
            nonceB: session.nonceB,
            taskIdB: session.taskIdB,
            paymentA: session.paymentA,
            paymentAReason: session.paymentAReason,
            paymentB: session.paymentB,
            paymentBReason: session.paymentBReason,
            paymentBRecovery: session.paymentBRecovery,
            paymentBRecoveryReason: session.paymentBRecoveryReason,
            paymentBRecoveryKind: session.paymentBRecoveryKind,
            laneBLeadSeconds: session.laneBLeadSeconds,
            sourceMatch: session.sourceMatch,
            sourceVerifyStatus: session.sourceVerifyStatus,
            sourceVerifyReason: session.sourceVerifyReason,
            sourceVerifiedAddress: session.sourceVerifiedAddress,
            sourceVerifiedLocalSha256: session.sourceVerifiedLocalSha256,
            boundRewardAWei: session.boundRewardAWei,
            boundRewardBWei: session.boundRewardBWei,
            expireCaller: session.expireCaller,
          }),
        ),
      );
    } catch {
      // Never throw out of persist.
    }
  }
}

export function clearProductV2Session(): ProductV2Session {
  const next = emptyProductV2Session();
  saveProductV2Session(next);
  return next;
}

export function invalidateQuotedV2Action(action: ProductV2ActionRecord): ProductV2ActionRecord {
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

export function invalidateV2UnsignedQuotes(session: ProductV2Session): ProductV2Session {
  return {
    ...session,
    deploy: invalidateQuotedV2Action(session.deploy),
    createA: invalidateQuotedV2Action(session.createA),
    cancelA: invalidateQuotedV2Action(session.cancelA),
    createB: invalidateQuotedV2Action(session.createB),
    cancelB: invalidateQuotedV2Action(session.cancelB),
    acceptB: invalidateQuotedV2Action(session.acceptB),
    expireB: invalidateQuotedV2Action(session.expireB),
  };
}

export function bindV2Session(session: ProductV2Session, funder: string, translator: string): ProductV2Session {
  return {
    ...session,
    boundFunder: session.boundFunder ?? funder,
    boundTranslator: session.boundTranslator ?? translator,
  };
}

export function actionOf(session: ProductV2Session, name: ProductV2ActionName): ProductV2ActionRecord {
  return session[name];
}

export function withV2Action(
  session: ProductV2Session,
  name: ProductV2ActionName,
  patch: Partial<ProductV2ActionRecord>,
): ProductV2Session {
  return { ...session, [name]: { ...session[name], ...patch } };
}
