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
import { expectedWalletSpendWei } from "../../src/live/productUi/form";
import { productRecoveryClock } from "../../src/live/productUi/recoverClock";
import { liveRefundEvidence } from "../../src/live/productUi/settlement";
import { paymentDeliveryView } from "../../src/live/productUi/status";
import { writeFunctionName } from "../../src/live/productUi/writeFlow";
import {
  cancelConfirmStored,
  cancelEstimateAllowed,
  failedCancelStillOpen,
  failedRecoverStillSubmitted,
  isTaskFunder,
  neverResubmit,
  recoverConfirmStored,
  recoverEstimateAllowed,
  recoverSignAllowed,
} from "../../src/live/productUi/writeGuards";
import {
  emptyWriteRecord,
  getWrite,
  productUiWriteKey,
  putWrite,
  retryFailedWrite,
  type ProductUiWriteRecord,
  type WriteBalanceSnapshot,
} from "../../src/live/productUi/writes";

const FUNDER = "0x1111111111111111111111111111111111111111";
const TRANSLATOR = "0x2222222222222222222222222222222222222222";
const OTHER = "0x3333333333333333333333333333333333333333";
const TASK_ID = "b".repeat(64);
const CHAIN = 61997;
const REWARD = (10n ** 18n).toString();
const FEE = 126529000000823n;
const PARENT = `0x${"ca".repeat(32)}`;
const CHILD = `0x${"cb".repeat(32)}`;
const OPENS = 2_000_003_600;

function task(overrides: Record<string, unknown> = {}): ProductTask {
  const parsed = parseProductTask({
    task_id: TASK_ID,
    funder: FUNDER,
    translator: TRANSLATOR,
    reward: REWARD,
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
    recover_after_unix: OPENS,
    submitted_at_unix: 0,
    decided_at_unix: 0,
    recovery_opens_at_unix: OPENS,
    client_nonce: "n1",
    app_context: "Checkout",
    intended_meaning: "CTA",
    semantic_criteria: "Keep it short",
    ...overrides,
  });
  if (!parsed) throw new Error("fixture task failed to parse");
  return parsed;
}

function record(action: "cancel" | "recover", wallet: string): ProductUiWriteRecord {
  return emptyWriteRecord({
    chainId: CHAIN,
    contract: PRODUCT_UI_CONTRACT,
    taskId: TASK_ID,
    action,
    wallet,
  });
}

function ctx(wallet: string) {
  return { wallet, chainId: CHAIN, connected: true };
}

function snap(caller: string, funderWei: string, namedWei: string, callerWei: string): WriteBalanceSnapshot {
  return {
    funder: FUNDER,
    named: TRANSLATOR,
    contract: PRODUCT_UI_CONTRACT,
    funderWei,
    namedWei,
    contractWei: "0",
    unixMs: 1,
    caller,
    callerWei,
  };
}

function refundTransfer() {
  return {
    outgoing: [{ recipient: FUNDER, valueWei: REWARD, isEthSend: true, messageType: "0" }],
    children: [
      {
        found: true,
        txId: CHILD,
        triggeredBy: PARENT,
        triggeredOn: "finalized",
        to: FUNDER,
        valueWei: REWARD,
        valueCredited: true,
      },
    ],
    parseOk: true,
    parseNote: "fixture child credit",
  };
}

