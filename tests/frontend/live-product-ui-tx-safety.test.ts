import { beforeEach, describe, expect, it } from "vitest";
import { applyTxSignCatch, historyHasTxId, trackingFailedAfterTxId } from "../../src/live/productUi/attemptHistory";
import { PRODUCT_UI_CONTRACT } from "../../src/live/productUi/constants";
import { retainCreateAfterTrackingFailure } from "../../src/live/productUi/createFlow";
import {
  emptyProductUiSession,
  loadProductUiSession,
  saveProductUiSession,
  startNewCreateAttempt,
} from "../../src/live/productUi/persist";
import { executionSubmitDeadlineView } from "../../src/live/productUi/submitClock";
import { persistSubmittedWrite, emptyWriteRecord, getWrite, retryFailedWrite } from "../../src/live/productUi/writes";
import { retainWriteAfterTrackingFailure } from "../../src/live/productUi/writeFlow";
import { neverResubmit } from "../../src/live/productUi/writeGuards";
import { parseProductTask } from "../../src/live/product/task";

const FUNDER = "0x1111111111111111111111111111111111111111";
const TRANSLATOR = "0x2222222222222222222222222222222222222222";
const TASK_ID = "c".repeat(64);
const CHAIN = 61997;
const TX = `0x${"ab".repeat(32)}`;
const TX2 = `0x${"cd".repeat(32)}`;

function submitRecord() {
  return emptyWriteRecord({
    chainId: CHAIN,
    contract: PRODUCT_UI_CONTRACT,
    taskId: TASK_ID,
    action: "submit",
    wallet: TRANSLATOR,
  });
}

describe("public-app transaction safety", () => {
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

  it("keeps a persisted tx ID when tracking fails and Sign catch loads the latest record", () => {
    const quoting = { ...submitRecord(), phase: "quoted" as const, quotedFeeWei: "1" };
    const persisted = persistSubmittedWrite(quoting, TX);
    expect(persisted.txId).toBe(TX);
    expect(getWrite({ chainId: CHAIN, taskId: TASK_ID, action: "submit", wallet: TRANSLATOR }).txId).toBe(TX);

    const staleSnapshot = { ...quoting, phase: "signing" as const };
    const wrong = applyTxSignCatch(staleSnapshot, new Error("RPC timeout"));
    expect(wrong.txId).toBeUndefined();
    expect(wrong.error).not.toMatch(/Resume tracking/);

    const latest = getWrite({ chainId: CHAIN, taskId: TASK_ID, action: "submit", wallet: TRANSLATOR });
    const caught = applyTxSignCatch(latest, new Error("RPC timeout"));
    expect(caught.txId).toBe(TX);
    expect(caught.phase).toBe("waiting");
    expect(caught.error).toMatch(/Resume tracking/);
    expect(caught.error).toMatch(TX);
    expect(neverResubmit(caught)).toBe("resume");

    const retained = retainWriteAfterTrackingFailure(latest, TX, new Error("child enrichment failed"), () => undefined);
    expect(retained.txId).toBe(TX);
    expect(retained.error).toBe(trackingFailedAfterTxId(TX, new Error("child enrichment failed")));
    expect(getWrite({ chainId: CHAIN, taskId: TASK_ID, action: "submit", wallet: TRANSLATOR }).txId).toBe(TX);
  });

  it("resumes a stored hash after reload and never treats it as a new submit", () => {
    persistSubmittedWrite(submitRecord(), TX);
    const reloaded = getWrite({ chainId: CHAIN, taskId: TASK_ID, action: "submit", wallet: TRANSLATOR });
    expect(reloaded.txId).toBe(TX);
    expect(neverResubmit(reloaded)).toBe("resume");
    expect(reloaded.phase).toBe("submitted");
  });

  it("archives a finalized failed hash on New attempt and never retries it", () => {
    const failed = {
      ...persistSubmittedWrite(submitRecord(), TX),
      statusName: "FINALIZED" as const,
      parentSuccessful: false,
      phase: "failed" as const,
    };
    const pending = persistSubmittedWrite(
      emptyWriteRecord({
        chainId: CHAIN,
        contract: PRODUCT_UI_CONTRACT,
        taskId: TASK_ID,
        action: "evaluate",
        wallet: FUNDER,
      }),
      TX2,
    );
    const retry = retryFailedWrite(failed);
    expect(retry.txId).toBeUndefined();
    expect(historyHasTxId(retry.attemptHistory, TX)).toBe(true);
    expect(retryFailedWrite(pending).txId).toBe(TX2);
    expect(neverResubmit({ txId: TX })).toBe("resume");
  });

  it("blocks a new submit signature when the execution clock passed submit_by_unix even if GenVM still lags", () => {
    const task = parseProductTask({
      task_id: TASK_ID,
      funder: FUNDER,
      translator: TRANSLATOR,
      reward: "1",
      source_text: "Pay",
      source_locale: "EN-US",
      target_locale: "ES-ES",
      string_key: "pay",
      translation: "",
      state: "open",
      decision: "none",
      payment_status: "none",
      payment_kind: "",
      payout_submitted: false,
      submit_by_unix: 1_790_000_000,
      recover_after_unix: 1_790_003_600,
      client_nonce: "n",
    })!;
    const view = executionSubmitDeadlineView(task, 1_790_000_001, 1_732_604_900);
    expect(view.open).toBe(false);
    expect(view.countdownLabel).toMatch(/has passed/);
    expect(view.countdownLabel).toMatch(/GenVM/);
    expect(view.gateLabel).toMatch(/cannot make this window appear open/);
  });

  it("keeps a pending create hash and archives only after a finalized New attempt", () => {
    const pending = emptyProductUiSession();
    pending.create = { phase: "waiting", txId: TX };
    saveProductUiSession(pending);
    const loaded = loadProductUiSession();
    expect(startNewCreateAttempt(loaded).create.txId).toBe(TX);

    const failed = {
      ...loaded,
      create: {
        ...loaded.create,
        statusName: "FINALIZED" as const,
        parentSuccessful: false,
        phase: "failed" as const,
      },
    };
    const next = startNewCreateAttempt(failed);
    expect(next.create.txId).toBeUndefined();
    expect(next.createAttemptHistory?.map((item) => item.txId)).toEqual([TX]);

    const tracked = retainCreateAfterTrackingFailure(loaded, TX, new Error("watchTx failed"));
    expect(tracked.create.txId).toBe(TX);
    expect(tracked.create.error).toMatch(/Resume tracking/);
    expect(loadProductUiSession().create.txId).toBe(TX);
  });

  it("labels pre-submit wallet errors separately from post-submit tracking errors", () => {
    const quoted = { ...submitRecord(), phase: "signing" as const };
    const pre = applyTxSignCatch(quoted, { code: 4001, message: "rejected" });
    expect(pre.txId).toBeUndefined();
    expect(pre.error).toMatch(/Wallet rejected the signature/);
    const post = applyTxSignCatch({ ...quoted, txId: TX, phase: "submitted" as const }, new Error("rate limited"));
    expect(post.error).toMatch(/Tracking failed after transaction ID/);
    expect(post.error).not.toMatch(/Wallet rejected the signature/);
  });
});
