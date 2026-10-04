import { beforeEach, describe, expect, it } from "vitest";
import { PRODUCT_STORAGE_KEY } from "../../src/live/product/constants";
import { clearStaleGetTaskErrors, errorAfterSuccessfulRefresh } from "../../src/live/product/staleErrors";
import { parseProductTask } from "../../src/live/product/task";
import { expectedTaskId } from "../../src/live/product/taskId";
import {
  B1_CONTRACT_ADDRESS,
  B1_SEMANTIC_CRITERIA,
  B1_SOURCE_TEXT,
  B1_STRING_KEY,
  B1_TARGET_LOCALE,
  PRODUCT_B1_STORAGE_KEY,
} from "../../src/live/productB1/constants";
import { buildB1EvidencePayload, evaluateSettlement, overallB1Verdict } from "../../src/live/productB1/evidence";
import {
  bindB1CreateEstimateIdentity,
  connectedB1Role,
  createEstimateAllowed,
  createSignAllowed,
  evaluateEstimateAllowed,
  neverResubmit,
  recoverEstimateAllowed,
  retryFailedB1Action,
  submitEstimateAllowed,
  type B1WriteContext,
} from "../../src/live/productB1/guards";
import { assertNoLibraryForTask, libraryEntryMatchesTask, parseLibraryEntry } from "../../src/live/productB1/library";
import {
  bindB1Funder,
  bindB1Translator,
  emptyB1Session,
  invalidateB1UnsignedQuotes,
  loadB1Session,
  resetB1TransientPhases,
  saveB1Session,
  type B1ActionRecord,
  type B1Session,
} from "../../src/live/productB1/persist";
import { b1QuoteInvalidReason, b1QuoteStillValid, currentB1QuoteBinding } from "../../src/live/productB1/quotes";

const FUNDER = "0x1111111111111111111111111111111111111111";
const TRANSLATOR = "0x2222222222222222222222222222222222222222";
const OTHER = "0x5555555555555555555555555555555555555555";
const NONCE = "phase-b1-nonce-1";
const REWARD = (10n ** 18n).toString();
const SUBMIT = 1_800_000_000;
const RECOVER = SUBMIT + 3600;
const CREATE_TX = `0x${"aa".repeat(32)}`;
const SUBMIT_TX = `0x${"bb".repeat(32)}`;
const EVALUATE_TX = `0x${"cc".repeat(32)}`;
const RECOVER_TX = `0x${"dd".repeat(32)}`;
const CHILD_TX = `0x${"ee".repeat(32)}`;
const TRANSLATION = "Tu pedido ya va en camino.";

function ctx(overrides: Partial<B1WriteContext> = {}): B1WriteContext {
  return {
    wallet: FUNDER,
    chainId: 61997,
    connected: true,
    ...overrides,
  };
}

function successAction(txId: string): B1ActionRecord {
  return {
    phase: "success",
    txId,
    statusName: "FINALIZED",
    executionName: "FINISHED_WITH_RETURN",
    parentSuccessful: true,
  };
}

function sourceBound(session: B1Session): B1Session {
  return {
    ...session,
    address: B1_CONTRACT_ADDRESS,
    sourceMatch: true,
    sourceVerifyStatus: "match",
    sourceVerifyReason: "matched",
    sourceVerifiedAddress: B1_CONTRACT_ADDRESS,
    sourceVerifiedLocalSha256: "local-sha",
    localSourceSha256: "local-sha",
  };
}

function taskFields(overrides: Record<string, unknown> = {}) {
  return {
    task_id: "will-replace",
    funder: FUNDER,
    translator: TRANSLATOR,
    reward: REWARD,
    source_text: B1_SOURCE_TEXT,
    source_locale: "en",
    target_locale: B1_TARGET_LOCALE,
    string_key: B1_STRING_KEY,
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
    client_nonce: NONCE,
    app_context: "Checkout delivery status line shown after payment.",
    intended_meaning: "The customer's paid order has already left and is in transit to them.",
    semantic_criteria: B1_SEMANTIC_CRITERIA,
    ...overrides,
  };
}