describe("live product UI cancel and recover", () => {
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

  it("maps cancel and recover to the Studio-dev write names", () => {
    expect(writeFunctionName("cancel")).toBe("cancel_task");
    expect(writeFunctionName("recover")).toBe("recover_undecided_task");
    expect(writeFunctionName("submit")).toBe("submit_translation");
    expect(writeFunctionName("evaluate")).toBe("evaluate_task");
  });

  it("keeps cancel/recover keys isolated from other actions, wallets, and harness storage", () => {
    expect(PRODUCT_UI_WRITES_STORAGE_KEY).toBe("localebounty.product-ui.writes.v1");
    expect(PRODUCT_UI_WRITES_STORAGE_KEY).not.toBe(PRODUCT_UI_STORAGE_KEY);
    expect(PRODUCT_UI_WRITES_STORAGE_KEY).not.toBe(DEMO_STORAGE_KEY);
    expect(PRODUCT_UI_WRITES_STORAGE_KEY).not.toBe(PRODUCT_STORAGE_KEY);
    expect(PRODUCT_UI_WRITES_STORAGE_KEY).not.toBe("localebounty.live-product-timeout.v1");

    const cancelFunder = productUiWriteKey({
      chainId: CHAIN,
      contract: PRODUCT_UI_CONTRACT,
      taskId: TASK_ID,
      action: "cancel",
      wallet: FUNDER,
    });
    const recoverFunder = productUiWriteKey({
      chainId: CHAIN,
      contract: PRODUCT_UI_CONTRACT,
      taskId: TASK_ID,
      action: "recover",
      wallet: FUNDER,
    });
    const recoverOther = productUiWriteKey({
      chainId: CHAIN,
      contract: PRODUCT_UI_CONTRACT,
      taskId: TASK_ID,
      action: "recover",
      wallet: OTHER,
    });
    expect(cancelFunder).not.toBe(recoverFunder);
    expect(recoverFunder).not.toBe(recoverOther);

    putWrite({ ...record("cancel", FUNDER), txId: PARENT, phase: "waiting" });
    expect(getWrite({ chainId: CHAIN, taskId: TASK_ID, action: "recover", wallet: FUNDER }).txId).toBeUndefined();
    expect(getWrite({ chainId: CHAIN, taskId: TASK_ID, action: "cancel", wallet: OTHER }).txId).toBeUndefined();
    expect(getWrite({ chainId: CHAIN, taskId: TASK_ID, action: "cancel", wallet: FUNDER }).txId).toBe(PARENT);
    expect(localStorage.getItem("localebounty.live-product-timeout.v1")).toBeNull();
    expect(localStorage.getItem(DEMO_STORAGE_KEY)).toBeNull();
  });

  it("allows only the connected funder to estimate cancel_task on an open undecided task", () => {
    const open = task();
    expect(isTaskFunder(open, FUNDER)).toBe(true);
    expect(cancelEstimateAllowed({ task: open, record: record("cancel", FUNDER), ctx: ctx(FUNDER) })).toEqual({ ok: true });

    const translator = cancelEstimateAllowed({ task: open, record: record("cancel", TRANSLATOR), ctx: ctx(TRANSLATOR) });
    expect(translator.ok).toBe(false);
    if (translator.ok) throw new Error("expected fail");
    expect(translator.reason).toMatch(/funder/i);

    const submitted = cancelEstimateAllowed({
      task: task({ state: STATE_SUBMITTED, translation: "Paga ahora" }),
      record: record("cancel", FUNDER),
      ctx: ctx(FUNDER),
    });
    expect(submitted.ok).toBe(false);

    const withText = cancelEstimateAllowed({
      task: task({ translation: "already" }),
      record: record("cancel", FUNDER),
      ctx: ctx(FUNDER),
    });
    expect(withText.ok).toBe(false);
  });

  it("lets any connected Studio-dev wallet recover after recovery_opens_at_unix and blocks earlier clocks", () => {
    const submitted = task({
      state: STATE_SUBMITTED,
      translation: "Paga ahora",
      submitted_at_unix: 2_000_000_000,
    });
    const tooEarly = recoverEstimateAllowed({
      task: submitted,
      record: record("recover", OTHER),
      ctx: ctx(OTHER),
      wallUnix: OPENS - 1,
      genvmUnix: OPENS - 5,
    });
    expect(tooEarly.ok).toBe(false);
    if (tooEarly.ok) throw new Error("expected fail");
    expect(tooEarly.reason).toMatch(/disabled until recovery_opens_at_unix/);
    expect(tooEarly.reason).toMatch(/Signing is not automatic/);

    const wallOpen = recoverEstimateAllowed({
      task: submitted,
      record: record("recover", OTHER),
      ctx: ctx(OTHER),
      wallUnix: OPENS,
      genvmUnix: OPENS - 50,
    });
    const genvmOpen = recoverEstimateAllowed({
      task: submitted,
      record: record("recover", FUNDER),
      ctx: ctx(FUNDER),
      wallUnix: OPENS - 50,
      genvmUnix: OPENS,
    });
    const translatorOpen = recoverSignAllowed({
      task: submitted,
      record: record("recover", TRANSLATOR),
      ctx: ctx(TRANSLATOR),
      wallUnix: OPENS + 1,
    });
    expect(wallOpen).toEqual({ ok: true });
    expect(genvmOpen).toEqual({ ok: true });
    expect(translatorOpen).toEqual({ ok: true });
  });

  it("shows a countdown that never signs and keeps Sign gated until the opening time", () => {
    const closed = productRecoveryClock(OPENS, OPENS - 90);
    expect(closed.open).toBe(false);
    expect(closed.remainingSeconds).toBe(90);
    expect(closed.countdownLabel).toMatch(/Too early to sign/);
    expect(closed.countdownLabel).toMatch(/does not send a transaction/);
    expect(closed.gateLabel).toMatch(/disabled until the contract recovery opening time/);

    const open = productRecoveryClock(OPENS, OPENS);
    expect(open.open).toBe(true);
    expect(open.countdownLabel).toMatch(/Signing is not automatic/);
    expect(open.countdownLabel).not.toMatch(/will sign/i);
  });

  it("never resubmits a stored hash and requires New attempt after a failed cancel or recover", () => {
    const open = task();
    const failedCancel = {
      ...record("cancel", FUNDER),
      txId: PARENT,
      statusName: "FINALIZED" as const,
      parentSuccessful: false,
      phase: "failed" as const,
    };
    expect(neverResubmit(failedCancel)).toBe("resume");
    expect(failedCancelStillOpen(open, failedCancel)).toBe(true);
    const blocked = cancelEstimateAllowed({ task: open, record: failedCancel, ctx: ctx(FUNDER) });
    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error("expected fail");
    expect(blocked.reason).toMatch(/New attempt/);
    const retry = retryFailedWrite(failedCancel);
    expect(retry.txId).toBeUndefined();
    expect(neverResubmit(retry)).toBe("submit");
    expect(cancelEstimateAllowed({ task: open, record: retry, ctx: ctx(FUNDER) })).toEqual({ ok: true });

    const submitted = task({ state: STATE_SUBMITTED, translation: "Paga ahora" });
    const failedRecover = {
      ...record("recover", OTHER),
      txId: `0x${"cc".repeat(32)}`,
      statusName: "FINALIZED" as const,
      parentSuccessful: false,
      phase: "failed" as const,
    };
    expect(failedRecoverStillSubmitted(submitted, failedRecover)).toBe(true);
    expect(
      recoverEstimateAllowed({
        task: submitted,
        record: failedRecover,
        ctx: ctx(OTHER),
        wallUnix: OPENS + 1,
      }).ok,
    ).toBe(false);
  });

  it("requires cancelled/refund after cancel and timed_out/refund after recover", () => {
    expect(
      cancelConfirmStored(
        task({ state: "cancelled", decision: "cancelled", payment_kind: "refund" }),
      ),
    ).toEqual({ ok: true });
    expect(cancelConfirmStored(task({ state: "cancelled", decision: "cancelled", payment_kind: "" })).ok).toBe(false);
    expect(
      recoverConfirmStored(
        task({
          state: "timed_out",
          decision: "timed_out",
          payment_kind: "refund",
          translation: "Paga ahora",
        }),
      ),
    ).toEqual({ ok: true });
    expect(
      recoverConfirmStored(
        task({
          state: STATE_SUBMITTED,
          decision: "none",
          translation: "Paga ahora",
        }),
      ).ok,
    ).toBe(false);
  });

  it("quotes expected wallet spend as the fee deposit with attached value 0", () => {
    expect(expectedWalletSpendWei(0n, FEE)).toBe(FEE);
  });

  it("proves a funder-caller refund only when delta equals reward minus receipt fee", () => {
    const cancelled = task({
      state: "cancelled",
      decision: "cancelled",
      payment_kind: "refund",
      payment_status: "submitted",
      payout_submitted: true,
    });
    const before = snap(FUNDER, "10000000000000000000", "5", "10000000000000000000");
    const afterWei = (10_000_000_000_000_000_000n + 10n ** 18n - FEE).toString();
    const after = snap(FUNDER, afterWei, "5", afterWei);
    const view = liveRefundEvidence({
      task: cancelled,
      expected: "cancel",
      record: {
        ...record("cancel", FUNDER),
        txId: PARENT,
        statusName: "FINALIZED",
        executionName: "FINISHED_WITH_RETURN",
        parentSuccessful: true,
        phase: "success",
        actualFeeAvailable: true,
        actualFeeWei: FEE.toString(),
        transfer: refundTransfer(),
        beforeBalances: before,
        afterBalances: after,
      },
    });
    expect(view.paymentEvidence).toBe("YES");
    expect(view.outgoingEthSend).toMatch(/Outgoing EthSend to funder/);
    expect(view.childCredit).toMatch(/value_credited true/);
    expect(view.receiptFee).toContain(FEE.toString());
    expect(view.balanceEvidence).toMatch(/reward minus receipt fee/);
    expect(view.paymentReason).toContain(PAYOUT_SUBMITTED_IS_NOT_PAYMENT);
  });

  it("proves a third-party recover when the funder gains the reward and the caller pays the fee", () => {
    const timedOut = task({
      state: "timed_out",
      decision: "timed_out",
      payment_kind: "refund",
      payment_status: "submitted",
      payout_submitted: true,
      translation: "Paga ahora",
    });
    const before = snap(OTHER, "10000000000000000000", "5", "8000000000000000000");
    const after = snap(
      OTHER,
      (10_000_000_000_000_000_000n + 10n ** 18n).toString(),
      "5",
      (8_000_000_000_000_000_000n - FEE).toString(),
    );
    const view = liveRefundEvidence({
      task: timedOut,
      expected: "recover",
      record: {
        ...record("recover", OTHER),
        txId: PARENT,
        statusName: "FINALIZED",
        executionName: "FINISHED_WITH_RETURN",
        parentSuccessful: true,
        phase: "success",
        actualFeeAvailable: true,
        actualFeeWei: FEE.toString(),
        transfer: refundTransfer(),
        beforeBalances: before,
        afterBalances: after,
      },
    });
    expect(view.paymentEvidence).toBe("YES");
    expect(view.paymentReason).toMatch(/Third-party recover/);
    expect(view.paymentReason).toMatch(/caller/);
    expect(view.balanceEvidence).toMatch(/Funder matches reward/);
  });

  it("never infers a refund from payout_submitted or parent success, and withholds missing snapshots", () => {
    const cancelled = task({
      state: "cancelled",
      decision: "cancelled",
      payment_kind: "refund",
      payment_status: "submitted",
      payout_submitted: true,
    });
    const delivery = paymentDeliveryView(cancelled);
    expect(delivery.paid).toBe(false);

    const parentOnly = liveRefundEvidence({
      task: cancelled,
      expected: "cancel",
      record: {
        ...record("cancel", FUNDER),
        txId: PARENT,
        statusName: "FINALIZED",
        executionName: "FINISHED_WITH_RETURN",
        parentSuccessful: true,
        phase: "success",
      },
    });
    expect(parentOnly.paymentEvidence).toBe("UNPROVEN");
    expect(parentOnly.balanceEvidence).toBe(BALANCE_PROOF_UNAVAILABLE);
    expect(parentOnly.outgoingEthSend).toMatch(/UNPROVEN/);
    expect(parentOnly.childCredit).toMatch(/UNPROVEN/);
    expect(parentOnly.paymentReason).toMatch(/Outgoing EthSend and matching child/);

    const withTransferNoSnap = liveRefundEvidence({
      task: cancelled,
      expected: "cancel",
      record: {
        ...record("cancel", FUNDER),
        txId: PARENT,
        statusName: "FINALIZED",
        executionName: "FINISHED_WITH_RETURN",
        parentSuccessful: true,
        phase: "success",
        actualFeeAvailable: true,
        actualFeeWei: FEE.toString(),
        transfer: refundTransfer(),
      },
    });
    expect(withTransferNoSnap.paymentEvidence).toBe("UNPROVEN");
    expect(withTransferNoSnap.balanceEvidence).toBe(BALANCE_PROOF_UNAVAILABLE);
    expect(withTransferNoSnap.paymentReason).toContain("unavailable");
  });
});
