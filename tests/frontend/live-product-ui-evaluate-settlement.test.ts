import { describe, expect, it } from "vitest";
import { extractFinalizedFee } from "../../src/live/fees";
import { PAYOUT_SUBMITTED_IS_NOT_PAYMENT } from "../../src/live/product/evidence";
import { parseProductTask, type ProductTask } from "../../src/live/product/task";
import {
  BALANCE_PROOF_UNAVAILABLE,
  FEE_PAYER_PROOF_UNAVAILABLE,
  PRODUCT_UI_CONTRACT,
} from "../../src/live/productUi/constants";
import {
  evaluateFeeEquation,
  evaluateFeePayerRole,
  evaluateReceiptFee,
  liveEvaluateSettlement,
} from "../../src/live/productUi/settlement";
import {
  deriveCallerSnapshot,
  keepEvaluateSnapshots,
  shouldCaptureEvaluateAfter,
} from "../../src/live/productUi/writeFlow";
import { emptyWriteRecord, type ProductUiWriteRecord, type WriteBalanceSnapshot } from "../../src/live/productUi/writes";

const FUNDER = "0x1111111111111111111111111111111111111111";
const TRANSLATOR = "0x7E4E1f7DcC3DA063F9110477Ad348C90E8599253";
const OTHER = "0x3333333333333333333333333333333333333333";
const TASK_ID = "c".repeat(64);
const CHAIN = 61997;
const REWARD = 500000000000000000n;
const FEE = 126529250000823n;
const TRANSLATOR_DELTA = 499873470749999177n;
const PARENT = "0xa1dbcd046445f8ccfaf4d8f2917e20628a55a19ef9f6c1262107ba75f681060b";
const CHILD = "0xa5817ff984a9591705eabe9e9abe7a5e2a0a628ec67454a8f14f24cf82af49e6";
const BEFORE = 10_000_000_000_000_000_000n;

