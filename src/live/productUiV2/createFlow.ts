import type { TransactionFeeEstimate } from "genlayer-js/types";
import { isUserRejection } from "../eip1193";
import { formatError, jsonSafe } from "../format";
import {
  createReadClient,
  createWriteClient,
  quoteWrite,
  readProductTask,
  submitWrite,
  watchTx,
  type TxSummary,
} from "../genlayer";
import { applyTxSummaryToAction } from "../tracking";
import {
  cachedGenvmUnix,
  clearRememberedGenvmLag,
  createDeadlinesFromGenvm,
  createSignNowUnix,
  discoverGenvmUnix,
  genvmNowForSession,
  rememberGenvmLag,
} from "../product/clock";
import { deadlineStatusFromError } from "../product/createClock";
import { genToWei } from "../product/task";
import { trackingFailedAfterTxId } from "../productUi/attemptHistory";
import { formFingerprint, type CreateForm } from "../productUi/form";
import { makeV2CreateDeadlineProbe } from "../productV2/createClock";
import { createdV2TaskMatchesBound, createV2TaskArgs, parseProductV2Task } from "../productV2/task";
import { PRODUCT_UI_V2_CONTRACT } from "./constants";
import {
  bindCreateEstimateIdentity,
  createEstimateAllowed,
  createSignAllowed,
  deadlinesStale,
  neverResubmit,
  v2CreateSessionCompatible,
  type ProductUiV2WriteContext,
} from "./guards";
import { persistV2CreateTracking, saveProductUiV2Session, withCreateAction, type ProductUiV2Session } from "./persist";
import { currentV2ProductQuoteBinding, v2ProductQuoteInvalidReason, v2ProductQuoteStillValid } from "./quotes";

export function createArgsFromForm(
  form: CreateForm,
  session: Pick<ProductUiV2Session, "clientNonce" | "submitByUnix" | "recoverAfterUnix">,
): unknown[] {
  return createV2TaskArgs({
    clientNonce: session.clientNonce ?? "",
    translator: form.translator.trim(),
    submitByUnix: session.submitByUnix ?? 0,
    recoverAfterUnix: session.recoverAfterUnix ?? 0,
    sourceText: form.sourceText,
    sourceLocale: form.sourceLocale.trim(),
    targetLocale: form.targetLocale.trim(),
    stringKey: form.stringKey.trim(),
    appContext: form.appContext,
    intendedMeaning: form.intendedMeaning,
    semanticCriteria: form.semanticCriteria,
  });
}

export async function bindCreateClockAndNonce(
  session: ProductUiV2Session,
  input: {
    funder: string;
    translator: string;
    value: bigint;
    from: `0x${string}`;
    forceDiscover?: boolean;
  },
): Promise<ProductUiV2Session> {
  let genvmNow = input.forceDiscover ? undefined : cachedGenvmUnix(session);
  if (genvmNow == null) {
    genvmNow = await discoverGenvmUnix(
      makeV2CreateDeadlineProbe({
        address: PRODUCT_UI_V2_CONTRACT as `0x${string}`,
        translator: input.translator,
        value: input.value,
        from: input.from,
      }),
    );
  }
  const wallUnix = Math.floor(Date.now() / 1000);
  const lag = wallUnix - genvmNow;
  rememberGenvmLag(lag);
  const signNow = createSignNowUnix(genvmNow, wallUnix);
  const bound = await bindCreateEstimateIdentity(session, { funder: input.funder, nowUnix: signNow.nowUnix });
  return { ...bound, genvmLagSeconds: lag, createDeadlineClock: signNow.clock };
}

let lastQuotedEstimate: TransactionFeeEstimate | undefined;

