import { jsonSafe, jsonStringifySafe } from "../format";
import { isFinalizedSuccessful, isTerminalFailure } from "../guards";
import { rememberGenvmLag, type CreateDeadlineClock } from "../product/clock";
import type { ProductActionRecord } from "../product/persist";
import { appendAttemptHistory, parseAttemptHistory, type AttemptHistoryEntry } from "../productUi/attemptHistory";
import { emptyCreateForm, type CreateForm } from "../productUi/form";
import type { ProductV2Task } from "../productV2/task";
import { PRODUCT_UI_V2_STORAGE_KEY } from "./constants";
import type { V2ProductQuoteBinding } from "./quotes";

export type ProductUiV2ActionRecord = Omit<ProductActionRecord, "quotedBinding"> & {
  quotedBinding?: V2ProductQuoteBinding;
};

export type ProductUiV2Session = {
  version: 1;
  form: CreateForm;
  formFingerprint?: string;
  boundFunder?: string;
  boundTranslator?: string;
  boundRewardWei?: string;
  boundRewardGen?: string;
  clientNonce?: string;
  expectedTaskId?: string;
  submitByUnix?: number;
  recoverAfterUnix?: number;
  genvmLagSeconds?: number;
  createDeadlineClock?: CreateDeadlineClock;
  create: ProductUiV2ActionRecord;
  createTask?: ProductV2Task;
  lastOpenedTaskId?: string;
  navigatedTaskId?: string;
  createAttemptHistory?: AttemptHistoryEntry[];
  sourceMatch: boolean;
  sourceVerifyStatus: "idle" | "match" | "mismatch" | "UNPROVEN";
  sourceVerifyReason: string;
  localSourceSha256?: string;
  deployedSourceSha256?: string | null;
  sourceVerifiedAddress?: string;
  sourceVerifiedLocalSha256?: string;
  /** In-memory only for this page load. Storage load always starts false. */
  sourceRecheckedThisLoad?: boolean;
};

function emptyAction(): ProductUiV2ActionRecord {
  return { phase: "idle" };
}

export function emptyProductUiV2Session(): ProductUiV2Session {
  return {
    version: 1,
    form: emptyCreateForm(),
    create: emptyAction(),
    sourceMatch: false,
    sourceVerifyStatus: "idle",
    sourceVerifyReason: "Source has not been checked against Studio-dev yet.",
    sourceRecheckedThisLoad: false,
  };
}

function durableAction(action: ProductUiV2ActionRecord): ProductUiV2ActionRecord {
  if (action.txId) return action;
  if (action.phase === "quoting" || action.phase === "signing" || action.phase === "submitted" || action.phase === "waiting") {
    return { ...action, phase: "idle" };
  }
  return action;
}

function asAction(raw: unknown): ProductUiV2ActionRecord {
  if (!raw || typeof raw !== "object") return emptyAction();
  return { ...emptyAction(), ...(raw as ProductUiV2ActionRecord) };
}

function asForm(raw: unknown): CreateForm {
  const base = emptyCreateForm();
  if (!raw || typeof raw !== "object") return base;
  const rec = raw as Partial<CreateForm>;
  return {
    sourceText: typeof rec.sourceText === "string" ? rec.sourceText : base.sourceText,
    sourceLocale: typeof rec.sourceLocale === "string" ? rec.sourceLocale : base.sourceLocale,
    targetLocale: typeof rec.targetLocale === "string" ? rec.targetLocale : base.targetLocale,
    stringKey: typeof rec.stringKey === "string" ? rec.stringKey : base.stringKey,
    appContext: typeof rec.appContext === "string" ? rec.appContext : base.appContext,
    intendedMeaning: typeof rec.intendedMeaning === "string" ? rec.intendedMeaning : base.intendedMeaning,
    semanticCriteria: typeof rec.semanticCriteria === "string" ? rec.semanticCriteria : base.semanticCriteria,
    translator: typeof rec.translator === "string" ? rec.translator : base.translator,
    rewardGen: typeof rec.rewardGen === "string" ? rec.rewardGen : base.rewardGen,
  };
}

function durableSession(session: ProductUiV2Session): ProductUiV2Session {
  const next: ProductUiV2Session = {
    ...session,
    version: 1,
    form: session.form ?? emptyCreateForm(),
    create: durableAction(session.create),
  };
  if (next.create.txId && !next.boundRewardWei) {
    next.boundRewardWei = next.create.quotedValueWei ?? next.createTask?.rewardWei;
    if (next.boundRewardWei && !next.boundRewardGen) next.boundRewardGen = next.form.rewardGen;
  }
  if (next.genvmLagSeconds != null && Number.isFinite(next.genvmLagSeconds)) {
    rememberGenvmLag(next.genvmLagSeconds);
  }
  if (next.sourceMatch && (!next.sourceVerifiedAddress || !next.sourceVerifiedLocalSha256)) {
    next.sourceMatch = false;
    next.sourceVerifyStatus = "UNPROVEN";
    next.sourceVerifyReason =
      "Persisted source match is missing an address or localebounty_v2.py SHA-256 binding. Recheck gen_getContractCode before create.";
  }
  next.sourceRecheckedThisLoad = Boolean(session.sourceRecheckedThisLoad);
  return next;
}

