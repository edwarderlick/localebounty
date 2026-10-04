import { jsonSafe, jsonStringifySafe } from "../format";
import type { ActionRecord, Verdict } from "../persist";
import type { EoaBalances } from "../rpc";
import { rememberGenvmLag, type CreateDeadlineClock } from "./clock";
import { PRODUCT_STORAGE_KEY, type ProductActionName } from "./constants";
import type { ProductQuoteBinding } from "./quotes";
import type { ProductTask } from "./task";
import type { TransferEvidence } from "./transfers";

export type { ActionRecord, Verdict, ProductActionName };

export type ProductActionRecord = Omit<ActionRecord, "quotedBinding"> & {
  quotedBinding?: ProductQuoteBinding;
};

export type ProductSession = {
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
  boundRewardWei?: string;
  boundRewardGen?: string;
  address?: string;
  deploy: ProductActionRecord;
  create: ProductActionRecord;
  cancel: ProductActionRecord;
  clientNonce?: string;
  expectedTaskId?: string;
  submitByUnix?: number;
  recoverAfterUnix?: number;
  /** wallUnix - GetTimestamp. Search aid for create deadlines; not payment evidence. */
  genvmLagSeconds?: number;
  /** utc = signed deadlines follow the envelope clock; fee sim still uses GetTimestamp. */
  createDeadlineClock?: CreateDeadlineClock;
  createTask?: ProductTask;
  cancelTask?: ProductTask;
  transfer?: TransferEvidence;
  beforeCreate?: EoaBalances;
  afterCreate?: EoaBalances;
  beforeCancel?: EoaBalances;
  afterParent?: EoaBalances;
  afterWait?: EoaBalances;
  waitSamples?: EoaBalances[];
  paymentEvidence: Verdict;
  paymentReason: string;
};

function emptyAction(): ProductActionRecord {
  return { phase: "idle" };
}

export function emptyProductSession(): ProductSession {
  return {
    version: 1,
    translator: "",
    rewardGen: "",
    sourceMatch: false,
    sourceVerifyStatus: "idle",
    sourceVerifyReason: "Source has not been checked against Studio-dev yet.",
    deploy: emptyAction(),
    create: emptyAction(),
    cancel: emptyAction(),
    paymentEvidence: "UNPROVEN",
    paymentReason: "No Studio-dev product write has been measured yet. Live result stays UNPROVEN until a funded wallet completes this page.",
  };
}

function durableAction(action: ProductActionRecord): ProductActionRecord {
  if (action.txId) return action;
  if (action.phase === "quoting" || action.phase === "signing" || action.phase === "submitted" || action.phase === "waiting") {
    return { ...action, phase: "idle" };
  }
  return action;
}

function deployIsTerminalFailure(action: ProductActionRecord): boolean {
  if (!action.txId) return false;
  return action.statusName === "FINALIZED" && action.parentSuccessful === false;
}

function durableSession(session: ProductSession): ProductSession {
  const next: ProductSession = {
    ...session,
    deploy: durableAction(session.deploy),
    create: durableAction(session.create),
    cancel: durableAction(session.cancel),
  };
  if (deployIsTerminalFailure(next.deploy)) {
    next.address = undefined;
  }
  if (next.create.txId && !next.boundRewardWei) {
    next.boundRewardWei = next.create.quotedValueWei ?? next.createTask?.rewardWei;
    if (next.boundRewardWei && !next.boundRewardGen) next.boundRewardGen = next.rewardGen;
  }
  if (next.sourceMatch && (!next.sourceVerifiedAddress || !next.sourceVerifiedLocalSha256 || !next.address)) {
    next.sourceMatch = false;
    next.sourceVerifyStatus = "UNPROVEN";
    next.sourceVerifyReason =
      "Persisted source match is missing an address or PRODUCT_SOURCE SHA-256 binding. Recheck gen_getContractCode before create.";
  }
  if (next.genvmLagSeconds != null && Number.isFinite(next.genvmLagSeconds)) {
    rememberGenvmLag(next.genvmLagSeconds);
  }
  return next;
}

export function resetProductTransientPhases(session: ProductSession): ProductSession {
  return durableSession(session);
}

function asAction(raw: unknown): ProductActionRecord {
  if (!raw || typeof raw !== "object") return emptyAction();
  return { ...emptyAction(), ...(raw as ProductActionRecord) };
}