export async function quoteCreateWrite(
  session: ProductUiV2Session,
  form: CreateForm,
  from: `0x${string}`,
  value: bigint,
): Promise<TransactionFeeEstimate> {
  let args: unknown[];
  if (session.createDeadlineClock === "utc") {
    const genvmNow = cachedGenvmUnix(session) ?? genvmNowForSession(session);
    const sim = createDeadlinesFromGenvm(genvmNow);
    args = createV2TaskArgs({
      clientNonce: session.clientNonce ?? `fee-sim-${sim.submitByUnix}`,
      translator: form.translator.trim(),
      submitByUnix: sim.submitByUnix,
      recoverAfterUnix: sim.recoverAfterUnix,
      sourceText: form.sourceText,
      sourceLocale: form.sourceLocale.trim(),
      targetLocale: form.targetLocale.trim(),
      stringKey: form.stringKey.trim(),
      appContext: form.appContext,
      intendedMeaning: form.intendedMeaning,
      semanticCriteria: form.semanticCriteria,
    });
  } else {
    args = createArgsFromForm(form, session);
  }
  return quoteWrite({
    address: PRODUCT_UI_V2_CONTRACT,
    functionName: "create_task",
    args,
    value,
    from,
  });
}

export function currentCreateQuoteBinding(input: {
  wallet: string;
  chainId: number;
  form: CreateForm;
  session: ProductUiV2Session;
  valueWei: string;
}) {
  return currentV2ProductQuoteBinding({
    wallet: input.wallet,
    chainId: input.chainId,
    contract: PRODUCT_UI_V2_CONTRACT,
    translator: input.form.translator.trim(),
    method: "create",
    valueWei: input.valueWei,
    clientNonce: input.session.clientNonce,
    submitByUnix: input.session.submitByUnix,
    recoverAfterUnix: input.session.recoverAfterUnix,
    taskId: input.session.expectedTaskId,
  });
}

export type CreateNavigateReady = { ok: true; taskId: string } | { ok: false; reason: string };

export function createNavigateReady(session: ProductUiV2Session): CreateNavigateReady {
  const action = session.create;
  if (!action.txId) return { ok: false, reason: "No create transaction ID yet." };
  if (action.statusName !== "FINALIZED") {
    return { ok: false, reason: `Waiting for FINALIZED (now ${action.statusName ?? "unknown"}).` };
  }
  if (!action.parentSuccessful) {
    return {
      ok: false,
      reason: `Create ${action.txId} is FINALIZED with ${action.executionName ?? "error"} (isSuccessful false). Not navigating. Do not resubmit this hash.`,
    };
  }
  const task = session.createTask;
  if (!task) return { ok: false, reason: "get_task has not matched this create yet." };
  if (!session.boundFunder || !session.boundTranslator || !session.boundRewardWei || !session.clientNonce || !session.expectedTaskId) {
    return { ok: false, reason: "Create session is missing bound identity for get_task match." };
  }
  if (session.submitByUnix == null || session.recoverAfterUnix == null) {
    return { ok: false, reason: "Create session is missing bound deadlines for get_task match." };
  }
  const match = createdV2TaskMatchesBound({
    task,
    funder: session.boundFunder,
    translator: session.boundTranslator,
    rewardWei: session.boundRewardWei,
    clientNonce: session.clientNonce,
    expectedTaskId: session.expectedTaskId,
    submitByUnix: session.submitByUnix,
    recoverAfterUnix: session.recoverAfterUnix,
  });
  if (!match.ok) return { ok: false, reason: match.reason };
  return { ok: true, taskId: task.task_id };
}