export function loadProductUiV2Session(): ProductUiV2Session {
  try {
    const raw = localStorage.getItem(PRODUCT_UI_V2_STORAGE_KEY);
    if (!raw) return emptyProductUiV2Session();
    const parsed = JSON.parse(raw) as Partial<ProductUiV2Session>;
    if (parsed.version !== 1) return emptyProductUiV2Session();
    return durableSession({
      ...emptyProductUiV2Session(),
      form: asForm(parsed.form),
      formFingerprint: typeof parsed.formFingerprint === "string" ? parsed.formFingerprint : undefined,
      boundFunder: typeof parsed.boundFunder === "string" ? parsed.boundFunder : undefined,
      boundTranslator: typeof parsed.boundTranslator === "string" ? parsed.boundTranslator : undefined,
      boundRewardWei: typeof parsed.boundRewardWei === "string" ? parsed.boundRewardWei : undefined,
      boundRewardGen: typeof parsed.boundRewardGen === "string" ? parsed.boundRewardGen : undefined,
      clientNonce: typeof parsed.clientNonce === "string" ? parsed.clientNonce : undefined,
      expectedTaskId: typeof parsed.expectedTaskId === "string" ? parsed.expectedTaskId : undefined,
      submitByUnix: typeof parsed.submitByUnix === "number" ? parsed.submitByUnix : undefined,
      recoverAfterUnix: typeof parsed.recoverAfterUnix === "number" ? parsed.recoverAfterUnix : undefined,
      genvmLagSeconds:
        typeof parsed.genvmLagSeconds === "number" && Number.isFinite(parsed.genvmLagSeconds)
          ? parsed.genvmLagSeconds
          : undefined,
      createDeadlineClock:
        parsed.createDeadlineClock === "utc" || parsed.createDeadlineClock === "genvm"
          ? parsed.createDeadlineClock
          : undefined,
      create: asAction(parsed.create),
      createTask: parsed.createTask,
      lastOpenedTaskId: typeof parsed.lastOpenedTaskId === "string" ? parsed.lastOpenedTaskId : undefined,
      navigatedTaskId: typeof parsed.navigatedTaskId === "string" ? parsed.navigatedTaskId : undefined,
      createAttemptHistory: (() => {
        const history = parseAttemptHistory(parsed.createAttemptHistory);
        return history.length ? history : undefined;
      })(),
      sourceMatch: Boolean(parsed.sourceMatch),
      sourceVerifyStatus: parsed.sourceVerifyStatus ?? "idle",
      sourceVerifyReason:
        typeof parsed.sourceVerifyReason === "string" ? parsed.sourceVerifyReason : emptyProductUiV2Session().sourceVerifyReason,
      localSourceSha256: typeof parsed.localSourceSha256 === "string" ? parsed.localSourceSha256 : undefined,
      deployedSourceSha256:
        typeof parsed.deployedSourceSha256 === "string"
          ? parsed.deployedSourceSha256
          : parsed.deployedSourceSha256 === null
            ? null
            : undefined,
      sourceVerifiedAddress: typeof parsed.sourceVerifiedAddress === "string" ? parsed.sourceVerifiedAddress : undefined,
      sourceVerifiedLocalSha256:
        typeof parsed.sourceVerifiedLocalSha256 === "string" ? parsed.sourceVerifiedLocalSha256 : undefined,
      sourceRecheckedThisLoad: false,
    });
  } catch {
    return emptyProductUiV2Session();
  }
}

function omitTypedQuoteBlobs(action: ProductUiV2ActionRecord): ProductUiV2ActionRecord {
  return {
    ...action,
    quotedDistribution: undefined,
    quotedMessageAllocations: undefined,
  };
}

export function saveProductUiV2Session(session: ProductUiV2Session): void {
  const display = durableSession({
    ...session,
    create: omitTypedQuoteBlobs(session.create),
    sourceRecheckedThisLoad: false,
  });
  try {
    localStorage.setItem(PRODUCT_UI_V2_STORAGE_KEY, jsonStringifySafe(jsonSafe(display)));
  } catch {
    try {
      localStorage.setItem(
        PRODUCT_UI_V2_STORAGE_KEY,
        jsonStringifySafe(
          jsonSafe({
            version: 1,
            form: session.form,
            boundFunder: session.boundFunder,
            boundTranslator: session.boundTranslator,
            boundRewardWei: session.boundRewardWei,
            clientNonce: session.clientNonce,
            expectedTaskId: session.expectedTaskId,
            submitByUnix: session.submitByUnix,
            recoverAfterUnix: session.recoverAfterUnix,
            create: {
              phase: session.create.phase,
              txId: session.create.txId,
              statusName: session.create.statusName,
              executionName: session.create.executionName,
              parentSuccessful: session.create.parentSuccessful,
              quotedValueWei: session.create.quotedValueWei,
              quotedFeeWei: session.create.quotedFeeWei,
              quotedBinding: session.create.quotedBinding,
            },
            lastOpenedTaskId: session.lastOpenedTaskId,
            navigatedTaskId: session.navigatedTaskId,
            sourceMatch: session.sourceMatch,
            sourceVerifyStatus: session.sourceVerifyStatus,
            sourceVerifyReason: session.sourceVerifyReason,
          }),
        ),
      );
    } catch {
      // Never throw out of persist.
    }
  }
}

