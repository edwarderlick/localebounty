import { beforeEach, describe, expect, it } from "vitest";
import { STORAGE_KEY as DEMO_STORAGE_KEY } from "../../src/data/demoStore";
import { PAYOUT_SUBMITTED_IS_NOT_PAYMENT } from "../../src/live/product/evidence";
import { parseProductTask, type ProductTask } from "../../src/live/product/task";
import { PRODUCT_STORAGE_KEY } from "../../src/live/product/constants";
import {
  BALANCE_PROOF_UNAVAILABLE,
  PRODUCT_UI_CONTRACT,
  PRODUCT_UI_STORAGE_KEY,
  PRODUCT_UI_WRITES_STORAGE_KEY,
  STATE_OPEN,
  STATE_SUBMITTED,
} from "../../src/live/productUi/constants";
import { approvedSummaryIsNotLibraryEntry } from "../../src/live/productUi/libraryDiscover";
import { liveEvaluateSettlement } from "../../src/live/productUi/settlement";
import { paymentDeliveryView } from "../../src/live/productUi/status";
import type { LiveTaskSummary } from "../../src/live/productUi/summary";
import {
  evaluateEstimateAllowed,
  failedEvaluateStillSubmitted,
  isNamedTranslator,
  neverResubmit,
  submitEstimateAllowed,
  submitSignAllowed,
  submitWindowOpen,
} from "../../src/live/productUi/writeGuards";
import { currentWriteQuoteBinding, writeQuoteStillValid } from "../../src/live/productUi/writeQuotes";
import {
  emptyWriteRecord,
  getWrite,
  productUiWriteKey,
  putWrite,
  retryFailedWrite,
} from "../../src/live/productUi/writes";

const FUNDER = "0x1111111111111111111111111111111111111111";
const TRANSLATOR = "0x2222222222222222222222222222222222222222";
const OTHER = "0x3333333333333333333333333333333333333333";
const TASK_ID = "a".repeat(64);
const CHAIN = 61997;

function task(overrides: Record<string, unknown> = {}): ProductTask {
  const parsed = parseProductTask({
    task_id: TASK_ID,
    funder: FUNDER,
    translator: TRANSLATOR,
    reward: (10n ** 18n).toString(),
    source_text: "Pay now",
    source_locale: "EN-US",
    target_locale: "ES-ES",
    string_key: "pay.now",
    translation: "",
    state: STATE_OPEN,
    decision: "none",
    payment_status: "none",
    payment_kind: "",
    payout_submitted: false,
    submit_by_unix: 2_000_000_000,
    recover_after_unix: 2_000_003_600,
    client_nonce: "n1",
    app_context: "Checkout",
    intended_meaning: "CTA",
    semantic_criteria: "Keep it short",
    ...overrides,
  });
  if (!parsed) throw new Error("fixture task failed to parse");
  return parsed;
}

function submitRecord(wallet = TRANSLATOR) {
  return emptyWriteRecord({
    chainId: CHAIN,
    contract: PRODUCT_UI_CONTRACT,
    taskId: TASK_ID,
    action: "submit",
    wallet,
  });
}

function evaluateRecord(wallet = OTHER) {
  return emptyWriteRecord({
    chainId: CHAIN,
    contract: PRODUCT_UI_CONTRACT,
    taskId: TASK_ID,
    action: "evaluate",
    wallet,
  });
}

