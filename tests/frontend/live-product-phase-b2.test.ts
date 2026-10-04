import { beforeEach, describe, expect, it } from "vitest";
import { PRODUCT_STORAGE_KEY } from "../../src/live/product/constants";
import { parseProductTask } from "../../src/live/product/task";
import { expectedTaskId } from "../../src/live/product/taskId";
import { B1_STRING_KEY, PRODUCT_B1_STORAGE_KEY } from "../../src/live/productB1/constants";
import {
  createEstimateAllowed,
  evaluateEstimateAllowed,
  neverResubmit,
  recoverEstimateAllowed,
  retryFailedB1Action,
  submitEstimateAllowed,
  type B1WriteContext,
} from "../../src/live/productB1/guards";
import { libraryUnchangedForReject, parseLibraryEntry } from "../../src/live/productB1/library";
import {
  B2_CONTRACT_ADDRESS,
  B2_SOURCE_TEXT,
  B2_STRING_KEY,
  B2_SUGGESTED_TRANSLATION,
  B2_TARGET_LOCALE,
  PRODUCT_B2_STORAGE_KEY,
} from "../../src/live/productB2/constants";
import { buildB2EvidencePayload, overallB2Verdict } from "../../src/live/productB2/evidence";
import {
  emptyB2Session,
  loadB2Session,
  saveB2Session,
  type B2ActionRecord,
  type B2Session,
} from "../../src/live/productB2/persist";

const FUNDER = "0x1111111111111111111111111111111111111111";
const TRANSLATOR = "0x2222222222222222222222222222222222222222";
const NONCE = "phase-b2-nonce-1";
const REWARD = (10n ** 18n).toString();
const SUBMIT = 1_800_000_000;
const RECOVER = SUBMIT + 3600;
const CREATE_TX = `0x${"aa".repeat(32)}`;
const SUBMIT_TX = `0x${"bb".repeat(32)}`;
const EVALUATE_TX = `0x${"cc".repeat(32)}`;
const CHILD_TX = `0x${"ee".repeat(32)}`;
const FEE = 126529000000823n;

function ctx(overrides: Partial<B1WriteContext> = {}): B1WriteContext {
  return { wallet: FUNDER, chainId: 61997, connected: true, ...overrides };
}

function successAction(txId: string): B2ActionRecord {
  return {
    phase: "success",
    txId,
    statusName: "FINALIZED",
    executionName: "FINISHED_WITH_RETURN",
    parentSuccessful: true,
  };
}

function sourceBound(session: B2Session): B2Session {
  return {
    ...session,
    address: B2_CONTRACT_ADDRESS,
    sourceMatch: true,
    sourceVerifyStatus: "match",
    sourceVerifyReason: "matched",
    sourceVerifiedAddress: B2_CONTRACT_ADDRESS,
    sourceVerifiedLocalSha256: "local-sha",
    localSourceSha256: "local-sha",
  };
}

function transferTo(recipient: string, parentTxId: string) {
  return {
    outgoing: [{ recipient, valueWei: REWARD, isEthSend: true, messageType: "0" }],
    children: [
      {
        found: true,
        txId: CHILD_TX,
        triggeredBy: parentTxId,
        triggeredOn: "finalized",
        to: recipient,
        valueWei: REWARD,
        valueCredited: true,
      },
    ],
    parseOk: true,
    parseNote: "fixture child credit",
  };
}

async function readySubmittedSession(): Promise<B2Session> {
  const taskId = await expectedTaskId(FUNDER, B2_CONTRACT_ADDRESS, NONCE);
  const task = parseProductTask({
    task_id: taskId,
    funder: FUNDER,
    translator: TRANSLATOR,
    reward: REWARD,
    source_text: B2_SOURCE_TEXT,
    source_locale: "en",
    target_locale: B2_TARGET_LOCALE,
    string_key: B2_STRING_KEY,
    translation: B2_SUGGESTED_TRANSLATION,
    state: "submitted",
    decision: "none",
    payment_status: "none",
    payment_kind: "",
    payout_submitted: false,
    submit_by_unix: SUBMIT,
    recover_after_unix: RECOVER,
    submitted_at_unix: SUBMIT,
    decided_at_unix: 0,
    recovery_opens_at_unix: SUBMIT + 3600,
    client_nonce: NONCE,
  })!;
  return sourceBound({
    ...emptyB2Session(),
    translator: TRANSLATOR,
    translation: B2_SUGGESTED_TRANSLATION,
    rewardGen: "1",
    boundFunder: FUNDER,
    boundTranslator: TRANSLATOR,
    boundTranslation: B2_SUGGESTED_TRANSLATION,
    boundRewardWei: REWARD,
    boundRewardGen: "1",
    clientNonce: NONCE,
    expectedTaskId: taskId,
    submitByUnix: SUBMIT,
    recoverAfterUnix: RECOVER,
    create: { ...successAction(CREATE_TX), quotedValueWei: REWARD },
    submit: successAction(SUBMIT_TX),
    libraryCountBefore: 0,
    libraryCountAfter: 0,
    task,
  });
}

