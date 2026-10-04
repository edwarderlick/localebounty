import { beforeEach, describe, expect, it } from "vitest";
import { parseProductTask, type ProductTask } from "../../src/live/product/task";
import { PRODUCT_UI_CONTRACT, PRODUCT_UI_STORAGE_KEY, PRODUCT_UI_WRITES_STORAGE_KEY } from "../../src/live/productUi/constants";
import { buildPublicDecisionEvidenceObject } from "../../src/live/productUi/decisionEvidence";
import { emptyProductUiSession, saveProductUiSession } from "../../src/live/productUi/persist";
import { emptyWriteRecord, putWrite, type ProductUiWriteRecord, type WriteBalanceSnapshot } from "../../src/live/productUi/writes";

const FUNDER = "0x1111111111111111111111111111111111111111";
const TRANSLATOR = "0x7E4E1f7DcC3DA063F9110477Ad348C90E8599253";
const TASK_ID = "b82d9249344ce081c69f659bf95ca00f40b8b22b6218131025787b71e0023302";
const CHAIN = 61997;
const REWARD = 500000000000000000n;
const FEE = 126529250000823n;
const TRANSLATOR_DELTA = 499873470749999177n;
const PARENT = "0xa1dbcd046445f8ccfaf4d8f2917e20628a55a19ef9f6c1262107ba75f681060b";
const CHILD = "0xa5817ff984a9591705eabe9e9abe7a5e2a0a628ec67454a8f14f24cf82af49e6";
const CREATE = `0x${"11".repeat(32)}`;
const SUBMIT = `0x${"22".repeat(32)}`;
const OTHER_CREATE = `0x${"33".repeat(32)}`;
const BEFORE = 10_000_000_000_000_000_000n;

function task(): ProductTask {
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
  });
  if (!parsed) throw new Error("fixture task failed to parse");
  return parsed;
}

function snap(namedWei: string): WriteBalanceSnapshot {
  return {
    funder: FUNDER,
    named: TRANSLATOR,
    contract: PRODUCT_UI_CONTRACT,
    funderWei: BEFORE.toString(),
    namedWei,
    contractWei: "0",
    unixMs: 1,
    caller: TRANSLATOR,
    callerWei: namedWei,
  };
}

function evaluateRecord(): ProductUiWriteRecord {
  return {
    ...emptyWriteRecord({
      chainId: CHAIN,
      contract: PRODUCT_UI_CONTRACT,
      taskId: TASK_ID,
      action: "evaluate",
      wallet: TRANSLATOR,
    }),
    txId: PARENT,
    statusName: "FINALIZED",
    executionName: "FINISHED_WITH_RETURN",
    parentSuccessful: true,
    phase: "success",
    quotedFeeWei: "760930800010352",
    receipt: { data: { fee_accounting: { primary_fee_spent: FEE.toString() } } },
    transfer: {
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
      parseNote: "fixture",
    },
    beforeEvaluate: snap(BEFORE.toString()),
    afterEvaluate: snap((BEFORE + TRANSLATOR_DELTA).toString()),
  };
}

describe("public Decision Copy evidence JSON", () => {
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

  it("includes live parent/child, receipt fee, snapshots, equation, and YES without inventing create/submit hashes", () => {
    const payload = buildPublicDecisionEvidenceObject({
      task: task(),
      record: evaluateRecord(),
      wallet: TRANSLATOR,
      chainId: CHAIN,
    });
    expect(payload.kind).toBe("localebounty.product-ui.decision-evidence.v1");
    expect(payload.taskId).toBe(TASK_ID);
    expect(payload.contract).toBe(PRODUCT_UI_CONTRACT);
    expect(payload.parentTxId).toBe(PARENT);
    expect(payload.childTxId).toBe(CHILD);
    expect(payload.source_text).toBe("Pay now");
    expect(payload.translation).toBe("Paga ahora");
    expect(payload.rewardWei).toBe(REWARD.toString());
    expect(payload.quotedFeeDepositWei).toBe("760930800010352");
    expect(payload.actualReceiptFeeWei).toBe(FEE.toString());
    expect(payload.namedDeltaWei).toBe(TRANSLATOR_DELTA.toString());
    expect(payload.funderDeltaWei).toBe("0");
    expect(payload.verdict).toBe("YES");
    expect(payload.live_result).toBe("YES");
    expect(String(payload.feeEquation)).toContain("reward − actual receipt fee");
    expect(payload.createTx).toBeUndefined();
    expect(payload.submitTx).toBeUndefined();
    const raw = JSON.stringify(payload);
    expect(raw).not.toContain(CREATE);
    expect(raw).not.toContain(SUBMIT);
    expect(raw).not.toContain(OTHER_CREATE);
  });

  it("adds create and submit hashes only when this browser stored them for this task", () => {
    saveProductUiSession({
      ...emptyProductUiSession(),
      expectedTaskId: TASK_ID,
      createTask: task(),
      create: { phase: "success", txId: CREATE, statusName: "FINALIZED", parentSuccessful: true },
    });
    putWrite({
      ...emptyWriteRecord({
        chainId: CHAIN,
        contract: PRODUCT_UI_CONTRACT,
        taskId: TASK_ID,
        action: "submit",
        wallet: TRANSLATOR,
      }),
      txId: SUBMIT,
      statusName: "FINALIZED",
      parentSuccessful: true,
      phase: "success",
    });
    const payload = buildPublicDecisionEvidenceObject({
      task: task(),
      record: evaluateRecord(),
      wallet: TRANSLATOR,
      chainId: CHAIN,
    });
    expect(payload.createTx).toEqual(
      expect.objectContaining({ txId: CREATE, statusName: "FINALIZED", parentSuccessful: true }),
    );
    expect(payload.submitTx).toEqual(expect.objectContaining({ txId: SUBMIT, wallet: TRANSLATOR }));
  });

  it("does not attach another task's create hash from lastOpenedTaskId", () => {
    saveProductUiSession({
      ...emptyProductUiSession(),
      lastOpenedTaskId: TASK_ID,
      expectedTaskId: "aa".repeat(32),
      create: { phase: "success", txId: OTHER_CREATE, statusName: "FINALIZED", parentSuccessful: true },
    });
    const payload = buildPublicDecisionEvidenceObject({
      task: task(),
      record: evaluateRecord(),
      wallet: TRANSLATOR,
      chainId: CHAIN,
    });
    expect(payload.createTx).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain(OTHER_CREATE);
    expect(localStorage.getItem(PRODUCT_UI_STORAGE_KEY)).toBeTruthy();
    expect(localStorage.getItem(PRODUCT_UI_WRITES_STORAGE_KEY)).toBeNull();
  });
});