async function readyCreatedSession(): Promise<B1Session> {
  const taskId = await expectedTaskId(FUNDER, B1_CONTRACT_ADDRESS, NONCE);
  const task = parseProductTask({ ...taskFields(), task_id: taskId })!;
  return sourceBound({
    ...emptyB1Session(),
    translator: TRANSLATOR,
    rewardGen: "1",
    boundFunder: FUNDER,
    boundTranslator: TRANSLATOR,
    boundRewardWei: REWARD,
    boundRewardGen: "1",
    clientNonce: NONCE,
    expectedTaskId: taskId,
    submitByUnix: SUBMIT,
    recoverAfterUnix: RECOVER,
    create: { ...successAction(CREATE_TX), quotedValueWei: REWARD },
    task,
  });
}

async function readySubmittedSession(): Promise<B1Session> {
  const created = await readyCreatedSession();
  return {
    ...created,
    boundTranslation: TRANSLATION,
    translation: TRANSLATION,
    submit: successAction(SUBMIT_TX),
    task: {
      ...created.task!,
      state: "submitted",
      translation: TRANSLATION,
      submitted_at_unix: SUBMIT,
      recovery_opens_at_unix: SUBMIT + 3600,
    },
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

describe("Phase B1 persist isolation", () => {
  it("stores under the B1 key and pins the existing contract address", () => {
    const session = emptyB1Session();
    session.create = successAction(CREATE_TX);
    saveB1Session(session);
    expect(localStorage.getItem(PRODUCT_B1_STORAGE_KEY)).toContain(CREATE_TX);
    expect(localStorage.getItem(PRODUCT_STORAGE_KEY)).toBeNull();
    const loaded = loadB1Session();
    expect(loaded.address).toBe(B1_CONTRACT_ADDRESS);
    expect(loaded.create.txId).toBe(CREATE_TX);
  });

  it("does not adopt a stored address other than the existing deploy", () => {
    localStorage.setItem(
      PRODUCT_B1_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        address: OTHER,
        translator: "",
        translation: "",
        rewardGen: "",
        sourceMatch: false,
        sourceVerifyStatus: "idle",
        sourceVerifyReason: "",
        create: { phase: "idle" },
        submit: { phase: "idle" },
        evaluate: { phase: "idle" },
        recover: { phase: "idle" },
        paymentEvidence: "UNPROVEN",
        paymentReason: "",
      }),
    );
    expect(loadB1Session().address).toBe(B1_CONTRACT_ADDRESS);
  });

  it("uses checkout copy with Spanish semantic criteria", () => {
    expect(B1_SOURCE_TEXT).toBe("Your order is on the way.");
    expect(B1_SEMANTIC_CRITERIA).toMatch(/camino/i);
    expect(B1_STRING_KEY).toBe("checkout.delivery.on_the_way");
  });
});

describe("account switching without mixing evidence", () => {
  it("keeps create enabled for the funder after translator is bound at estimate", async () => {
    let session = sourceBound({
      ...emptyB1Session(),
      translator: TRANSLATOR,
      rewardGen: "1",
    });
    session = await bindB1CreateEstimateIdentity(session, { funder: FUNDER, nonceFactory: () => NONCE, nowUnix: SUBMIT - 1800 });
    expect(session.boundTranslator).toBe(TRANSLATOR);
    expect(connectedB1Role(session, FUNDER)).toBe("unbound");
    expect(createEstimateAllowed(session, ctx()).ok).toBe(true);
    expect(createSignAllowed(session, ctx()).ok).toBe(true);
    expect(createEstimateAllowed(session, ctx({ wallet: TRANSLATOR })).ok).toBe(false);
  });

  it("binds funder once and rejects a third wallet after create", async () => {
    const created = await readyCreatedSession();
    expect(connectedB1Role(created, FUNDER)).toBe("funder");
    expect(connectedB1Role(created, TRANSLATOR)).toBe("translator");
    expect(connectedB1Role(created, OTHER)).toBe("other");
    expect(bindB1Funder(created, OTHER).boundFunder).toBe(FUNDER);
    expect(bindB1Translator(created, OTHER).boundTranslator).toBe(TRANSLATOR);
    const blocked = createEstimateAllowed(created, ctx({ wallet: OTHER }));
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toMatch(/third account|funder/i);
  });

  it("allows only the named translator to estimate submit", async () => {
    const created = await readyCreatedSession();
    created.translation = TRANSLATION;
    expect(submitEstimateAllowed(created, ctx()).ok).toBe(false);
    expect(submitEstimateAllowed(created, ctx({ wallet: TRANSLATOR })).ok).toBe(true);
    expect(submitEstimateAllowed(created, ctx({ wallet: OTHER })).ok).toBe(false);
  });

  it("allows only the funder to estimate evaluate", async () => {
    const submitted = await readySubmittedSession();
    expect(evaluateEstimateAllowed(submitted, ctx({ wallet: TRANSLATOR })).ok).toBe(false);
    expect(evaluateEstimateAllowed(submitted, ctx()).ok).toBe(true);
  });
});

