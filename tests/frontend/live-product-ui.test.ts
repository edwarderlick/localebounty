import { beforeEach, describe, expect, it } from "vitest";
import { STORAGE_KEY as DEMO_STORAGE_KEY } from "../../src/data/demoStore";
import { demoHref, isDemoPath, liveDecisionHref, liveLibraryHref, liveSubmitHref, liveTaskHref } from "../../src/lib/paths";
import { PAYOUT_SUBMITTED_IS_NOT_PAYMENT } from "../../src/live/product/evidence";
import { createdTaskMatchesBound, genToWei, parseProductTask } from "../../src/live/product/task";
import { PRODUCT_STORAGE_KEY } from "../../src/live/product/constants";
import { PRODUCT_UI_CONTRACT, PRODUCT_UI_SOURCE_SHA256, PRODUCT_UI_STORAGE_KEY, LIST_PAGE_LIMIT } from "../../src/live/productUi/constants";
import { createNavigateReady } from "../../src/live/productUi/createFlow";
import { createFormErrors, emptyCreateForm, expectedWalletSpendWei, formFingerprint } from "../../src/live/productUi/form";
import { createEstimateAllowed, createSignAllowed, neverResubmit } from "../../src/live/productUi/guards";
import {
  emptyProductUiSession,
  loadProductUiSession,
  saveProductUiSession,
  startNewCreateAttempt,
} from "../../src/live/productUi/persist";
import { paymentDeliveryView } from "../../src/live/productUi/status";
import {
  belongsToWallet,
  clampListLimit,
  newestPageOffset,
  parseTaskSummary,
  parseTaskSummaryList,
  type LiveTaskSummary,
} from "../../src/live/productUi/summary";

const FUNDER = "0x1111111111111111111111111111111111111111";
const TRANSLATOR = "0x2222222222222222222222222222222222222222";
const TASK_ID = "a".repeat(64);

function summary(overrides: Partial<LiveTaskSummary> = {}): LiveTaskSummary {
  return {
    task_id: TASK_ID,
    funder: FUNDER,
    translator: TRANSLATOR,
    rewardWei: (10n ** 18n).toString(),
    source_locale: "EN-US",
    target_locale: "ES-ES",
    string_key: "checkout.cta",
    state: "open",
    decision: "none",
    payment_status: "none",
    payment_kind: "",
    payout_submitted: false,
    created_at_unix: 1_790_000_000,
    submit_by_unix: 1_790_001_800,
    recover_after_unix: 1_790_005_400,
    submitted_at_unix: 0,
    decided_at_unix: 0,
    recovery_opens_at_unix: 1_790_005_400,
    client_nonce: "nonce-1",
    ...overrides,
  };
}

