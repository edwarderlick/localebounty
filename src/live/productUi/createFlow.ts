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
import { deadlineStatusFromError, makeCreateDeadlineProbe } from "../product/createClock";
import { currentProductQuoteBinding, productQuoteInvalidReason, productQuoteStillValid } from "../product/quotes";
import { createdTaskMatchesBound, createTaskArgs, genToWei, parseProductTask } from "../product/task";
import { PRODUCT_UI_CONTRACT } from "./constants";
import { formFingerprint, type CreateForm } from "./form";
import {
  bindCreateEstimateIdentity,
  createEstimateAllowed,
  createSignAllowed,
  deadlinesStale,
  neverResubmit,
  productUiSessionCompatible,
  type ProductUiWriteContext,
} from "./guards";
import { trackingFailedAfterTxId } from "./attemptHistory";
import { saveProductUiSession, withCreateAction, type ProductUiSession } from "./persist";

export function createArgsFromForm(
  form: CreateForm,
  session: Pick<ProductUiSession, "clientNonce" | "submitByUnix" | "recoverAfterUnix">,
): unknown[] {
  return createTaskArgs({
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
  session: ProductUiSession,
  input: {
    funder: string;
    translator: string;
    value: bigint;
    from: `0x${string}`;
    forceDiscover?: boolean;
  },
): Promise<ProductUiSession> {
  let genvmNow = input.forceDiscover ? undefined : cachedGenvmUnix(session);
  if (genvmNow == null) {
    genvmNow = await discoverGenvmUnix(
      makeCreateDeadlineProbe({
        address: PRODUCT_UI_CONTRACT,
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
  const bound = await bindCreateEstimateIdentity(session, {
    funder: input.funder,
    nowUnix: signNow.nowUnix,
    contract: PRODUCT_UI_CONTRACT,
  });
  return { ...bound, genvmLagSeconds: lag, createDeadlineClock: signNow.clock };
}

let lastQuotedEstimate: TransactionFeeEstimate | undefined;

export async function quoteCreateWrite(
  session: ProductUiSession,
  form: CreateForm,
  from: `0x${string}`,
  value: bigint,
): Promise<TransactionFeeEstimate> {
  let args: unknown[];
  if (session.createDeadlineClock === "utc") {
    const genvmNow = cachedGenvmUnix(session) ?? genvmNowForSession(session);
    const sim = createDeadlinesFromGenvm(genvmNow);
    args = createTaskArgs({
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
    address: PRODUCT_UI_CONTRACT,
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
  session: ProductUiSession;
  valueWei: string;
}) {
  return currentProductQuoteBinding({
    wallet: input.wallet,
    chainId: input.chainId,
    contract: PRODUCT_UI_CONTRACT,
    translator: input.form.translator.trim(),
    method: "create",
    valueWei: input.valueWei,
    clientNonce: input.session.clientNonce,
    submitByUnix: input.session.submitByUnix,
    recoverAfterUnix: input.session.recoverAfterUnix,
    taskId: input.session.expectedTaskId,
  });
}

export type CreateNavigateReady =
  | { ok: true; taskId: string }
  | { ok: false; reason: string };

export function createNavigateReady(session: ProductUiSession): CreateNavigateReady {
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
  const match = createdTaskMatchesBound({
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
  session: ProductUiSession;
  form: CreateForm;
  identity: { address: `0x${string}`; chainId: number };
}): Promise<ProductUiSession> {
  const { identity } = input;
  let working = { ...input.session, form: input.form };
  const compat = productUiSessionCompatible(working, identity.address);
  if (!compat.ok) return withCreateAction(working, { phase: "idle", error: compat.reason });
  if (neverResubmit(working.create) === "resume") {
    return withCreateAction(working, {
      phase: working.create.phase,
      error: `Transaction ID ${working.create.txId} already exists. Resume tracking; not estimating a resubmit.`,
    });
  }
  const ctx: ProductUiWriteContext = {
    funder: identity.address,
    chainId: identity.chainId,
    connected: true,
  };
  const allowed = createEstimateAllowed(working, ctx, input.form);
  if (!allowed.ok) return withCreateAction(working, { phase: "idle", error: allowed.reason });
  const reward = genToWei(input.form.rewardGen);
  if (reward == null) return withCreateAction(working, { phase: "idle", error: "Enter a GEN reward greater than zero." });
  working = withCreateAction(working, { phase: "quoting", error: undefined });
  working = await bindCreateClockAndNonce(working, {
    funder: identity.address,
    translator: input.form.translator.trim(),
    value: reward,
    from: identity.address,
  });
  let estimate: TransactionFeeEstimate;
  try {
    estimate = await quoteCreateWrite(working, input.form, identity.address, reward);
  } catch (err) {
    const status = deadlineStatusFromError(err);
    if (status === "far" || status === "past" || status === "early") {
      clearRememberedGenvmLag();
      working = await bindCreateClockAndNonce(
        { ...working, genvmLagSeconds: undefined },
        {
          funder: identity.address,
          translator: input.form.translator.trim(),
          value: reward,
          from: identity.address,
          forceDiscover: true,
        },
      );
      estimate = await quoteCreateWrite(working, input.form, identity.address, reward);
    } else {
      throw err;
    }
  }
  lastQuotedEstimate = estimate;
  const binding = currentCreateQuoteBinding({
    wallet: identity.address,
    chainId: identity.chainId,
    form: input.form,
    session: working,
    valueWei: reward.toString(),
  });
  return withCreateAction(
    {
      ...working,
      form: input.form,
      formFingerprint: formFingerprint(input.form),
      boundFunder: working.boundFunder ?? identity.address,
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
  session: ProductUiSession;
  form: CreateForm;
  identity: { address: `0x${string}`; chainId: number };
}): { ok: true; value: bigint; estimate: TransactionFeeEstimate } | { ok: false; session: ProductUiSession } {
  const live = { ...input.session, form: input.form };
  if (neverResubmit(live.create) === "resume") {
    return {
      ok: false,
      session: withCreateAction(live, {
        error: `Transaction ID ${live.create.txId} already exists. Resume tracking; do not resubmit.`,
      }),
    };
  }
  const ctx: ProductUiWriteContext = {
    funder: input.identity.address,
    chainId: input.identity.chainId,
    connected: true,
  };
  const compat = productUiSessionCompatible(live, ctx.funder);
  if (!compat.ok) return { ok: false, session: withCreateAction(live, { error: compat.reason }) };
  const nowUnix =
    live.createDeadlineClock === "utc" ? Math.floor(Date.now() / 1000) : genvmNowForSession(live);
  if (deadlinesStale(live.submitByUnix, nowUnix)) {
    return {
      ok: false,
      session: withCreateAction(live, {
        phase: "idle",
        quotedBinding: undefined,
        quotedFeeWei: undefined,
        error:
          "Create deadlines are too close to expiry. Estimate again to bind fresh submit_by / recover_after.",
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
  if (!productQuoteStillValid(live.create.quotedBinding, currentBinding)) {
    return {
      ok: false,
      session: withCreateAction(live, {
        phase: "idle",
        quotedBinding: undefined,
        quotedFeeWei: undefined,
        error: productQuoteInvalidReason(live.create.quotedBinding, currentBinding),
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
  session: ProductUiSession;
  form: CreateForm;
  identity: { address: `0x${string}`; chainId: number };
  provider: Parameters<typeof createWriteClient>[1];
  estimate: TransactionFeeEstimate;
  value: bigint;
}): Promise<{ txId: string; session: ProductUiSession }> {
  const latest = input.session;
  const txId = await submitWrite(createWriteClient(input.identity.address, input.provider), {
    address: PRODUCT_UI_CONTRACT,
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
  saveProductUiSession(next);
  return { txId, session: next };
}

export async function refreshCreateTask(session: ProductUiSession): Promise<ProductUiSession> {
  if (!session.expectedTaskId) return session;
  try {
    const raw = jsonSafe(await readProductTask(createReadClient(), PRODUCT_UI_CONTRACT, session.expectedTaskId));
    const createTask = parseProductTask(raw);
    return { ...session, createTask, create: { ...session.create, error: undefined } };
  } catch (err) {
    return withCreateAction(session, {
      error: `get_task after create: ${formatError(err)} Existing tx ID is kept. Not resubmitting.`,
    });
  }
}

export function retainCreateAfterTrackingFailure(
  session: ProductUiSession,
  txId: string,
  err: unknown,
): ProductUiSession {
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
  saveProductUiSession(next);
  return next;
}

export async function trackCreateTx(
  session: ProductUiSession,
  txId: string,
  onUpdate: (next: ProductUiSession) => void,
): Promise<ProductUiSession> {
  let current = withCreateAction(session, { phase: "waiting", txId, error: undefined });
  saveProductUiSession(current);
  onUpdate(current);
  try {
    const apply = (summary: TxSummary) => {
      current = { ...current, create: applyTxSummaryToAction(current.create, summary) };
      saveProductUiSession(current);
      onUpdate(current);
      return current;
    };
    const summary = await watchTx(createReadClient(), txId, apply);
    current = apply(summary);
    if (summary.parentSuccessful && summary.statusName === "FINALIZED") {
      current = await refreshCreateTask(current);
      saveProductUiSession(current);
      onUpdate(current);
    }
    return current;
  } catch (err) {
    current = retainCreateAfterTrackingFailure(current, txId, err);
    onUpdate(current);
    return current;
  }
}