export async function estimateCreate(input: {
  session: ProductUiV2Session;
  form: CreateForm;
  identity: { address: `0x${string}`; chainId: number };
}): Promise<ProductUiV2Session> {
  let working = { ...input.session, form: input.form };
  const compat = v2CreateSessionCompatible(working, input.identity.address);
  if (!compat.ok) return withCreateAction(working, { phase: "idle", error: compat.reason });
  if (neverResubmit(working.create) === "resume") {
    return withCreateAction(working, {
      phase: working.create.phase,
      error: `Transaction ID ${working.create.txId} already exists. Resume tracking; not estimating a resubmit.`,
    });
  }
  const ctx: ProductUiV2WriteContext = {
    wallet: input.identity.address,
    chainId: input.identity.chainId,
    connected: true,
  };
  const allowed = createEstimateAllowed(working, ctx, input.form);
  if (!allowed.ok) return withCreateAction(working, { phase: "idle", error: allowed.reason });
  const reward = genToWei(input.form.rewardGen);
  if (reward == null) return withCreateAction(working, { phase: "idle", error: "Enter a GEN reward greater than zero." });
  working = withCreateAction(working, { phase: "quoting", error: undefined });
  working = await bindCreateClockAndNonce(working, {
    funder: input.identity.address,
    translator: input.form.translator.trim(),
    value: reward,
    from: input.identity.address,
  });
  let estimate: TransactionFeeEstimate;
  try {
    estimate = await quoteCreateWrite(working, input.form, input.identity.address, reward);
  } catch (err) {
    const status = deadlineStatusFromError(err);
    if (status === "far" || status === "past" || status === "early") {
      clearRememberedGenvmLag();
      working = await bindCreateClockAndNonce(
        { ...working, genvmLagSeconds: undefined },
        {
          funder: input.identity.address,
          translator: input.form.translator.trim(),
          value: reward,
          from: input.identity.address,
          forceDiscover: true,
        },
      );
      estimate = await quoteCreateWrite(working, input.form, input.identity.address, reward);
    } else {
      throw err;
    }
  }
  lastQuotedEstimate = estimate;
  const binding = currentCreateQuoteBinding({
    wallet: input.identity.address,
    chainId: input.identity.chainId,
    form: input.form,
    session: working,
    valueWei: reward.toString(),
  });
  return withCreateAction(
    {
      ...working,
      form: input.form,
      formFingerprint: formFingerprint(input.form),
      boundFunder: working.boundFunder ?? input.identity.address,
      boundTranslator: working.boundTranslator ?? input.form.translator.trim(),
      boundRewardWei: reward.toString(),
      boundRewardGen: input.form.rewardGen.trim(),
    },
    {
      phase: "quoted",
      quotedValueWei: reward.toString(),
      quotedFeeWei: estimate.feeValue.toString(),
      quotedDistribution: estimate.distribution,
      quotedMessageAllocations: estimate.messageAllocations,
      quotedBinding: binding,
      quotedAt: Date.now(),
      error: undefined,
    },
  );
}

export function signCreateBlocker(input: {
  session: ProductUiV2Session;
  form: CreateForm;
  identity: { address: `0x${string}`; chainId: number };
}): { ok: true; value: bigint; estimate: TransactionFeeEstimate } | { ok: false; session: ProductUiV2Session } {
  const live = { ...input.session, form: input.form };
  if (neverResubmit(live.create) === "resume") {
    return {
      ok: false,
      session: withCreateAction(live, {
        error: `Transaction ID ${live.create.txId} already exists. Resume tracking; do not resubmit.`,
      }),
    };
  }
  const ctx: ProductUiV2WriteContext = {
    wallet: input.identity.address,
    chainId: input.identity.chainId,
    connected: true,
  };
  const compat = v2CreateSessionCompatible(live, ctx.wallet);
  if (!compat.ok) return { ok: false, session: withCreateAction(live, { error: compat.reason }) };
  const nowUnix = live.createDeadlineClock === "utc" ? Math.floor(Date.now() / 1000) : genvmNowForSession(live);
  if (deadlinesStale(live.submitByUnix, nowUnix)) {
    return {
      ok: false,
      session: withCreateAction(live, {
        phase: "idle",
        quotedBinding: undefined,
        quotedFeeWei: undefined,
        error: "Create deadlines are too close to expiry. Estimate again to bind fresh submit_by / recover_after.",
      }),
    };
  }
  const allowed = createSignAllowed(live, ctx, input.form);
  if (!allowed.ok) return { ok: false, session: withCreateAction(live, { error: allowed.reason }) };
  const value = genToWei(input.form.rewardGen);
  if (value == null) {
    return { ok: false, session: withCreateAction(live, { error: "Enter a GEN reward greater than zero." }) };
  }
  const currentBinding = currentCreateQuoteBinding({
    wallet: input.identity.address,
    chainId: input.identity.chainId,
    form: input.form,
    session: live,
    valueWei: value.toString(),
  });
  if (!v2ProductQuoteStillValid(live.create.quotedBinding, currentBinding)) {
    return {
      ok: false,
      session: withCreateAction(live, {
        phase: "idle",
        quotedBinding: undefined,
        quotedFeeWei: undefined,
        error: v2ProductQuoteInvalidReason(live.create.quotedBinding, currentBinding),
      }),
    };
  }
  const feeWei = live.create.quotedFeeWei;
  if (!feeWei) {
    return { ok: false, session: withCreateAction(live, { error: "No fee quote is bound. Estimate again before signing." }) };
  }
  const cached = lastQuotedEstimate;
  if (!cached || cached.feeValue.toString() !== feeWei) {
    return {
      ok: false,
      session: withCreateAction(live, {
        phase: "idle",
        quotedBinding: undefined,
        quotedFeeWei: undefined,
        error: "The in-memory fee quote was lost (reload). Estimate again before signing. The previous hash was not submitted.",
      }),
    };
  }
  return { ok: true, value, estimate: cached };
}