describe("live product UI adapter", () => {
  beforeEach(() => {
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
  });

  it("pins the deployed contract and source SHA and keeps persist keys isolated", () => {
    expect(PRODUCT_UI_CONTRACT).toBe("0x84dA80726e8A0c6d451Ca3FF88d7dD47F3b07D96");
    expect(PRODUCT_UI_SOURCE_SHA256).toBe("6db9fb8027453d0f82d24c978b90c0c3dd81ab9674ab8590766d6beeeb28c93f");
    expect(PRODUCT_UI_STORAGE_KEY).toBe("localebounty.product-ui.create.v1");
    expect(PRODUCT_UI_STORAGE_KEY).not.toBe(DEMO_STORAGE_KEY);
    expect(PRODUCT_UI_STORAGE_KEY).not.toBe(PRODUCT_STORAGE_KEY);
    expect(PRODUCT_UI_STORAGE_KEY).not.toBe("localebounty.live-product-b1.v1");
    expect(PRODUCT_UI_STORAGE_KEY).not.toBe("localebounty.live-product-b2.v1");
    expect(PRODUCT_UI_STORAGE_KEY).not.toBe("localebounty.live-product-timeout.v1");
  });

  it("parses compact list_tasks rows without requiring source_text", () => {
    const parsed = parseTaskSummary({
      task_id: TASK_ID,
      funder: FUNDER,
      translator: TRANSLATOR,
      reward: "500000000000000000",
      source_locale: "EN-US",
      target_locale: "JA-JP",
      string_key: "nav.home",
      state: "submitted",
      decision: "none",
      payment_status: "none",
      payout_submitted: false,
    });
    expect(parsed?.string_key).toBe("nav.home");
    expect(parsed?.rewardWei).toBe("500000000000000000");
    expect((parsed as LiveTaskSummary & { source_text?: string }).source_text).toBeUndefined();
    expect(parseTaskSummaryList([{ bad: true }, parsed]).map((row) => row.task_id)).toEqual([TASK_ID]);
  });

  it("caps list_tasks pages at 50 and pages newest-first from task_count", () => {
    expect(clampListLimit(200)).toBe(LIST_PAGE_LIMIT);
    expect(clampListLimit(0)).toBe(1);
    expect(newestPageOffset(120, 50, 0)).toBe(70);
    expect(newestPageOffset(120, 50, 1)).toBe(20);
    expect(newestPageOffset(120, 50, 2)).toBe(0);
    expect(newestPageOffset(0, 50, 0)).toBe(0);
  });

  it("filters My tasks by the connected wallet as funder or translator", () => {
    const mine = summary();
    expect(belongsToWallet(mine, FUNDER)).toBe(true);
    expect(belongsToWallet(mine, TRANSLATOR)).toBe(true);
    expect(belongsToWallet(mine, "0x3333333333333333333333333333333333333333")).toBe(false);
    expect(belongsToWallet(mine, undefined)).toBe(false);
  });

  it("never labels payout_submitted as paid", () => {
    const view = paymentDeliveryView({
      payment_status: "submitted",
      payment_kind: "payout",
      payout_submitted: true,
    });
    expect(view.paid).toBe(false);
    expect(view.label.toLowerCase()).not.toContain("paid");
    expect(view.hint).toContain(PAYOUT_SUBMITTED_IS_NOT_PAYMENT);
  });

  it("keeps demo routes under /demo and live detail on /tasks/:id", () => {
    expect(isDemoPath("/demo")).toBe(true);
    expect(isDemoPath("/demo/tasks/abc")).toBe(true);
    expect(isDemoPath("/")).toBe(false);
    expect(isDemoPath("/tasks/new")).toBe(false);
    expect(demoHref("/tasks/abc/submit")).toBe("/demo/tasks/abc/submit");
    expect(liveTaskHref(TASK_ID)).toBe(`/tasks/${TASK_ID}`);
    expect(liveSubmitHref(TASK_ID)).toBe(`/tasks/${TASK_ID}/submit`);
    expect(liveDecisionHref(TASK_ID)).toBe(`/tasks/${TASK_ID}/decision`);
    expect(liveLibraryHref()).toBe("/library");
  });

  it("accepts any valid named translator EOA and exact 18-decimal GEN", () => {
    const form = {
      ...emptyCreateForm(),
      sourceText: "Pay now",
      intendedMeaning: "Checkout CTA",
      semanticCriteria: "Keep it short",
      stringKey: "pay.now",
      translator: TRANSLATOR,
      rewardGen: "0.500000000000000001",
    };
    expect(createFormErrors(form, FUNDER)).toEqual([]);
    expect(genToWei(form.rewardGen)).toBe(500000000000000001n);
    expect(createFormErrors({ ...form, translator: FUNDER }, FUNDER).some((e) => /different EOA/i.test(e))).toBe(true);
    expect(createFormErrors({ ...form, rewardGen: "1.0000000000000000001" }).some((e) => /18 fractional/i.test(e))).toBe(
      true,
    );
  });

  it("shows attached reward, fee deposit, and expected spend as separate figures", () => {
    const reward = 5n * 10n ** 17n;
    const fee = 8n * 10n ** 16n;
    expect(expectedWalletSpendWei(reward, fee)).toBe(reward + fee);
  });

  it("persists a create tx ID and refuses to resubmit it after reload", () => {
    const session = emptyProductUiSession();
    session.create = { phase: "waiting", txId: `0x${"ab".repeat(32)}` };
    saveProductUiSession(session);
    const loaded = loadProductUiSession();
    expect(loaded.create.txId).toBe(session.create.txId);
    expect(neverResubmit(loaded.create)).toBe("resume");
    const next = startNewCreateAttempt({
      ...loaded,
      create: { ...loaded.create, statusName: "FINALIZED", parentSuccessful: true, phase: "success" },
    });
    expect(next.create.txId).toBeUndefined();
    expect(next.createAttemptHistory?.map((item) => item.txId)).toEqual([session.create.txId]);
    expect(neverResubmit({ txId: next.createAttemptHistory?.[0]?.txId })).toBe("resume");
    expect(localStorage.getItem(DEMO_STORAGE_KEY)).toBeNull();
  });

  it("navigates only after FINALIZED successful execution and exact get_task match", () => {
    const nonce = "ui-nonce";
    const reward = (10n ** 18n).toString();
    const task = parseProductTask({
      task_id: TASK_ID,
      funder: FUNDER,
      translator: TRANSLATOR,
      reward,
      source_text: "Hi",
      source_locale: "EN-US",
      target_locale: "ES-ES",
      string_key: "hi",
      translation: "",
      state: "open",
      decision: "none",
      payment_status: "none",
      payment_kind: "",
      payout_submitted: false,
      submit_by_unix: 100,
      recover_after_unix: 3700,
      client_nonce: nonce,
    });
    expect(
      createdTaskMatchesBound({
        task,
        funder: FUNDER,
        translator: TRANSLATOR,
        rewardWei: reward,
        clientNonce: nonce,
        expectedTaskId: TASK_ID,
        submitByUnix: 100,
        recoverAfterUnix: 3700,
      }).ok,
    ).toBe(true);
    const incomplete = emptyProductUiSession();
    incomplete.create = { phase: "waiting", txId: `0x${"cd".repeat(32)}`, statusName: "ACCEPTED", parentSuccessful: true };
    expect(createNavigateReady(incomplete).ok).toBe(false);
    const ready = emptyProductUiSession();
    ready.create = {
      phase: "success",
      txId: `0x${"cd".repeat(32)}`,
      statusName: "FINALIZED",
      parentSuccessful: true,
    };
    ready.createTask = task;
    ready.boundFunder = FUNDER;
    ready.boundTranslator = TRANSLATOR;
    ready.boundRewardWei = reward;
    ready.clientNonce = nonce;
    ready.expectedTaskId = TASK_ID;
    ready.submitByUnix = 100;
    ready.recoverAfterUnix = 3700;
    expect(createNavigateReady(ready)).toEqual({ ok: true, taskId: TASK_ID });
    const failed = { ...ready, create: { ...ready.create, parentSuccessful: false } };
    expect(createNavigateReady(failed).ok).toBe(false);
  });

  it("requires a quote bound to the current form before sign", () => {
    const form = {
      ...emptyCreateForm(),
      sourceText: "Pay now",
      intendedMeaning: "Checkout CTA",
      semanticCriteria: "Keep it short",
      stringKey: "pay.now",
      translator: TRANSLATOR,
      rewardGen: "0.5",
    };
    const ctx = { funder: FUNDER, chainId: 61997, connected: true };
    const session = emptyProductUiSession();
    expect(createEstimateAllowed(session, ctx, form).ok).toBe(true);
    expect(createSignAllowed(session, ctx, form).ok).toBe(false);
    const quoted = {
      ...session,
      clientNonce: "n1",
      expectedTaskId: TASK_ID,
      submitByUnix: 2_000_000_000,
      recoverAfterUnix: 2_000_003_600,
      formFingerprint: formFingerprint(form),
    };
    expect(createSignAllowed(quoted, ctx, form).ok).toBe(true);
    expect(createSignAllowed(quoted, ctx, { ...form, sourceText: "changed" }).ok).toBe(false);
  });
});
