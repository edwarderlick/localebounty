import { beforeEach, describe, expect, it } from "vitest";
import { STORAGE_KEY as DEMO_STORAGE_KEY } from "../../src/data/demoStore";
import {
  isDemoPath,
  isV2ProductPath,
  liveCreateHref,
  liveTaskHref,
  v2BoardHref,
  v2CreateHref,
  v2DecisionHref,
  v2LibraryHref,
  v2SubmitHref,
  v2TaskHref,
} from "../../src/lib/paths";
import { PRODUCT_STORAGE_KEY } from "../../src/live/product/constants";
import { PRODUCT_UI_CONTRACT, PRODUCT_UI_STORAGE_KEY, PRODUCT_UI_WRITES_STORAGE_KEY } from "../../src/live/productUi/constants";
import { emptyCreateForm, formFingerprint, type CreateForm } from "../../src/live/productUi/form";
import { liveTaskState } from "../../src/live/productUi/status";
import {
  PRODUCT_UI_V2_CONTRACT,
  PRODUCT_UI_V2_SOURCE_SHA256,
  PRODUCT_UI_V2_STORAGE_KEY,
  PRODUCT_UI_V2_WRITES_STORAGE_KEY,
} from "../../src/live/productUiV2/constants";
import { createNavigateReady, signCreateBlocker, setLastQuotedCreateEstimateForTests } from "../../src/live/productUiV2/createFlow";
import {
  acceptConfirmStored,
  acceptEstimateAllowed,
  cancelEstimateAllowed,
  createEstimateAllowed,
  createSignAllowed,
  evaluateEstimateAllowed,
  expireEstimateAllowed,
  recoverEstimateAllowed,
  needsCreateTxResume,
  neverResubmit,
  showV2Accept,
  showV2Cancel,
  submitEstimateAllowed,
} from "../../src/live/productUiV2/guards";
import {
  emptyProductUiV2Session,
  loadProductUiV2Session,
  persistV2CreateTracking,
  saveProductUiV2Session,
  startNewV2CreateAttempt,
  type ProductUiV2Session,
} from "../../src/live/productUiV2/persist";
import { currentV2ProductQuoteBinding, v2ProductQuoteStillValid } from "../../src/live/productUiV2/quotes";
import { pendingV2SourceFields, persistV2SourceFields, sourceAllowsV2ProductCreate, verifyV2ProductSource } from "../../src/live/productUiV2/source";
import { PRODUCT_V2_SOURCE } from "../../src/live/genlayer";
import { v2TaskState } from "../../src/live/productUiV2/status";
import { parseV2TaskSummary } from "../../src/live/productUiV2/summary";
import { emptyWriteRecord, getV2Write, persistSubmittedV2Write } from "../../src/live/productUiV2/writes";
import { loadProductUiSession, saveProductUiSession, emptyProductUiSession } from "../../src/live/productUi/persist";
import type { ProductV2Task } from "../../src/live/productV2/task";
import { STUDIO_DEV_CHAIN_ID } from "../../src/live/network";
import { clearRememberedGenvmLag } from "../../src/live/product/clock";
import type { TransactionFeeEstimate } from "genlayer-js/types";

const FUNDER = "0x1111111111111111111111111111111111111111";
const TRANSLATOR = "0x2222222222222222222222222222222222222222";
const OTHER = "0x3333333333333333333333333333333333333333";
const TASK_ID = "b".repeat(64);
const SUBMIT = 1_790_001_800;
const RECOVER = 1_790_005_400;
const REWARD = (5n * 10n ** 17n).toString();

function mockStorage() {
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    length: 0,
    key: () => null,
  };
}

function form(): CreateForm {
  return {
    ...emptyCreateForm(),
    sourceText: "On the way",
    appContext: "Checkout status",
    stringKey: "checkout.delivery.on_the_way",
    intendedMeaning: "Package is in transit",
    semanticCriteria: "Keep the status short",
    translator: TRANSLATOR,
    rewardGen: "0.5",
  };
}

function matchedSource(session: ProductUiV2Session = emptyProductUiV2Session()): ProductUiV2Session {
  return {
    ...session,
    sourceMatch: true,
    sourceVerifyStatus: "match",
    sourceVerifyReason: "matched",
    localSourceSha256: PRODUCT_UI_V2_SOURCE_SHA256,
    deployedSourceSha256: PRODUCT_UI_V2_SOURCE_SHA256,
    sourceVerifiedAddress: PRODUCT_UI_V2_CONTRACT,
    sourceVerifiedLocalSha256: PRODUCT_UI_V2_SOURCE_SHA256,
    sourceRecheckedThisLoad: true,
  };
}

