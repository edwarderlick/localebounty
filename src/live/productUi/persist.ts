import { jsonSafe, jsonStringifySafe } from "../format";
import { isFinalizedSuccessful, isTerminalFailure } from "../guards";
import { rememberGenvmLag, type CreateDeadlineClock } from "../product/clock";
import type { ProductActionRecord } from "../product/persist";
import type { ProductQuoteBinding } from "../product/quotes";
import type { ProductTask } from "../product/task";
import { appendAttemptHistory, parseAttemptHistory, type AttemptHistoryEntry } from "./attemptHistory";
import { PRODUCT_UI_STORAGE_KEY } from "./constants";
import { emptyCreateForm, type CreateForm } from "./form";

export type ProductUiSession = {
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
  create: ProductActionRecord;
  createTask?: ProductTask;
  lastOpenedTaskId?: string;
  navigatedTaskId?: string;
  createAttemptHistory?: AttemptHistoryEntry[];
};

function emptyAction(): ProductActionRecord {
  return { phase: "idle" };
}

export function emptyProductUiSession(): ProductUiSession {
  return {
    version: 1,
    form: emptyCreateForm(),
    create: emptyAction(),
  };
}

function durableAction(action: ProductActionRecord): ProductActionRecord {
  if (action.txId) return action;
  if (action.phase === "quoting" || action.phase === "signing" || action.phase === "submitted" || action.phase === "waiting") {
    return { ...action, phase: "idle" };
  }
  return action;
}

function asAction(raw: unknown): ProductActionRecord {
  if (!raw || typeof raw !== "object") return emptyAction();
  return { ...emptyAction(), ...(raw as ProductActionRecord) };
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

function durableSession(session: ProductUiSession): ProductUiSession {
  const next: ProductUiSession = {
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
  return next;
}

export function loadProductUiSession(): ProductUiSession {
  try {
    const raw = localStorage.getItem(PRODUCT_UI_STORAGE_KEY);
    if (!raw) return emptyProductUiSession();
    const parsed = JSON.parse(raw) as Partial<ProductUiSession>;
    if (parsed.version !== 1) return emptyProductUiSession();
    return durableSession({
      ...emptyProductUiSession(),
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
    });
  } catch {
    return emptyProductUiSession();
  }
}

function omitTypedQuoteBlobs(action: ProductActionRecord): ProductActionRecord {
  return {
    ...action,
    quotedDistribution: undefined,
    quotedMessageAllocations: undefined,
  };
}

export function saveProductUiSession(session: ProductUiSession): void {
  const display = durableSession({
    ...session,
    create: omitTypedQuoteBlobs(session.create),
  });
  try {
    localStorage.setItem(PRODUCT_UI_STORAGE_KEY, jsonStringifySafe(jsonSafe(display)));
  } catch {
    try {
      localStorage.setItem(
        PRODUCT_UI_STORAGE_KEY,
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
              quotedBinding: session.create.quotedBinding as ProductQuoteBinding | undefined,
            },
            lastOpenedTaskId: session.lastOpenedTaskId,
            navigatedTaskId: session.navigatedTaskId,
            createAttemptHistory: session.createAttemptHistory,
          }),
        ),
      );
    } catch {
      // Never throw out of persist.
    }
  }
}

export function resetProductUiTransientPhases(session: ProductUiSession): ProductUiSession {
  return durableSession(session);
}

export function withCreateAction(session: ProductUiSession, patch: Partial<ProductActionRecord>): ProductUiSession {
  return { ...session, create: { ...session.create, ...patch } };
}

export function rememberOpenedTask(session: ProductUiSession, taskId: string): ProductUiSession {
  if (session.lastOpenedTaskId === taskId) return session;
  return { ...session, lastOpenedTaskId: taskId };
}

/** After a finalized create, start a new unsubmitted attempt. Pending tx IDs stay. Old hashes go to history. */
export function startNewCreateAttempt(session: ProductUiSession): ProductUiSession {
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