export function loadProductSession(): ProductSession {
  try {
    const raw = localStorage.getItem(PRODUCT_STORAGE_KEY);
    if (!raw) return emptyProductSession();
    const parsed = JSON.parse(raw) as Partial<ProductSession>;
    if (parsed.version !== 1) return emptyProductSession();
    return durableSession({
      ...emptyProductSession(),
      translator: typeof parsed.translator === "string" ? parsed.translator : "",
      rewardGen: typeof parsed.rewardGen === "string" ? parsed.rewardGen : "",
      boundFunder: typeof parsed.boundFunder === "string" ? parsed.boundFunder : undefined,
      boundTranslator: typeof parsed.boundTranslator === "string" ? parsed.boundTranslator : undefined,
      localSourceSha256: typeof parsed.localSourceSha256 === "string" ? parsed.localSourceSha256 : undefined,
      deployedSourceSha256: typeof parsed.deployedSourceSha256 === "string" ? parsed.deployedSourceSha256 : parsed.deployedSourceSha256 === null ? null : undefined,
      sourceMatch: Boolean(parsed.sourceMatch),
      sourceVerifyStatus: parsed.sourceVerifyStatus ?? "idle",
      sourceVerifyReason: typeof parsed.sourceVerifyReason === "string" ? parsed.sourceVerifyReason : emptyProductSession().sourceVerifyReason,
      sourceVerifiedAddress: typeof parsed.sourceVerifiedAddress === "string" ? parsed.sourceVerifiedAddress : undefined,
      sourceVerifiedLocalSha256: typeof parsed.sourceVerifiedLocalSha256 === "string" ? parsed.sourceVerifiedLocalSha256 : undefined,
      boundRewardWei: typeof parsed.boundRewardWei === "string" ? parsed.boundRewardWei : undefined,
      boundRewardGen: typeof parsed.boundRewardGen === "string" ? parsed.boundRewardGen : undefined,
      address: typeof parsed.address === "string" ? parsed.address : undefined,
      deploy: asAction(parsed.deploy),
      create: asAction(parsed.create),
      cancel: asAction(parsed.cancel),
      clientNonce: typeof parsed.clientNonce === "string" ? parsed.clientNonce : undefined,
      expectedTaskId: typeof parsed.expectedTaskId === "string" ? parsed.expectedTaskId : undefined,
      submitByUnix: typeof parsed.submitByUnix === "number" ? parsed.submitByUnix : undefined,
      recoverAfterUnix: typeof parsed.recoverAfterUnix === "number" ? parsed.recoverAfterUnix : undefined,
      genvmLagSeconds:
        typeof parsed.genvmLagSeconds === "number" && Number.isFinite(parsed.genvmLagSeconds)
          ? parsed.genvmLagSeconds
          : undefined,
      createDeadlineClock: parsed.createDeadlineClock === "utc" || parsed.createDeadlineClock === "genvm" ? parsed.createDeadlineClock : undefined,
      createTask: parsed.createTask,
      cancelTask: parsed.cancelTask,
      transfer: parsed.transfer,
      beforeCreate: parsed.beforeCreate,
      afterCreate: parsed.afterCreate,
      beforeCancel: parsed.beforeCancel,
      afterParent: parsed.afterParent,
      afterWait: parsed.afterWait,
      waitSamples: parsed.waitSamples,
      paymentEvidence: parsed.paymentEvidence === "YES" || parsed.paymentEvidence === "NO" ? parsed.paymentEvidence : "UNPROVEN",
      paymentReason:
        typeof parsed.paymentReason === "string"
          ? parsed.paymentReason
          : emptyProductSession().paymentReason,
    });
  } catch {
    return emptyProductSession();
  }
}

function omitTypedQuoteBlobs(action: ProductActionRecord): ProductActionRecord {
  return {
    ...action,
    quotedDistribution: undefined,
    quotedMessageAllocations: undefined,
  };
}

export function saveProductSession(session: ProductSession): void {
  const display: ProductSession = durableSession({
    ...session,
    deploy: omitTypedQuoteBlobs(session.deploy),
    create: omitTypedQuoteBlobs(session.create),
    cancel: omitTypedQuoteBlobs(session.cancel),
  });
  try {
    localStorage.setItem(PRODUCT_STORAGE_KEY, jsonStringifySafe(jsonSafe(display)));
  } catch {
    try {
      localStorage.setItem(
        PRODUCT_STORAGE_KEY,
        jsonStringifySafe(
          jsonSafe({
            version: 1,
            translator: session.translator,
            rewardGen: session.rewardGen,
            boundFunder: session.boundFunder,
            boundTranslator: session.boundTranslator,
            address: session.address,
            deploy: { phase: session.deploy.phase, txId: session.deploy.txId, statusName: session.deploy.statusName, executionName: session.deploy.executionName, parentSuccessful: session.deploy.parentSuccessful },
            create: { phase: session.create.phase, txId: session.create.txId, statusName: session.create.statusName, executionName: session.create.executionName, parentSuccessful: session.create.parentSuccessful },
            cancel: { phase: session.cancel.phase, txId: session.cancel.txId, statusName: session.cancel.statusName, executionName: session.cancel.executionName, parentSuccessful: session.cancel.parentSuccessful },
            clientNonce: session.clientNonce,
            expectedTaskId: session.expectedTaskId,
            paymentEvidence: session.paymentEvidence,
            paymentReason: session.paymentReason,
            sourceMatch: session.sourceMatch,
            sourceVerifyStatus: session.sourceVerifyStatus,
            sourceVerifyReason: session.sourceVerifyReason,
            sourceVerifiedAddress: session.sourceVerifiedAddress,
            sourceVerifiedLocalSha256: session.sourceVerifiedLocalSha256,
            boundRewardWei: session.boundRewardWei,
            boundRewardGen: session.boundRewardGen,
            genvmLagSeconds: session.genvmLagSeconds,
            createDeadlineClock: session.createDeadlineClock,
          }),
        ),
      );
    } catch {
      // Never throw out of persist.
    }
  }
}

export function clearProductSession(): ProductSession {
  const next = emptyProductSession();
  saveProductSession(next);
  return next;
}

export function invalidateQuotedProductAction(action: ProductActionRecord): ProductActionRecord {
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

export function invalidateProductUnsignedQuotes(session: ProductSession): ProductSession {
  return {
    ...session,
    deploy: invalidateQuotedProductAction(session.deploy),
    create: invalidateQuotedProductAction(session.create),
    cancel: invalidateQuotedProductAction(session.cancel),
  };
}

export function bindProductSession(session: ProductSession, funder: string, translator: string): ProductSession {
  return {
    ...session,
    boundFunder: session.boundFunder ?? funder,
    boundTranslator: session.boundTranslator ?? translator,
  };
}

export function actionOf(session: ProductSession, name: ProductActionName): ProductActionRecord {
  return session[name];
}

export function withProductAction(
  session: ProductSession,
  name: ProductActionName,
  patch: Partial<ProductActionRecord>,
): ProductSession {
  return { ...session, [name]: { ...session[name], ...patch } };
}