function ctx(wallet = FUNDER) {
  return { wallet, chainId: STUDIO_DEV_CHAIN_ID, connected: true };
}

function v2Task(overrides: Partial<ProductV2Task> = {}): ProductV2Task {
  return {
    task_id: TASK_ID,
    funder: FUNDER,
    translator: TRANSLATOR,
    rewardWei: REWARD,
    source_text: "On the way",
    source_locale: "EN-US",
    target_locale: "ES-ES",
    string_key: "checkout.delivery.on_the_way",
    translation: "",
    state: "open",
    decision: "none",
    payment_status: "none",
    payment_kind: "",
    payout_submitted: false,
    submit_by_unix: SUBMIT,
    recover_after_unix: RECOVER,
    submitted_at_unix: 0,
    decided_at_unix: 0,
    recovery_opens_at_unix: RECOVER,
    app_context: "Checkout status",
    intended_meaning: "Package is in transit",
    semantic_criteria: "Keep the status short",
    client_nonce: "nonce-v2",
    accepted_at_unix: 0,
    raw: {},
    ...overrides,
  };
}

function quotedCreate(session: ProductUiV2Session): ProductUiV2Session {
  const filled = form();
  return matchedSource({
    ...session,
    form: filled,
    formFingerprint: formFingerprint(filled),
    boundFunder: FUNDER,
    boundTranslator: TRANSLATOR,
    boundRewardWei: REWARD,
    boundRewardGen: "0.5",
    clientNonce: "nonce-v2",
    expectedTaskId: TASK_ID,
    submitByUnix: SUBMIT,
    recoverAfterUnix: RECOVER,
    create: {
      phase: "quoted",
      quotedValueWei: REWARD,
      quotedFeeWei: "1000",
      quotedBinding: currentV2ProductQuoteBinding({
        wallet: FUNDER,
        chainId: STUDIO_DEV_CHAIN_ID,
        contract: PRODUCT_UI_V2_CONTRACT,
        translator: TRANSLATOR,
        method: "create",
        valueWei: REWARD,
        clientNonce: "nonce-v2",
        submitByUnix: SUBMIT,
        recoverAfterUnix: RECOVER,
        taskId: TASK_ID,
      }),
    },
  });
}

describe("product UI V2 isolation and pins", () => {
  beforeEach(mockStorage);

  it("pins the deployed V2 contract and source SHA and keeps persist keys isolated", () => {
    expect(PRODUCT_UI_V2_CONTRACT).toBe("0x3B06e08182Db177a61B1707f7b5A84834A45F431");
    expect(PRODUCT_UI_V2_SOURCE_SHA256).toBe("3cbb7ff08dca3909b9765ce0467e7ddc8c6ec0d7c104e142c892cfafd169a43d");
    expect(PRODUCT_UI_V2_STORAGE_KEY).toBe("localebounty.product-ui-v2.create.v1");
    expect(PRODUCT_UI_V2_WRITES_STORAGE_KEY).toBe("localebounty.product-ui-v2.writes.v1");
    expect(PRODUCT_UI_V2_STORAGE_KEY).not.toBe(PRODUCT_UI_STORAGE_KEY);
    expect(PRODUCT_UI_V2_WRITES_STORAGE_KEY).not.toBe(PRODUCT_UI_WRITES_STORAGE_KEY);
    expect(PRODUCT_UI_V2_STORAGE_KEY).not.toBe(DEMO_STORAGE_KEY);
    expect(PRODUCT_UI_V2_STORAGE_KEY).not.toBe(PRODUCT_STORAGE_KEY);
    expect(PRODUCT_UI_CONTRACT).toBe("0x84dA80726e8A0c6d451Ca3FF88d7dD47F3b07D96");
  });

  it("keeps V2 routes isolated from V1 and demo, and does not treat the harness as /v2", () => {
    expect(v2BoardHref()).toBe("/v2");
    expect(v2CreateHref()).toBe("/v2/tasks/new");
    expect(v2TaskHref(TASK_ID)).toBe(`/v2/tasks/${TASK_ID}`);
    expect(v2SubmitHref(TASK_ID)).toBe(`/v2/tasks/${TASK_ID}/submit`);
    expect(v2DecisionHref(TASK_ID)).toBe(`/v2/tasks/${TASK_ID}/decision`);
    expect(v2LibraryHref()).toBe("/v2/library");
    expect(liveCreateHref()).toBe("/tasks/new");
    expect(liveTaskHref(TASK_ID)).toBe(`/tasks/${TASK_ID}`);
    expect(isV2ProductPath("/v2")).toBe(true);
    expect(isV2ProductPath("/v2/tasks/new")).toBe(true);
    expect(isV2ProductPath("/live-product-v2")).toBe(false);
    expect(isV2ProductPath("/")).toBe(false);
    expect(isDemoPath("/v2")).toBe(false);
  });

  it("does not share create persist with V1 product UI", () => {
    const v2 = quotedCreate(emptyProductUiV2Session());
    saveProductUiV2Session({ ...v2, create: { ...v2.create, txId: "0xv2create" } });
    saveProductUiSession({ ...emptyProductUiSession(), create: { phase: "idle", txId: "0xv1create" } });
    expect(loadProductUiV2Session().create.txId).toBe("0xv2create");
    expect(loadProductUiSession().create.txId).toBe("0xv1create");
  });
});