export function resetProductUiV2TransientPhases(session: ProductUiV2Session): ProductUiV2Session {
  return durableSession(session);
}

export function withCreateAction(session: ProductUiV2Session, patch: Partial<ProductUiV2ActionRecord>): ProductUiV2Session {
  return { ...session, create: { ...session.create, ...patch } };
}

export type V2CreateTrackingSlice = {
  create: ProductUiV2ActionRecord;
  createTask?: ProductV2Task;
  navigatedTaskId?: string;
  lastOpenedTaskId?: string;
};

/** Merge tracking output into the latest stored session without clobbering source fields or bound identity. */
export function mergeV2CreateTracking(latest: ProductUiV2Session, slice: V2CreateTrackingSlice): ProductUiV2Session {
  // A tracker from an older attempt must not replace a newer stored hash.
  if (latest.create.txId && slice.create.txId && latest.create.txId !== slice.create.txId) return latest;
  const storedTxId = latest.create.txId ?? slice.create.txId;
  return {
    ...latest,
    create: {
      ...latest.create,
      phase: slice.create.phase,
      txId: storedTxId,
      submittedAt: slice.create.submittedAt ?? latest.create.submittedAt,
      statusName: slice.create.statusName,
      executionName: slice.create.executionName,
      lifecycle: slice.create.lifecycle,
      parentSuccessful: slice.create.parentSuccessful,
      error: slice.create.error,
      snapshot: slice.create.snapshot,
      contractAddress: slice.create.contractAddress,
      receipt: slice.create.receipt,
      actualFeeWei: slice.create.actualFeeWei,
      actualFeeSource: slice.create.actualFeeSource,
      actualFeeAvailable: slice.create.actualFeeAvailable,
      executionError: slice.create.executionError,
    },
    createTask: slice.createTask ?? latest.createTask,
    navigatedTaskId: slice.navigatedTaskId ?? latest.navigatedTaskId,
    lastOpenedTaskId: slice.lastOpenedTaskId ?? latest.lastOpenedTaskId,
    boundFunder: latest.boundFunder,
    boundTranslator: latest.boundTranslator,
    boundRewardWei: latest.boundRewardWei,
    boundRewardGen: latest.boundRewardGen,
    clientNonce: latest.clientNonce,
    expectedTaskId: latest.expectedTaskId,
    submitByUnix: latest.submitByUnix,
    recoverAfterUnix: latest.recoverAfterUnix,
    createAttemptHistory: latest.createAttemptHistory,
    formFingerprint: latest.formFingerprint,
    form: latest.form,
    sourceMatch: latest.sourceMatch,
    sourceVerifyStatus: latest.sourceVerifyStatus,
    sourceVerifyReason: latest.sourceVerifyReason,
    localSourceSha256: latest.localSourceSha256,
    deployedSourceSha256: latest.deployedSourceSha256,
    sourceVerifiedAddress: latest.sourceVerifiedAddress,
    sourceVerifiedLocalSha256: latest.sourceVerifiedLocalSha256,
    sourceRecheckedThisLoad: latest.sourceRecheckedThisLoad,
  };
}

export function persistV2CreateTracking(slice: V2CreateTrackingSlice): ProductUiV2Session {
  const next = mergeV2CreateTracking(loadProductUiV2Session(), slice);
  saveProductUiV2Session(next);
  return next;
}

export function rememberOpenedV2Task(session: ProductUiV2Session, taskId: string): ProductUiV2Session {
  if (session.lastOpenedTaskId === taskId) return session;
  return { ...session, lastOpenedTaskId: taskId };
}

export function startNewV2CreateAttempt(session: ProductUiV2Session): ProductUiV2Session {
  if (session.create.txId && !isTerminalFailure(session.create) && !isFinalizedSuccessful(session.create)) {
    return session;
  }
  let history = parseAttemptHistory(session.createAttemptHistory);
  if (session.create.txId) {
    history = appendAttemptHistory(history, {
      txId: session.create.txId,
      archivedAt: Date.now(),
      statusName: session.create.statusName,
      executionName: session.create.executionName,
      parentSuccessful: session.create.parentSuccessful,
      submittedAt: session.create.submittedAt,
      error: session.create.error,
      action: "create",
      taskId: session.expectedTaskId,
    });
  }
  return {
    ...session,
    formFingerprint: undefined,
    boundFunder: undefined,
    boundTranslator: undefined,
    boundRewardWei: undefined,
    boundRewardGen: undefined,
    clientNonce: undefined,
    expectedTaskId: undefined,
    submitByUnix: undefined,
    recoverAfterUnix: undefined,
    create: emptyAction(),
    createTask: undefined,
    navigatedTaskId: undefined,
    createAttemptHistory: history.length ? history : session.createAttemptHistory,
  };
}