describe("live product UI submit/evaluate/library", () => {
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

  it("keeps write persist isolated from create, demo, and harness keys", () => {
    expect(PRODUCT_UI_WRITES_STORAGE_KEY).toBe("localebounty.product-ui.writes.v1");
    expect(PRODUCT_UI_WRITES_STORAGE_KEY).not.toBe(PRODUCT_UI_STORAGE_KEY);
    expect(PRODUCT_UI_WRITES_STORAGE_KEY).not.toBe(DEMO_STORAGE_KEY);
    expect(PRODUCT_UI_WRITES_STORAGE_KEY).not.toBe(PRODUCT_STORAGE_KEY);
    expect(PRODUCT_UI_WRITES_STORAGE_KEY).not.toBe("localebounty.live-product-b1.v1");
    expect(PRODUCT_UI_WRITES_STORAGE_KEY).not.toBe("localebounty.live-product-b2.v1");
    expect(PRODUCT_UI_WRITES_STORAGE_KEY).not.toBe("localebounty.live-product-timeout.v1");
  });

  it("isolates write tracking by chain, contract, task, action, and wallet", () => {
    const translatorSubmit = productUiWriteKey({
      chainId: CHAIN,
      contract: PRODUCT_UI_CONTRACT,
      taskId: TASK_ID,
      action: "submit",
      wallet: TRANSLATOR,
    });
    const otherSubmit = productUiWriteKey({
      chainId: CHAIN,
      contract: PRODUCT_UI_CONTRACT,
      taskId: TASK_ID,
      action: "submit",
      wallet: OTHER,
    });
    const sameTaskEvaluate = productUiWriteKey({
      chainId: CHAIN,
      contract: PRODUCT_UI_CONTRACT,
      taskId: TASK_ID,
      action: "evaluate",
      wallet: TRANSLATOR,
    });
    expect(translatorSubmit).not.toBe(otherSubmit);
    expect(translatorSubmit).not.toBe(sameTaskEvaluate);

    putWrite({
      ...submitRecord(TRANSLATOR),
      txId: `0x${"ab".repeat(32)}`,
      phase: "waiting",
    });
    const otherView = getWrite({
      chainId: CHAIN,
      contract: PRODUCT_UI_CONTRACT,
      taskId: TASK_ID,
      action: "submit",
      wallet: OTHER,
    });
    expect(otherView.txId).toBeUndefined();
    expect(neverResubmit(otherView)).toBe("submit");
    const namedView = getWrite({
      chainId: CHAIN,
      contract: PRODUCT_UI_CONTRACT,
      taskId: TASK_ID,
      action: "submit",
      wallet: TRANSLATOR,
    });
    expect(namedView.txId).toBe(`0x${"ab".repeat(32)}`);
    expect(neverResubmit(namedView)).toBe("resume");
  });

  it("allows only the named translator to estimate submit_translation", () => {
    const open = task();
    expect(isNamedTranslator(open, TRANSLATOR)).toBe(true);
    expect(isNamedTranslator(open, FUNDER)).toBe(false);
    const ok = submitEstimateAllowed({
      task: open,
      record: submitRecord(),
      ctx: { wallet: TRANSLATOR, chainId: CHAIN, connected: true },
      translation: "Paga ahora",
      wallUnix: 1_999_999_000,
    });
    expect(ok).toEqual({ ok: true });
    const other = submitEstimateAllowed({
      task: open,
      record: submitRecord(FUNDER),
      ctx: { wallet: FUNDER, chainId: CHAIN, connected: true },
      translation: "Paga ahora",
      wallUnix: 1_999_999_000,
    });
    expect(other.ok).toBe(false);
    if (other.ok) throw new Error("expected fail");
    expect(other.reason).toMatch(/named translator/i);
  });

  it("requires an open task, empty translation, and unexpired window before submit", () => {
    const expired = submitWindowOpen(task({ submit_by_unix: 10 }), 11, 12);
    expect(expired.ok).toBe(false);
    const wallOk = submitWindowOpen(task({ submit_by_unix: 10 }), 10, 99);
    expect(wallOk.ok).toBe(true);
    const laggingGenvm = submitWindowOpen(task({ submit_by_unix: 10 }), 50, 9);
    expect(laggingGenvm.ok).toBe(false);
    if (laggingGenvm.ok) throw new Error("expected fail");
    expect(laggingGenvm.reason).toMatch(/execution clock/);
    expect(laggingGenvm.reason).toMatch(/does not reopen signing/);

    const stored = submitEstimateAllowed({
      task: task({ translation: "already" }),
      record: submitRecord(),
      ctx: { wallet: TRANSLATOR, chainId: CHAIN, connected: true },
      translation: "Paga ahora",
      wallUnix: 1_999_999_000,
    });
    expect(stored.ok).toBe(false);

    const submittedState = submitEstimateAllowed({
      task: task({ state: STATE_SUBMITTED, translation: "Paga ahora" }),
      record: submitRecord(),
      ctx: { wallet: TRANSLATOR, chainId: CHAIN, connected: true },
      translation: "Paga ahora",
      wallUnix: 1_999_999_000,
    });
    expect(submittedState.ok).toBe(false);
  });

  it("rebinds submit quotes when translation text changes", () => {
    const stored = currentWriteQuoteBinding({
      wallet: TRANSLATOR,
      chainId: CHAIN,
      contract: PRODUCT_UI_CONTRACT,
      method: "submit",
      valueWei: "0",
      taskId: TASK_ID,
      translation: "Uno",
    });
    const changed = currentWriteQuoteBinding({
      wallet: TRANSLATOR,
      chainId: CHAIN,
      contract: PRODUCT_UI_CONTRACT,
      method: "submit",
      valueWei: "0",
      taskId: TASK_ID,
      translation: "Dos",
    });
    expect(writeQuoteStillValid(stored, changed)).toBe(false);
    const sign = submitSignAllowed({
      task: task(),
      record: { ...submitRecord(), boundTranslation: "Uno", quotedFeeWei: "1" },
      ctx: { wallet: TRANSLATOR, chainId: CHAIN, connected: true },
      translation: "Dos",
      wallUnix: 1_999_999_000,
    });
    expect(sign.ok).toBe(false);
  });

  it("lets any connected Studio-dev wallet estimate evaluate_task", () => {
    const submitted = task({
      state: STATE_SUBMITTED,
      translation: "Paga ahora",
    });
    const funder = evaluateEstimateAllowed({
      task: submitted,
      record: evaluateRecord(FUNDER),
      ctx: { wallet: FUNDER, chainId: CHAIN, connected: true },
    });
    const stranger = evaluateEstimateAllowed({
      task: submitted,
      record: evaluateRecord(OTHER),
      ctx: { wallet: OTHER, chainId: CHAIN, connected: true },
    });
    expect(funder).toEqual({ ok: true });
    expect(stranger).toEqual({ ok: true });
  });

  it("keeps a submitted task retryable after a failed evaluate hash", () => {
    const submitted = task({ state: STATE_SUBMITTED, translation: "Paga ahora" });
    const failed = {
      ...evaluateRecord(OTHER),
      txId: `0x${"cd".repeat(32)}`,
      statusName: "FINALIZED" as const,
      parentSuccessful: false,
      phase: "failed" as const,
    };
    expect(failedEvaluateStillSubmitted(submitted, failed)).toBe(true);
    const blocked = evaluateEstimateAllowed({
      task: submitted,
      record: failed,
      ctx: { wallet: OTHER, chainId: CHAIN, connected: true },
    });
    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error("expected fail");
    expect(blocked.reason).toMatch(/New attempt/);
    const retry = retryFailedWrite(failed);
    expect(retry.txId).toBeUndefined();
    expect(neverResubmit(retry)).toBe("submit");
    expect(retry.attemptHistory?.map((item) => item.txId)).toEqual([failed.txId]);
    expect(retry.attemptHistory?.[0]?.parentSuccessful).toBe(false);
    const allowed = evaluateEstimateAllowed({
      task: submitted,
      record: retry,
      ctx: { wallet: OTHER, chainId: CHAIN, connected: true },
    });
    expect(allowed).toEqual({ ok: true });
  });

  it("never treats payout_submitted as paid and withholds invented balance proof", () => {
    const approved = task({
      state: "approved",
      decision: "approved",
      payment_kind: "payout",
      payment_status: "submitted",
      payout_submitted: true,
      translation: "Paga ahora",
    });
    const view = paymentDeliveryView(approved);
    expect(view.paid).toBe(false);
    expect(view.label.toLowerCase()).not.toContain("paid");
    const settled = liveEvaluateSettlement({
      task: approved,
      record: {
        ...evaluateRecord(OTHER),
        txId: `0x${"ef".repeat(32)}`,
        statusName: "FINALIZED",
        executionName: "FINISHED_WITH_RETURN",
        parentSuccessful: true,
        phase: "success",
      },
    });
    expect(settled.balanceEvidence).toBe(BALANCE_PROOF_UNAVAILABLE);
    expect(settled.paymentEvidence).toBe("UNPROVEN");
    expect(settled.outgoingEthSend).toMatch(/UNPROVEN/);
    expect(settled.childCredit).toMatch(/UNPROVEN/);
    expect(settled.paymentReason).toMatch(/Outgoing EthSend and matching child/);
    expect(settled.transferDelivery).toContain(PAYOUT_SUBMITTED_IS_NOT_PAYMENT);
    expect(`${settled.transactionStatus} ${settled.execution} ${settled.contractDecision}`.toLowerCase()).not.toMatch(
      /\bpaid\b/,
    );
  });

  it("does not treat rejected compact summaries as library entries", () => {
    const rejected: LiveTaskSummary = {
      task_id: TASK_ID,
      funder: FUNDER,
      translator: TRANSLATOR,
      rewardWei: "1",
      source_locale: "EN-US",
      target_locale: "ES-ES",
      string_key: "pay.now",
      state: "rejected",
      decision: "rejected",
      payment_status: "none",
      payment_kind: "refund",
      payout_submitted: false,
      created_at_unix: 1,
      submit_by_unix: 2,
      recover_after_unix: 3,
      submitted_at_unix: 2,
      decided_at_unix: 4,
      recovery_opens_at_unix: 3,
      client_nonce: "n",
    };
    expect(approvedSummaryIsNotLibraryEntry(rejected)).toBe(true);
    expect(approvedSummaryIsNotLibraryEntry({ ...rejected, state: "approved" })).toBe(false);
  });
});