describe("V2 deadline, role, and accept-state gates", () => {
  beforeEach(mockStorage);

  it("opens accept only before submit_by_unix and cancel only while open unaccepted", () => {
    const open = v2Task();
    expect(showV2Accept(open, SUBMIT - 1)).toBe(true);
    expect(showV2Accept(open, SUBMIT)).toBe(false);
    expect(showV2Accept(open, SUBMIT + 1)).toBe(false);
    expect(showV2Cancel(open)).toBe(true);
    const accepted = v2Task({ state: "accepted", accepted_at_unix: SUBMIT - 10 });
    expect(showV2Accept(accepted, SUBMIT - 1)).toBe(false);
    expect(showV2Cancel(accepted)).toBe(false);
    expect(v2TaskState("accepted")).toBe("accepted");
    expect(v2TaskState("expired")).toBe("expired");
    expect(liveTaskState("accepted")).toBe("unknown");
  });

  it("allows only the named translator to accept and only the funder to cancel", () => {
    const task = v2Task();
    const idle = emptyWriteRecord({ chainId: STUDIO_DEV_CHAIN_ID, taskId: TASK_ID, action: "accept", wallet: TRANSLATOR });
    expect(acceptEstimateAllowed({ task, record: idle, ctx: ctx(TRANSLATOR), nowUnix: SUBMIT - 1 }).ok).toBe(true);
    const funderAccept = acceptEstimateAllowed({ task, record: idle, ctx: ctx(FUNDER), nowUnix: SUBMIT - 1 });
    expect(funderAccept.ok).toBe(false);
    if (!funderAccept.ok) expect(funderAccept.reason).toMatch(/named translator/i);
    const atDeadline = acceptEstimateAllowed({ task, record: idle, ctx: ctx(TRANSLATOR), nowUnix: SUBMIT });
    expect(atDeadline.ok).toBe(false);
    if (!atDeadline.ok) expect(atDeadline.reason).toMatch(/now < submit_by_unix/);

    const cancelIdle = emptyWriteRecord({ chainId: STUDIO_DEV_CHAIN_ID, taskId: TASK_ID, action: "cancel", wallet: FUNDER });
    expect(cancelEstimateAllowed({ task, record: cancelIdle, ctx: ctx(FUNDER) }).ok).toBe(true);
    const translatorCancel = cancelEstimateAllowed({ task, record: cancelIdle, ctx: ctx(TRANSLATOR) });
    expect(translatorCancel.ok).toBe(false);
    if (!translatorCancel.ok) expect(translatorCancel.reason).toMatch(/funder/i);
    const afterAccept = cancelEstimateAllowed({
      task: v2Task({ state: "accepted", accepted_at_unix: 10 }),
      record: cancelIdle,
      ctx: ctx(FUNDER),
    });
    expect(afterAccept.ok).toBe(false);
  });

  it("requires get_task state=accepted and nonzero accepted_at_unix after accept", () => {
    expect(acceptConfirmStored(v2Task({ state: "open", accepted_at_unix: 0 })).ok).toBe(false);
    expect(acceptConfirmStored(v2Task({ state: "accepted", accepted_at_unix: 0 })).ok).toBe(false);
    expect(acceptConfirmStored(v2Task({ state: "accepted", accepted_at_unix: SUBMIT - 5 })).ok).toBe(true);
  });

  it("allows submit only for the named translator on an accepted task through the inclusive deadline", () => {
    const record = emptyWriteRecord({ chainId: STUDIO_DEV_CHAIN_ID, taskId: TASK_ID, action: "submit", wallet: TRANSLATOR });
    const accepted = v2Task({ state: "accepted", accepted_at_unix: SUBMIT - 30 });
    expect(submitEstimateAllowed({ task: accepted, record, ctx: ctx(TRANSLATOR), translation: "En camino", wallUnix: SUBMIT }).ok).toBe(true);
    const earlyOpen = submitEstimateAllowed({ task: v2Task(), record, ctx: ctx(TRANSLATOR), translation: "En camino", wallUnix: SUBMIT - 1 });
    expect(earlyOpen.ok).toBe(false);
    if (!earlyOpen.ok) expect(earlyOpen.reason).toMatch(/accepted/i);
    const wrongWallet = submitEstimateAllowed({ task: accepted, record, ctx: ctx(FUNDER), translation: "En camino", wallUnix: SUBMIT });
    expect(wrongWallet.ok).toBe(false);
    if (!wrongWallet.ok) expect(wrongWallet.reason).toMatch(/named translator/i);
    const expired = submitEstimateAllowed({ task: accepted, record, ctx: ctx(TRANSLATOR), translation: "En camino", wallUnix: SUBMIT + 1 });
    expect(expired.ok).toBe(false);
    if (!expired.ok) expect(expired.reason).toMatch(/now <= submit_by_unix/);
  });

  it("allows evaluate for any connected wallet only while submitted and undecided", () => {
    const submitted = v2Task({ state: "submitted", translation: "En camino", submitted_at_unix: SUBMIT });
    const record = emptyWriteRecord({ chainId: STUDIO_DEV_CHAIN_ID, taskId: TASK_ID, action: "evaluate", wallet: OTHER });
    expect(evaluateEstimateAllowed({ task: submitted, record, ctx: ctx(OTHER) }).ok).toBe(true);
    const approved = evaluateEstimateAllowed({
      task: v2Task({ state: "approved", decision: "approved", translation: "En camino" }),
      record,
      ctx: ctx(OTHER),
    });
    expect(approved.ok).toBe(false);
    if (!approved.ok) expect(approved.reason).toMatch(/expected submitted|decision/i);
  });

  it("allows expire for open or accepted unsubmitted tasks only after submit_by_unix", () => {
    const record = emptyWriteRecord({ chainId: STUDIO_DEV_CHAIN_ID, taskId: TASK_ID, action: "expire", wallet: OTHER });
    expect(expireEstimateAllowed({ task: v2Task(), record, ctx: ctx(OTHER), wallUnix: SUBMIT + 1 }).ok).toBe(true);
    expect(expireEstimateAllowed({ task: v2Task({ state: "accepted", accepted_at_unix: SUBMIT - 10 }), record, ctx: ctx(OTHER), wallUnix: SUBMIT + 1 }).ok).toBe(true);
    const atDeadline = expireEstimateAllowed({ task: v2Task(), record, ctx: ctx(OTHER), wallUnix: SUBMIT });
    expect(atDeadline.ok).toBe(false);
    if (!atDeadline.ok) expect(atDeadline.reason).toMatch(/now > submit_by_unix/);
    const submitted = expireEstimateAllowed({
      task: v2Task({ state: "submitted", translation: "En camino", submitted_at_unix: SUBMIT }),
      record,
      ctx: ctx(OTHER),
      wallUnix: SUBMIT + 1,
    });
    expect(submitted.ok).toBe(false);
  });

  it("allows recover for submitted undecided tasks after recovery_opens_at_unix", () => {
    const record = emptyWriteRecord({ chainId: STUDIO_DEV_CHAIN_ID, taskId: TASK_ID, action: "recover", wallet: OTHER });
    const submitted = v2Task({ state: "submitted", translation: "En camino", submitted_at_unix: SUBMIT, recovery_opens_at_unix: RECOVER });
    const early = recoverEstimateAllowed({ task: submitted, record, ctx: ctx(OTHER), wallUnix: RECOVER - 1 });
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.reason).toMatch(/recovery_opens_at_unix/);
    expect(recoverEstimateAllowed({ task: submitted, record, ctx: ctx(OTHER), wallUnix: RECOVER }).ok).toBe(true);
    const decided = recoverEstimateAllowed({
      task: v2Task({ state: "rejected", decision: "rejected", translation: "En camino" }),
      record,
      ctx: ctx(OTHER),
      wallUnix: RECOVER,
    });
    expect(decided.ok).toBe(false);
  });

  it("does not let a remembered GenVM quote clock open recover before the signing boundary", () => {
    const record = emptyWriteRecord({ chainId: STUDIO_DEV_CHAIN_ID, taskId: TASK_ID, action: "recover", wallet: OTHER });
    const submitted = v2Task({ state: "submitted", translation: "En camino", submitted_at_unix: SUBMIT, recovery_opens_at_unix: RECOVER });
    const early = recoverEstimateAllowed({
      task: submitted,
      record: { ...record, rememberedGenvmUnix: RECOVER + 30 },
      ctx: ctx(OTHER),
      wallUnix: RECOVER - 1,
      genvmUnix: RECOVER + 30,
    });
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.reason).toMatch(/remembered quote clock never opens recovery early/i);
  });
});