describe("recover gate and never resubmit", () => {
  it("keeps recover disabled until recovery_opens_at_unix", async () => {
    const submitted = await readySubmittedSession();
    const opens = submitted.task!.recovery_opens_at_unix;
    const early = recoverEstimateAllowed(submitted, ctx(), opens - 1);
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.reason).toMatch(/recovery opening time/i);
    expect(recoverEstimateAllowed(submitted, ctx(), opens).ok).toBe(true);
  });

  it("resumes a stored evaluate tx instead of resubmitting", async () => {
    const submitted = await readySubmittedSession();
    submitted.evaluate = { phase: "waiting", txId: EVALUATE_TX, statusName: "ACCEPTED" };
    expect(neverResubmit(submitted.evaluate)).toBe("resume");
    const blocked = evaluateEstimateAllowed(submitted, ctx());
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toMatch(/Resume tracking|do not resubmit/i);
  });

  it("New attempt on a failed evaluate drops the old hash and does not resubmit it", async () => {
    const submitted = await readySubmittedSession();
    submitted.evaluate = {
      phase: "failed",
      txId: EVALUATE_TX,
      statusName: "FINALIZED",
      parentSuccessful: false,
    };
    const next = retryFailedB1Action(submitted, "evaluate");
    expect(next.evaluate.txId).toBeUndefined();
    expect(next.evaluate.phase).toBe("idle");
    expect(neverResubmit(submitted.evaluate)).toBe("resume");
    expect(evaluateEstimateAllowed(next, ctx()).ok).toBe(true);
  });

  it("drops unsigned quotes on wallet switch without clearing stored tx IDs", () => {
    const session = emptyB1Session();
    session.submit = {
      phase: "quoted",
      quotedFeeWei: "1",
      quotedBinding: currentB1QuoteBinding({
        method: "submit",
        valueWei: "0",
        wallet: TRANSLATOR,
        chainId: 61997,
        taskId: "abc",
        translation: TRANSLATION,
      }),
    };
    session.create = successAction(CREATE_TX);
    const next = invalidateB1UnsignedQuotes(session);
    expect(next.submit.phase).toBe("idle");
    expect(next.submit.quotedFeeWei).toBeUndefined();
    expect(next.create.txId).toBe(CREATE_TX);
  });

  it("resets quoting/signing phases that have no tx ID on reload", () => {
    const session = emptyB1Session();
    session.create = { phase: "quoting" };
    session.submit = { phase: "signing" };
    session.evaluate = { phase: "waiting", txId: EVALUATE_TX };
    const durable = resetB1TransientPhases(session);
    expect(durable.create.phase).toBe("idle");
    expect(durable.submit.phase).toBe("idle");
    expect(durable.evaluate.txId).toBe(EVALUATE_TX);
  });
});

describe("B1 quote binding", () => {
  const base = {
    wallet: FUNDER,
    chainId: 61997,
    contract: B1_CONTRACT_ADDRESS,
    translator: TRANSLATOR,
    method: "create" as const,
    valueWei: REWARD,
    clientNonce: NONCE,
    submitByUnix: SUBMIT,
    recoverAfterUnix: RECOVER,
    taskId: null as string | null,
    translation: null as string | null,
  };

  it("invalidates when the connected wallet changes", () => {
    const stored = currentB1QuoteBinding(base);
    expect(b1QuoteStillValid(stored, currentB1QuoteBinding({ ...base, wallet: OTHER }))).toBe(false);
    expect(b1QuoteInvalidReason(stored, currentB1QuoteBinding({ ...base, wallet: OTHER }))).toMatch(/wallet changed/i);
  });

  it("invalidates submit quotes when translation text changes", () => {
    const stored = currentB1QuoteBinding({
      ...base,
      method: "submit",
      valueWei: "0",
      wallet: TRANSLATOR,
      taskId: "abc",
      translation: TRANSLATION,
    });
    const current = currentB1QuoteBinding({
      ...base,
      method: "submit",
      valueWei: "0",
      wallet: TRANSLATOR,
      taskId: "abc",
      translation: "Otro texto.",
    });
    expect(b1QuoteInvalidReason(stored, current)).toMatch(/Translation text changed/i);
  });
});