export { formatError, isUserRejection };

export async function submitCreateTx(input: {
  session: ProductUiV2Session;
  form: CreateForm;
  identity: { address: `0x${string}`; chainId: number };
  provider: Parameters<typeof createWriteClient>[1];
  estimate: TransactionFeeEstimate;
  value: bigint;
}): Promise<{ txId: string; session: ProductUiV2Session }> {
  const latest = input.session;
  const txId = await submitWrite(createWriteClient(input.identity.address, input.provider), {
    address: PRODUCT_UI_V2_CONTRACT,
    functionName: "create_task",
    args: createArgsFromForm(input.form, latest),
    value: input.value,
    estimate: input.estimate,
  });
  const next = withCreateAction(
    {
      ...latest,
      form: input.form,
      boundFunder: latest.boundFunder ?? input.identity.address,
      boundTranslator: latest.boundTranslator ?? input.form.translator.trim(),
      boundRewardWei: latest.boundRewardWei ?? input.value.toString(),
      boundRewardGen: latest.boundRewardGen ?? input.form.rewardGen.trim(),
    },
    {
      phase: "submitted",
      txId,
      submittedAt: Date.now(),
      quotedValueWei: input.value.toString(),
      error: undefined,
    },
  );
  saveProductUiV2Session(next);
  return { txId, session: next };
}

export async function refreshCreateTask(session: ProductUiV2Session): Promise<ProductUiV2Session> {
  if (!session.expectedTaskId) return session;
  try {
    const raw = jsonSafe(await readProductTask(createReadClient(), PRODUCT_UI_V2_CONTRACT, session.expectedTaskId));
    const createTask = parseProductV2Task(raw);
    return { ...session, createTask, create: { ...session.create, error: undefined } };
  } catch (err) {
    return withCreateAction(session, {
      error: `get_task after create: ${formatError(err)} Existing tx ID is kept. Not resubmitting.`,
    });
  }
}

export function retainCreateAfterTrackingFailure(
  session: ProductUiV2Session,
  txId: string,
  err: unknown,
): ProductUiV2Session {
  const next = withCreateAction(
    {
      ...session,
      create: { ...session.create, txId: session.create.txId ?? txId },
    },
    {
      txId,
      phase: session.create.statusName === "FINALIZED" ? session.create.phase : "waiting",
      error: trackingFailedAfterTxId(txId, err),
    },
  );
  return persistV2CreateTracking(next);
}

export async function trackCreateTx(
  session: ProductUiV2Session,
  txId: string,
  onUpdate: (next: ProductUiV2Session) => void,
): Promise<ProductUiV2Session> {
  let current = withCreateAction(session, { phase: "waiting", txId, error: undefined });
  current = persistV2CreateTracking(current);
  onUpdate(current);
  try {
    const apply = (summary: TxSummary) => {
      current = { ...current, create: applyTxSummaryToAction(current.create, summary) };
      current = persistV2CreateTracking(current);
      onUpdate(current);
      return current;
    };
    const summary = await watchTx(createReadClient(), txId, apply);
    current = apply(summary);
    if (summary.parentSuccessful && summary.statusName === "FINALIZED") {
      current = await refreshCreateTask(current);
      current = persistV2CreateTracking(current);
      onUpdate(current);
    }
    return current;
  } catch (err) {
    current = retainCreateAfterTrackingFailure(current, txId, err);
    onUpdate(current);
    return current;
  }
}

export function peekLastQuotedCreateEstimate(): TransactionFeeEstimate | undefined {
  return lastQuotedEstimate;
}

export function setLastQuotedCreateEstimateForTests(estimate: TransactionFeeEstimate | undefined): void {
  lastQuotedEstimate = estimate;
}