describe("V2 quotes, persisted tx IDs, and resume", () => {
  beforeEach(() => {
    mockStorage();
    clearRememberedGenvmLag();
    setLastQuotedCreateEstimateForTests(undefined);
  });

  it("blocks create until the pinned source match is bound", () => {
    const session = emptyProductUiV2Session();
    const source = sourceAllowsV2ProductCreate(session);
    expect(source.ok).toBe(false);
    const estimate = createEstimateAllowed(session, ctx(), form());
    expect(estimate.ok).toBe(false);
    expect(createEstimateAllowed(matchedSource(session), ctx(), form()).ok).toBe(true);
  });

  it("invalidates a stale fee quote when wallet, method, value, nonce, or deadlines change", () => {
    const stored = currentV2ProductQuoteBinding({
      wallet: FUNDER,
      chainId: STUDIO_DEV_CHAIN_ID,
      contract: PRODUCT_UI_V2_CONTRACT,
      translator: TRANSLATOR,
      method: "create",
      valueWei: REWARD,
      clientNonce: "nonce-v2",
      submitByUnix: SUBMIT,
      recoverAfterUnix: RECOVER,
      taskId: TASK_ID,
    });
    expect(
      v2ProductQuoteStillValid(
        stored,
        currentV2ProductQuoteBinding({
          wallet: OTHER,
          chainId: STUDIO_DEV_CHAIN_ID,
          contract: PRODUCT_UI_V2_CONTRACT,
          translator: TRANSLATOR,
          method: "create",
          valueWei: REWARD,
          clientNonce: "nonce-v2",
          submitByUnix: SUBMIT,
          recoverAfterUnix: RECOVER,
          taskId: TASK_ID,
        }),
      ),
    ).toBe(false);
    expect(
      v2ProductQuoteStillValid(
        stored,
        currentV2ProductQuoteBinding({
          wallet: FUNDER,
          chainId: STUDIO_DEV_CHAIN_ID,
          contract: PRODUCT_UI_V2_CONTRACT,
          translator: TRANSLATOR,
          method: "create",
          valueWei: REWARD,
          clientNonce: "nonce-other",
          submitByUnix: SUBMIT,
          recoverAfterUnix: RECOVER,
          taskId: TASK_ID,
        }),
      ),
    ).toBe(false);
    const acceptStored = currentV2ProductQuoteBinding({
      wallet: TRANSLATOR,
      chainId: STUDIO_DEV_CHAIN_ID,
      contract: PRODUCT_UI_V2_CONTRACT,
      translator: TRANSLATOR,
      method: "accept",
      valueWei: "0",
      taskId: TASK_ID,
    });
    expect(
      v2ProductQuoteStillValid(
        acceptStored,
        currentV2ProductQuoteBinding({
          wallet: TRANSLATOR,
          chainId: STUDIO_DEV_CHAIN_ID,
          contract: PRODUCT_UI_V2_CONTRACT,
          translator: TRANSLATOR,
          method: "accept",
          valueWei: "0",
          taskId: "c".repeat(64),
        }),
      ),
    ).toBe(false);
  });

  it("persists a create tx ID immediately and resumes without resubmit", () => {
    const quoted = quotedCreate(emptyProductUiV2Session());
    saveProductUiV2Session({ ...quoted, create: { ...quoted.create, txId: "0xabc", phase: "submitted" } });
    const loaded = loadProductUiV2Session();
    expect(loaded.create.txId).toBe("0xabc");
    expect(neverResubmit(loaded.create)).toBe("resume");
    expect(needsCreateTxResume(loaded)).toBe(true);
    expect(createEstimateAllowed(loaded, ctx(), form()).ok).toBe(false);
    expect(createSignAllowed(loaded, ctx(), form()).ok).toBe(false);
  });

  it("resets unsubmitted quoting phases on reload and keeps a submitted hash", () => {
    saveProductUiV2Session({
      ...quotedCreate(emptyProductUiV2Session()),
      create: { phase: "quoting" },
    });
    expect(loadProductUiV2Session().create.phase).toBe("idle");
    saveProductUiV2Session({
      ...quotedCreate(emptyProductUiV2Session()),
      create: { phase: "waiting", txId: "0xkeep" },
    });
    expect(loadProductUiV2Session().create.txId).toBe("0xkeep");
    expect(loadProductUiV2Session().create.phase).toBe("waiting");
  });

  it("navigates only after FINALIZED successful execution and matching get_task", () => {
    const base = quotedCreate(emptyProductUiV2Session());
    const pending = { ...base, create: { ...base.create, txId: "0xcreate", statusName: "PENDING" as const } };
    expect(createNavigateReady(pending).ok).toBe(false);
    const failed = {
      ...base,
      create: { ...base.create, txId: "0xcreate", statusName: "FINALIZED" as const, parentSuccessful: false },
    };
    const failedReady = createNavigateReady(failed);
    expect(failedReady.ok).toBe(false);
    if (!failedReady.ok) expect(failedReady.reason).toMatch(/Not navigating/);
    const ready = createNavigateReady({
      ...base,
      create: { ...base.create, txId: "0xcreate", statusName: "FINALIZED", parentSuccessful: true },
      createTask: v2Task(),
    });
    expect(ready).toEqual({ ok: true, taskId: TASK_ID });
  });

  it("requires the in-memory fee quote before create sign", () => {
    const session = quotedCreate(emptyProductUiV2Session());
    const blocked = signCreateBlocker({ session, form: form(), identity: { address: FUNDER as `0x${string}`, chainId: STUDIO_DEV_CHAIN_ID } });
    expect(blocked.ok).toBe(false);
    setLastQuotedCreateEstimateForTests({ feeValue: 1000n } as TransactionFeeEstimate);
    const allowed = signCreateBlocker({
      session,
      form: form(),
      identity: { address: FUNDER as `0x${string}`, chainId: STUDIO_DEV_CHAIN_ID },
    });
    expect(allowed.ok).toBe(true);
  });

  it("persists accept/cancel tx IDs in the isolated writes store and resumes", () => {
    const record = emptyWriteRecord({
      chainId: STUDIO_DEV_CHAIN_ID,
      taskId: TASK_ID,
      action: "accept",
      wallet: TRANSLATOR,
    });
    persistSubmittedV2Write(record, "0xaccept");
    const loaded = getV2Write({
      chainId: STUDIO_DEV_CHAIN_ID,
      taskId: TASK_ID,
      action: "accept",
      wallet: TRANSLATOR,
    });
    expect(loaded.txId).toBe("0xaccept");
    expect(neverResubmit(loaded)).toBe("resume");
    expect(localStorage.getItem(PRODUCT_UI_V2_WRITES_STORAGE_KEY)).toContain("0xaccept");
    expect(localStorage.getItem(PRODUCT_UI_WRITES_STORAGE_KEY)).toBeNull();
  });

  it("does not start a new create while a pending hash exists", () => {
    const pending = {
      ...quotedCreate(emptyProductUiV2Session()),
      create: { phase: "waiting" as const, txId: "0xpending" },
    };
    const next = startNewV2CreateAttempt(pending);
    expect(next.create.txId).toBe("0xpending");
  });

  it("keeps accepted_at_unix on compact list_tasks rows", () => {
    const parsed = parseV2TaskSummary({
      task_id: TASK_ID,
      funder: FUNDER,
      translator: TRANSLATOR,
      reward: REWARD,
      source_locale: "EN-US",
      target_locale: "ES-ES",
      string_key: "checkout.delivery.on_the_way",
      state: "accepted",
      decision: "none",
      accepted_at_unix: 123,
    });
    expect(parsed?.state).toBe("accepted");
    expect(parsed?.accepted_at_unix).toBe(123);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe("V2 create reload source and tracking race", () => {
  beforeEach(mockStorage);

  function pendingCreate() {
    const session = quotedCreate(emptyProductUiV2Session());
    return {
      ...session,
      create: { ...session.create, phase: "waiting" as const, txId: "0xpending", statusName: "PENDING" },
      createAttemptHistory: [{ txId: "0xolder", archivedAt: 1, action: "create" as const }],
    };
  }

  it.each(["source first", "tracking first"])("preserves the latest create and source fields when %s finishes", async (order) => {
    const saved = pendingCreate();
    saveProductUiV2Session(saved);
    persistV2SourceFields(pendingV2SourceFields());
    const code = deferred<unknown>();
    const tracking = deferred<void>();
    const verified = verifyV2ProductSource(saved, { getContractCode: () => code.promise });
    const tracked = tracking.promise.then(() => persistV2CreateTracking({
      create: { ...saved.create, phase: "waiting", statusName: "ACCEPTED" },
      createTask: v2Task(),
      navigatedTaskId: TASK_ID,
    }));
    if (order === "source first") {
      code.resolve(PRODUCT_V2_SOURCE);
      await verified;
      tracking.resolve();
      await tracked;
    } else {
      tracking.resolve();
      await tracked;
      code.resolve(PRODUCT_V2_SOURCE);
      await verified;
    }
    const latest = loadProductUiV2Session();
    expect(latest.create.txId).toBe("0xpending");
    expect(latest.create.statusName).toBe("ACCEPTED");
    expect(latest.boundRewardWei).toBe(REWARD);
    expect(latest.clientNonce).toBe("nonce-v2");
    expect(latest.submitByUnix).toBe(SUBMIT);
    expect(latest.recoverAfterUnix).toBe(RECOVER);
    expect(latest.expectedTaskId).toBe(TASK_ID);
    expect(latest.createTask?.task_id).toBe(TASK_ID);
    expect(latest.createAttemptHistory?.[0]?.txId).toBe("0xolder");
    expect(latest.sourceMatch).toBe(true);
    expect(latest.deployedSourceSha256).toBe(PRODUCT_UI_V2_SOURCE_SHA256);
  });

  it("keeps writes blocked after a failed RPC source check", async () => {
    saveProductUiV2Session(matchedSource(quotedCreate(emptyProductUiV2Session())));
    const loaded = loadProductUiV2Session();
    expect(sourceAllowsV2ProductCreate(loaded).ok).toBe(false);
    persistV2SourceFields(pendingV2SourceFields());
    const code = deferred<unknown>();
    const requested = deferred<void>();
    const check = verifyV2ProductSource(loaded, { getContractCode: () => {
      requested.resolve();
      return code.promise;
    } });
    expect(sourceAllowsV2ProductCreate(loadProductUiV2Session()).ok).toBe(false);
    await requested.promise;
    code.reject(new Error("RPC unavailable"));
    const result = await check;
    expect(result.sourceVerifyStatus).toBe("UNPROVEN");
    expect(result.sourceVerifyReason).toContain("RPC unavailable");
    expect(sourceAllowsV2ProductCreate(result).ok).toBe(false);
  });

  it("resumes an existing pending hash while source verification is pending", async () => {
    saveProductUiV2Session(matchedSource(pendingCreate()));
    const reloaded = loadProductUiV2Session();
    expect(sourceAllowsV2ProductCreate(reloaded).ok).toBe(false);
    expect(needsCreateTxResume(reloaded)).toBe(true);
    expect(neverResubmit(reloaded.create)).toBe("resume");
    persistV2SourceFields(pendingV2SourceFields());
    const code = deferred<unknown>();
    const check = verifyV2ProductSource(reloaded, { getContractCode: () => code.promise });
    persistV2CreateTracking({ create: { ...reloaded.create, statusName: "ACCEPTED" } });
    expect(loadProductUiV2Session().create.txId).toBe("0xpending");
    expect(loadProductUiV2Session().sourceMatch).toBe(false);
    code.resolve(PRODUCT_V2_SOURCE);
    await check;
    expect(loadProductUiV2Session().create.statusName).toBe("ACCEPTED");
  });
});