describe("library match and absence", () => {
  it("requires the exact task-linked library version on approval", () => {
    const entry = parseLibraryEntry({
      version: 2,
      task_id: "task-1",
      translation: TRANSLATION,
      source_text: B1_SOURCE_TEXT,
      string_key: B1_STRING_KEY,
      locale: B1_TARGET_LOCALE,
      approved_at_unix: SUBMIT,
    });
    expect(
      libraryEntryMatchesTask({
        entry,
        taskId: "task-1",
        translation: TRANSLATION,
        stringKey: B1_STRING_KEY,
        locale: B1_TARGET_LOCALE,
      }),
    ).toEqual({ ok: true });
    expect(
      libraryEntryMatchesTask({
        entry,
        taskId: "other",
        translation: TRANSLATION,
        stringKey: B1_STRING_KEY,
        locale: B1_TARGET_LOCALE,
      }).ok,
    ).toBe(false);
  });

  it("rejects a library entry for this task on reject/timeout", () => {
    const entry = parseLibraryEntry({
      version: 1,
      task_id: "task-1",
      translation: TRANSLATION,
      string_key: B1_STRING_KEY,
      locale: B1_TARGET_LOCALE,
    });
    expect(assertNoLibraryForTask({ count: 1, entry, taskId: "task-1" }).ok).toBe(false);
    expect(assertNoLibraryForTask({ count: 3, entry: { ...entry!, task_id: "other" }, taskId: "task-1" }).ok).toBe(true);
    expect(assertNoLibraryForTask({ count: undefined, entry: undefined, taskId: "task-1" }).ok).toBe(false);
  });
});

describe("stale get_task errors on B1 refresh", () => {
  it("clears get_task-prefixed action errors after a successful read", () => {
    const session = emptyB1Session();
    session.create = { phase: "success", error: "get_task failed: An unknown RPC error occurred." };
    session.submit = { phase: "idle", error: "get_task after submit: timeout" };
    session.evaluate = { phase: "idle", error: "wallet rejected" };
    const next = clearStaleGetTaskErrors(session);
    expect(next.create.error).toBeUndefined();
    expect(next.submit.error).toBeUndefined();
    expect(next.evaluate.error).toBe("wallet rejected");
    expect(errorAfterSuccessfulRefresh({ getTaskOk: true, getTaskError: session.create.error })).toBeUndefined();
  });
});