function task(overrides: Record<string, unknown> = {}): ProductTask {
  const parsed = parseProductTask({
    task_id: TASK_ID,
    funder: FUNDER,
    translator: TRANSLATOR,
    reward: REWARD.toString(),
    source_text: "Pay now",
    source_locale: "EN-US",
    target_locale: "ES-ES",
    string_key: "pay.now",
    translation: "Paga ahora",
    state: "approved",
    decision: "approved",
    payment_status: "submitted",
    payment_kind: "payout",
    payout_submitted: true,
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

function record(wallet: string, extra: Partial<ProductUiWriteRecord> = {}): ProductUiWriteRecord {
  return {
    ...emptyWriteRecord({
      chainId: CHAIN,
      contract: PRODUCT_UI_CONTRACT,
      taskId: TASK_ID,
      action: "evaluate",
      wallet,
    }),
    txId: PARENT,
    statusName: "FINALIZED",
    executionName: "FINISHED_WITH_RETURN",
    parentSuccessful: true,
    phase: "success",
    ...extra,
  };
}

function snap(caller: string, funderWei: string, namedWei: string, callerWei?: string): WriteBalanceSnapshot {
  return {
    funder: FUNDER,
    named: TRANSLATOR,
    contract: PRODUCT_UI_CONTRACT,
    funderWei,
    namedWei,
    contractWei: "0",
    unixMs: 1,
    caller,
    callerWei: callerWei ?? (caller.toLowerCase() === TRANSLATOR.toLowerCase() ? namedWei : caller.toLowerCase() === FUNDER.toLowerCase() ? funderWei : "0"),
  };
}

function payoutTransfer() {
  return {
    outgoing: [{ recipient: TRANSLATOR, valueWei: REWARD.toString(), isEthSend: true, messageType: "0" }],
    children: [
      {
        found: true,
        txId: CHILD,
        triggeredBy: PARENT,
        triggeredOn: "finalized",
        to: TRANSLATOR,
        valueWei: REWARD.toString(),
        valueCredited: true,
      },
    ],
    parseOk: true,
    parseNote: "fixture child credit",
  };
}

function refundTransfer() {
  return {
    outgoing: [{ recipient: FUNDER, valueWei: REWARD.toString(), isEthSend: true, messageType: "0" }],
    children: [
      {
        found: true,
        txId: CHILD,
        triggeredBy: PARENT,
        triggeredOn: "finalized",
        to: FUNDER,
        valueWei: REWARD.toString(),
        valueCredited: true,
      },
    ],
    parseOk: true,
    parseNote: "fixture child credit",
  };
}

function liveReceipt() {
  return {
    data: {
      fee_accounting: {
        primary_fee_spent: FEE.toString(),
      },
    },
  };
}

const rejected = () =>
  task({
    state: "rejected",
    decision: "rejected",
    payment_kind: "refund",
    payment_status: "submitted",
    payout_submitted: true,
  });

describe("live product UI evaluate fee-payer settlement", () => {
  it("matches the live parent receipt fee to the stored translator shortfall without treating the shortfall as a receipt", () => {
    expect(REWARD - TRANSLATOR_DELTA).toBe(FEE);
    const inferred = REWARD - TRANSLATOR_DELTA;
    expect(inferred).toBe(126529250000823n);
    const fromReceipt = extractFinalizedFee(liveReceipt());
    expect(fromReceipt.available).toBe(true);
    expect(fromReceipt.feeWei).toBe(FEE);
    expect(fromReceipt.source).toBe("primary_fee_spent");
    const withoutReceipt = evaluateReceiptFee(
      record(TRANSLATOR, {
        beforeEvaluate: snap(TRANSLATOR, BEFORE.toString(), BEFORE.toString()),
        afterEvaluate: snap(TRANSLATOR, BEFORE.toString(), (BEFORE + TRANSLATOR_DELTA).toString()),
      }),
    );
    expect(withoutReceipt.available).toBe(false);
    expect(withoutReceipt.feeWei).toBeUndefined();
    expect(withoutReceipt.reason.toLowerCase()).not.toContain("499873470749999177");
  });

  it("proves approval when evaluator = translator and net delta equals reward minus receipt fee", () => {
    const before = snap(TRANSLATOR, BEFORE.toString(), BEFORE.toString());
    const after = snap(TRANSLATOR, BEFORE.toString(), (BEFORE + TRANSLATOR_DELTA).toString());
    const view = liveEvaluateSettlement({
      task: task(),
      record: record(TRANSLATOR, {
        receipt: liveReceipt(),
        transfer: payoutTransfer(),
        beforeEvaluate: before,
        afterEvaluate: after,
      }),
    });
    expect(evaluateFeePayerRole(task(), TRANSLATOR)).toBe("translator");
    expect(view.paymentEvidence).toBe("YES");
    expect(view.receiptFee).toContain(FEE.toString());
    expect(view.receiptFee).toContain("primary_fee_spent");
    expect(view.feeEquation).toBe(
      evaluateFeeEquation({ approved: true, role: "translator", rewardWei: REWARD, feeWei: FEE }),
    );
    expect(view.feeEquation).toContain("reward − actual receipt fee");
    expect(view.outgoingEthSend).toMatch(/Outgoing EthSend to translator/);
    expect(view.childCredit).toMatch(/value_credited true/);
    expect(view.childCredit).toContain(CHILD);
    expect(view.balanceEvidence).toMatch(/Matches reward minus receipt fee/);
    expect(view.paymentReason).toContain(PAYOUT_SUBMITTED_IS_NOT_PAYMENT);
    expect(view.paymentReason.toLowerCase()).not.toMatch(/\bpaid\b/);
  });

  it("stays UNPROVEN when the receipt fee is missing even if a shortfall equals the live fee", () => {
    const view = liveEvaluateSettlement({
      task: task(),
      record: record(TRANSLATOR, {
        transfer: payoutTransfer(),
        beforeEvaluate: snap(TRANSLATOR, BEFORE.toString(), BEFORE.toString()),
        afterEvaluate: snap(TRANSLATOR, BEFORE.toString(), (BEFORE + TRANSLATOR_DELTA).toString()),
      }),
    });
    expect(view.paymentEvidence).toBe("UNPROVEN");
    expect(view.receiptFee).toMatch(/UNPROVEN/);
    expect(view.paymentReason).toMatch(/Balance shortfall is not a receipt|Receipt fee is UNPROVEN/);
  });

  it("proves approval when evaluator = funder: translator gains reward and funder pays the receipt fee", () => {
    const before = snap(FUNDER, BEFORE.toString(), BEFORE.toString());
    const after = snap(FUNDER, (BEFORE - FEE).toString(), (BEFORE + REWARD).toString());
    const view = liveEvaluateSettlement({
      task: task(),
      record: record(FUNDER, {
        receipt: liveReceipt(),
        transfer: payoutTransfer(),
        beforeBalances: before,
        afterBalances: after,
      }),
    });
    expect(view.paymentEvidence).toBe("YES");
    expect(view.feeEquation).toContain("evaluator = funder");
    expect(view.balanceEvidence).toMatch(/Translator matches reward; funder matches minus receipt fee/);
  });

  it("proves approval when a third-party evaluator pays the fee and the translator gains the reward", () => {
    const before = snap(OTHER, BEFORE.toString(), BEFORE.toString(), (BEFORE / 2n).toString());
    const after = snap(OTHER, BEFORE.toString(), (BEFORE + REWARD).toString(), (BEFORE / 2n - FEE).toString());
    const view = liveEvaluateSettlement({
      task: task(),
      record: record(OTHER, {
        receipt: liveReceipt(),
        transfer: payoutTransfer(),
        beforeBalances: before,
        afterBalances: after,
      }),
    });
    expect(evaluateFeePayerRole(task(), OTHER)).toBe("third_party");
    expect(view.paymentEvidence).toBe("YES");
    expect(view.feeEquation).toContain("third-party evaluator");
    expect(view.balanceEvidence).toMatch(/evaluator matches minus receipt fee/i);
  });

  it("leaves fee-payer balance proof UNPROVEN when an older third-party record has no caller snapshot", () => {
    const view = liveEvaluateSettlement({
      task: task(),
      record: record(OTHER, {
        receipt: liveReceipt(),
        transfer: payoutTransfer(),
        beforeEvaluate: {
          funder: FUNDER,
          named: TRANSLATOR,
          contract: PRODUCT_UI_CONTRACT,
          funderWei: BEFORE.toString(),
          namedWei: BEFORE.toString(),
          contractWei: "0",
          unixMs: 1,
        },
        afterEvaluate: {
          funder: FUNDER,
          named: TRANSLATOR,
          contract: PRODUCT_UI_CONTRACT,
          funderWei: BEFORE.toString(),
          namedWei: (BEFORE + REWARD).toString(),
          contractWei: "0",
          unixMs: 2,
        },
      }),
    });
    expect(view.paymentEvidence).toBe("UNPROVEN");
    expect(view.balanceEvidence).toContain(FEE_PAYER_PROOF_UNAVAILABLE);
    expect(view.outgoingEthSend).toMatch(/Outgoing EthSend/);
    expect(view.childCredit).toMatch(/value_credited true/);
    expect(view.receiptFee).toContain(FEE.toString());
    expect(view.feeEquation).toContain("third-party evaluator");
  });

  it("applies fee-payer logic to rejection refunds for funder, translator, and third-party evaluators", () => {
    const closed = rejected();
    const funderView = liveEvaluateSettlement({
      task: closed,
      record: record(FUNDER, {
        receipt: liveReceipt(),
        transfer: refundTransfer(),
        beforeBalances: snap(FUNDER, BEFORE.toString(), BEFORE.toString()),
        afterBalances: snap(FUNDER, (BEFORE + REWARD - FEE).toString(), BEFORE.toString()),
      }),
    });
    expect(funderView.paymentEvidence).toBe("YES");
    expect(funderView.feeEquation).toContain("evaluator = funder");
    expect(funderView.outgoingEthSend).toMatch(/Outgoing EthSend to funder/);

    const translatorView = liveEvaluateSettlement({
      task: closed,
      record: record(TRANSLATOR, {
        receipt: liveReceipt(),
        transfer: refundTransfer(),
        beforeBalances: snap(TRANSLATOR, BEFORE.toString(), BEFORE.toString()),
        afterBalances: snap(TRANSLATOR, (BEFORE + REWARD).toString(), (BEFORE - FEE).toString()),
      }),
    });
    expect(translatorView.paymentEvidence).toBe("YES");
    expect(translatorView.feeEquation).toContain("evaluator = translator");

    const third = liveEvaluateSettlement({
      task: closed,
      record: record(OTHER, {
        receipt: liveReceipt(),
        transfer: refundTransfer(),
        beforeBalances: snap(OTHER, BEFORE.toString(), BEFORE.toString(), (BEFORE / 2n).toString()),
        afterBalances: snap(OTHER, (BEFORE + REWARD).toString(), BEFORE.toString(), (BEFORE / 2n - FEE).toString()),
      }),
    });
    expect(third.paymentEvidence).toBe("YES");
    expect(third.feeEquation).toContain("third-party evaluator");
  });

  it("keeps missing before-write snapshots UNPROVEN and never treats payout_submitted as paid", () => {
    const view = liveEvaluateSettlement({
      task: task(),
      record: record(TRANSLATOR, {
        receipt: liveReceipt(),
        transfer: payoutTransfer(),
      }),
    });
    expect(view.paymentEvidence).toBe("UNPROVEN");
    expect(view.balanceEvidence).toBe(BALANCE_PROOF_UNAVAILABLE);
    expect(view.outgoingEthSend).toMatch(/Outgoing EthSend/);
    expect(view.receiptFee).toContain(FEE.toString());
    expect(view.paymentReason).toContain(BALANCE_PROOF_UNAVAILABLE);
    expect(`${view.transactionStatus} ${view.execution} ${view.contractDecision}`.toLowerCase()).not.toMatch(/\bpaid\b/);
  });

  it("never replaces a historical before snapshot and skips a live after recapture on already-FINALIZED records", () => {
    const historicalBefore = snap(TRANSLATOR, "1", "2");
    const historicalAfter = snap(TRANSLATOR, "1", (2n + TRANSLATOR_DELTA).toString());
    const liveNow = snap(TRANSLATOR, "999", "888", "777");
    const stored = record(TRANSLATOR, {
      beforeEvaluate: historicalBefore,
      beforeBalances: historicalBefore,
      afterEvaluate: historicalAfter,
      afterBalances: historicalAfter,
    });
    expect(shouldCaptureEvaluateAfter(stored)).toBe(false);
    const kept = keepEvaluateSnapshots(stored, task(), liveNow);
    expect(kept.beforeEvaluate).toEqual(historicalBefore);
    expect(kept.beforeBalances).toEqual(historicalBefore);
    expect(kept.afterEvaluate).toEqual(historicalAfter);
    expect(kept.afterBalances).toEqual(historicalAfter);
    expect(deriveCallerSnapshot(historicalBefore, OTHER, task())).toBeUndefined();
    expect(deriveCallerSnapshot(historicalBefore, TRANSLATOR, task())?.callerWei).toBe("2");
  });
});