function withRejectProof(session: B2Session): B2Session {
  return {
    ...session,
    evaluate: {
      ...successAction(EVALUATE_TX),
      actualFeeAvailable: true,
      actualFeeWei: FEE.toString(),
      actualFeeSource: "primary_fee_spent",
    },
    task: {
      ...session.task!,
      state: "rejected",
      decision: "rejected",
      payment_kind: "refund",
      payout_submitted: true,
    },
    libraryCountBefore: 0,
    libraryCountAfter: 0,
    libraryEntry: undefined,
    transfer: transferTo(FUNDER, EVALUATE_TX),
    beforeEvaluate: {
      funder: FUNDER,
      named: TRANSLATOR,
      contract: B2_CONTRACT_ADDRESS,
      funderWei: (10n ** 20n).toString(),
      namedWei: (10n ** 19n).toString(),
      contractWei: REWARD,
      unixMs: 1,
    },
    afterWait: {
      funder: FUNDER,
      named: TRANSLATOR,
      contract: B2_CONTRACT_ADDRESS,
      funderWei: (10n ** 20n + 10n ** 18n - FEE).toString(),
      namedWei: (10n ** 19n).toString(),
      contractWei: "0",
      unixMs: 2,
    },
  };
}

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

describe("Phase B2 isolation and copy", () => {
  it("uses a unique string key and the same English source with a contradictory Spanish suggestion", () => {
    expect(B2_SOURCE_TEXT).toBe("Your order is on the way.");
    expect(B2_STRING_KEY).toBe("phase_b2.checkout.delivery.on_the_way");
    expect(B2_STRING_KEY).not.toBe(B1_STRING_KEY);
    expect(B2_SUGGESTED_TRANSLATION).toBe("Tu pedido aún no ha sido enviado.");
    expect(emptyB2Session().translation).toBe(B2_SUGGESTED_TRANSLATION);
  });

  it("persists under the B2 key without touching Phase A or B1", () => {
    const session = emptyB2Session();
    session.create = successAction(CREATE_TX);
    saveB2Session(session);
    expect(localStorage.getItem(PRODUCT_B2_STORAGE_KEY)).toContain(CREATE_TX);
    expect(localStorage.getItem(PRODUCT_B1_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(PRODUCT_STORAGE_KEY)).toBeNull();
    expect(loadB2Session().address).toBe(B2_CONTRACT_ADDRESS);
    expect(loadB2Session().create.txId).toBe(CREATE_TX);
  });
});

describe("B2 roles, recover, never resubmit", () => {
  it("lets only the named translator estimate submit and only the funder estimate evaluate", async () => {
    const submitted = await readySubmittedSession();
    const created = { ...submitted, submit: { phase: "idle" as const }, task: { ...submitted.task!, state: "open", translation: "" }, boundTranslation: undefined };
    created.translation = B2_SUGGESTED_TRANSLATION;
    expect(submitEstimateAllowed(created, ctx()).ok).toBe(false);
    expect(submitEstimateAllowed(created, ctx({ wallet: TRANSLATOR })).ok).toBe(true);
    expect(evaluateEstimateAllowed(submitted, ctx({ wallet: TRANSLATOR })).ok).toBe(false);
    expect(evaluateEstimateAllowed(submitted, ctx()).ok).toBe(true);
    expect(createEstimateAllowed(submitted, ctx()).ok).toBe(false);
  });

  it("keeps recover disabled until recovery_opens_at_unix and never resubmits a stored evaluate hash", async () => {
    const submitted = await readySubmittedSession();
    const opens = submitted.task!.recovery_opens_at_unix;
    expect(recoverEstimateAllowed(submitted, ctx(), opens - 1).ok).toBe(false);
    expect(recoverEstimateAllowed(submitted, ctx(), opens).ok).toBe(true);
    submitted.evaluate = { phase: "waiting", txId: EVALUATE_TX, statusName: "ACCEPTED" };
    expect(neverResubmit(submitted.evaluate)).toBe("resume");
    expect(evaluateEstimateAllowed(submitted, ctx()).ok).toBe(false);
    const failed = {
      ...submitted,
      evaluate: { phase: "failed" as const, txId: EVALUATE_TX, statusName: "FINALIZED", parentSuccessful: false },
    };
    const next = retryFailedB1Action(failed, "evaluate");
    expect(next.evaluate.txId).toBeUndefined();
    expect(neverResubmit(failed.evaluate)).toBe("resume");
  });
});

describe("library unchanged on reject", () => {
  it("requires before/after counts to match and no entry for this task", () => {
    expect(libraryUnchangedForReject({ countBefore: 0, countAfter: 0, entry: undefined, taskId: "task-1" })).toEqual({ ok: true });
    expect(libraryUnchangedForReject({ countBefore: 0, countAfter: 1, entry: undefined, taskId: "task-1" }).ok).toBe(false);
    expect(libraryUnchangedForReject({ countBefore: undefined, countAfter: 0, entry: undefined, taskId: "task-1" }).ok).toBe(false);
    const entry = parseLibraryEntry({
      version: 1,
      task_id: "task-1",
      translation: B2_SUGGESTED_TRANSLATION,
      string_key: B2_STRING_KEY,
      locale: B2_TARGET_LOCALE,
    });
    expect(libraryUnchangedForReject({ countBefore: 1, countAfter: 1, entry, taskId: "task-1" }).ok).toBe(false);
  });
});

describe("Phase B2 verdict is rejection-only", () => {
  it("stays UNPROVEN while submitted after a failed evaluate", async () => {
    const submitted = await readySubmittedSession();
    submitted.evaluate = {
      phase: "failed",
      txId: EVALUATE_TX,
      statusName: "FINALIZED",
      executionName: "FINISHED_WITH_ERROR",
      parentSuccessful: false,
    };
    const overall = overallB2Verdict(submitted);
    expect(overall.verdict).toBe("UNPROVEN");
    expect(overall.unexpectedApproval).toBe(false);
    expect(overall.reason).toMatch(/stays submitted|recovery_opens_at_unix/i);
    expect(JSON.parse(buildB2EvidencePayload({ wallet: FUNDER, chainId: 61997, session: submitted })).live_result).toBe(
      "UNPROVEN",
    );
  });

  it("proves YES only for a rejected refund with unchanged library and funder child credit", async () => {
    const session = withRejectProof(await readySubmittedSession());
    const overall = overallB2Verdict(session);
    expect(overall.verdict).toBe("YES");
    expect(overall.unexpectedApproval).toBe(false);
    expect(overall.reason).toMatch(/rejection proven/i);
    const payload = JSON.parse(buildB2EvidencePayload({ wallet: FUNDER, chainId: 61997, session }));
    expect(payload.live_result).toBe("YES");
    expect(payload.intent).toBe("evaluate_rejection");
    session.libraryCountAfter = 1;
    expect(overallB2Verdict(session).verdict).toBe("UNPROVEN");
  });

  it("does not label B2 rejection YES when AI approves, and reports the payout", async () => {
    const submitted = await readySubmittedSession();
    const approved: B2Session = {
      ...submitted,
      evaluate: successAction(EVALUATE_TX),
      task: {
        ...submitted.task!,
        state: "approved",
        decision: "approved",
        payment_kind: "payout",
        payout_submitted: true,
      },
      libraryCountAfter: 1,
      libraryEntry: parseLibraryEntry({
        version: 1,
        task_id: submitted.expectedTaskId,
        translation: B2_SUGGESTED_TRANSLATION,
        source_text: B2_SOURCE_TEXT,
        string_key: B2_STRING_KEY,
        locale: B2_TARGET_LOCALE,
      }),
      transfer: transferTo(TRANSLATOR, EVALUATE_TX),
      beforeEvaluate: {
        funder: FUNDER,
        named: TRANSLATOR,
        contract: B2_CONTRACT_ADDRESS,
        funderWei: (10n ** 20n).toString(),
        namedWei: (10n ** 19n).toString(),
        contractWei: REWARD,
        unixMs: 1,
      },
      afterWait: {
        funder: FUNDER,
        named: TRANSLATOR,
        contract: B2_CONTRACT_ADDRESS,
        funderWei: (10n ** 20n).toString(),
        namedWei: (10n ** 19n + 10n ** 18n).toString(),
        contractWei: "0",
        unixMs: 2,
      },
    };
    const overall = overallB2Verdict(approved);
    expect(overall.verdict).toBe("UNPROVEN");
    expect(overall.unexpectedApproval).toBe(true);
    expect(overall.reason).toMatch(/approved/i);
    expect(overall.reason).not.toMatch(/Phase B2 evaluate rejection proven/i);
    const payload = JSON.parse(buildB2EvidencePayload({ wallet: FUNDER, chainId: 61997, session: approved }));
    expect(payload.live_result).toBe("UNPROVEN");
    expect(payload.unexpectedApproval).toBe(true);
  });

  it("does not treat recover timeout as a B2 evaluate rejection", async () => {
    const session = withRejectProof(await readySubmittedSession());
    session.task = {
      ...session.task!,
      state: "timed_out",
      decision: "timed_out",
      payment_kind: "refund",
    };
    const overall = overallB2Verdict(session);
    expect(overall.verdict).toBe("UNPROVEN");
    expect(overall.unexpectedApproval).toBe(false);
    expect(overall.reason).toMatch(/timed out/i);
  });

  it("exports Copy JSON as UNPROVEN with no invented receipts before a live run", () => {
    const payload = JSON.parse(buildB2EvidencePayload({ session: emptyB2Session() }));
    expect(payload.live_result).toBe("UNPROVEN");
    expect(payload.intent).toBe("evaluate_rejection");
    expect(payload.create.txId).toBeNull();
    expect(payload.submit.txId).toBeNull();
    expect(payload.evaluate.txId).toBeNull();
    expect(payload.contract.address).toBe(B2_CONTRACT_ADDRESS);
    expect(payload.contract.reusedExistingDeploy).toBe(true);
  });
});