describe("verdict columns stay separate and UNPROVEN until live txs", () => {
  it("stays UNPROVEN while the task is still submitted", async () => {
    const submitted = await readySubmittedSession();
    submitted.evaluate = {
      phase: "failed",
      txId: EVALUATE_TX,
      statusName: "FINALIZED",
      executionName: "FINISHED_WITH_ERROR",
      parentSuccessful: false,
    };
    const overall = overallB1Verdict(submitted);
    expect(overall.verdict).toBe("UNPROVEN");
    expect(overall.reason).toMatch(/stays submitted|recovery_opens_at_unix/i);
    const payload = JSON.parse(buildB1EvidencePayload({ wallet: FUNDER, chainId: 61997, session: submitted }));
    expect(payload.live_result).toBe("UNPROVEN");
    expect(payload.reusedExistingDeploy).toBeUndefined();
    expect(payload.contract.reusedExistingDeploy).toBe(true);
    expect(payload.contract.address).toBe(B1_CONTRACT_ADDRESS);
  });

  it("does not treat parent success as translator payout", () => {
    const result = evaluateSettlement({
      parentSuccessful: true,
      statusName: "FINALIZED",
      executionName: "FINISHED_WITH_RETURN",
      parentTxId: EVALUATE_TX,
      rewardWei: 10n ** 18n,
      recipient: TRANSLATOR,
      otherParty: FUNDER,
      otherMustNotGain: true,
      transfer: { outgoing: [], children: [], parseOk: false, parseNote: "none" },
      actualFee: { available: true, feeWei: 1n, source: "receipt", reason: "fee" },
      recipientIsFunder: false,
    });
    expect(result.verdict).toBe("UNPROVEN");
    expect(result.reason).toMatch(/child value_credited|Outgoing EthSend/i);
  });

  it("allows a negative funder fee delta on translator payout", () => {
    const fee = 126310500000823n;
    const result = evaluateSettlement({
      parentSuccessful: true,
      statusName: "FINALIZED",
      executionName: "FINISHED_WITH_RETURN",
      parentTxId: EVALUATE_TX,
      rewardWei: 10n ** 18n,
      recipient: TRANSLATOR,
      otherParty: FUNDER,
      otherMustNotGain: true,
      transfer: transferTo(TRANSLATOR, EVALUATE_TX),
      before: { funder: FUNDER, named: TRANSLATOR, contract: B1_CONTRACT_ADDRESS, funderWei: (10n ** 20n).toString(), namedWei: (10n ** 19n).toString(), contractWei: REWARD, unixMs: 1 },
      after: {
        funder: FUNDER,
        named: TRANSLATOR,
        contract: B1_CONTRACT_ADDRESS,
        funderWei: (10n ** 20n - fee).toString(),
        namedWei: (10n ** 19n + 10n ** 18n).toString(),
        contractWei: "0",
        unixMs: 2,
      },
      actualFee: { available: true, feeWei: fee, source: "receipt", reason: "fee" },
      recipientIsFunder: false,
    });
    expect(result.verdict).toBe("YES");
  });

  it("requires no library entry and a fee-adjusted funder refund on reject", async () => {
    const submitted = await readySubmittedSession();
    const fee = 126310500000823n;
    const session: B1Session = {
      ...submitted,
      evaluate: { ...successAction(EVALUATE_TX), actualFeeAvailable: true, actualFeeWei: fee.toString(), actualFeeSource: "receipt" },
      task: {
        ...submitted.task!,
        state: "rejected",
        decision: "rejected",
        payment_kind: "refund",
        payout_submitted: true,
      },
      libraryCountAfter: 0,
      libraryEntry: undefined,
      transfer: transferTo(FUNDER, EVALUATE_TX),
      beforeEvaluate: {
        funder: FUNDER,
        named: TRANSLATOR,
        contract: B1_CONTRACT_ADDRESS,
        funderWei: (10n ** 20n).toString(),
        namedWei: (10n ** 19n).toString(),
        contractWei: REWARD,
        unixMs: 1,
      },
      afterWait: {
        funder: FUNDER,
        named: TRANSLATOR,
        contract: B1_CONTRACT_ADDRESS,
        funderWei: (10n ** 20n + 10n ** 18n - fee).toString(),
        namedWei: (10n ** 19n).toString(),
        contractWei: "0",
        unixMs: 2,
      },
    };
    expect(overallB1Verdict(session).verdict).toBe("YES");
    session.libraryEntry = parseLibraryEntry({
      version: 1,
      task_id: session.expectedTaskId,
      translation: TRANSLATION,
      string_key: B1_STRING_KEY,
      locale: B1_TARGET_LOCALE,
    });
    expect(overallB1Verdict(session).verdict).toBe("UNPROVEN");
  });

  it("requires a matching library entry on approval", async () => {
    const submitted = await readySubmittedSession();
    const session: B1Session = {
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
        translation: TRANSLATION,
        source_text: B1_SOURCE_TEXT,
        string_key: B1_STRING_KEY,
        locale: B1_TARGET_LOCALE,
      }),
      transfer: transferTo(TRANSLATOR, EVALUATE_TX),
      beforeEvaluate: {
        funder: FUNDER,
        named: TRANSLATOR,
        contract: B1_CONTRACT_ADDRESS,
        funderWei: (10n ** 20n).toString(),
        namedWei: (10n ** 19n).toString(),
        contractWei: REWARD,
        unixMs: 1,
      },
      afterWait: {
        funder: FUNDER,
        named: TRANSLATOR,
        contract: B1_CONTRACT_ADDRESS,
        funderWei: (10n ** 20n).toString(),
        namedWei: (10n ** 19n + 10n ** 18n).toString(),
        contractWei: "0",
        unixMs: 2,
      },
    };
    expect(overallB1Verdict(session).verdict).toBe("YES");
    session.libraryEntry = undefined;
    expect(overallB1Verdict(session).verdict).toBe("UNPROVEN");
  });
});
