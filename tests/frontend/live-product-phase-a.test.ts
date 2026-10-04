import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { PRODUCT_STORAGE_KEY } from "../../src/live/product/constants";
import { evaluateCancelRefund, overallProductVerdict, PAYOUT_SUBMITTED_IS_NOT_PAYMENT } from "../../src/live/product/evidence";
import {
  bindCreateEstimateIdentity,
  cancelWriteAllowed,
  createEstimateAllowed,
  createSignAllowed,
  createWriteAllowed,
  deadlinesStale,
  deployWriteAllowed,
  hasTxId,
  isFinalizedSuccessful,
  neverResubmit,
  productActionWriteAllowed,
  productClearRisk,
  retryFailedProductAction,
  unsubmittedCreateNonce,
  type ProductWriteContext,
} from "../../src/live/product/guards";
import {
  emptyProductSession,
  invalidateProductUnsignedQuotes,
  loadProductSession,
  resetProductTransientPhases,
  saveProductSession,
  type ProductActionRecord,
  type ProductSession,
} from "../../src/live/product/persist";
import { currentProductQuoteBinding, productQuoteInvalidReason, productQuoteStillValid } from "../../src/live/product/quotes";
import {
  applySourceComparison,
  compareLocalToDeployed,
  extractPythonSource,
  invalidateStaleSourceMatch,
  sourceBindingStillValid,
} from "../../src/live/product/source";
import { errorAfterSuccessfulRefresh, isGetTaskPrefixedError } from "../../src/live/product/staleErrors";
import { genRewardError, genToWei, parseProductTask, sessionRewardWei, taskMatchesOpenCreate } from "../../src/live/product/task";
import { addressBytes, expectedTaskId, sha256Utf8 } from "../../src/live/product/taskId";
import {
  childReceiptIdsToFetch,
  collectTransferEvidence,
  enrichCancelRefundTransfer,
  enrichTransferWithChildReceipts,
  listedTxMatchesCancelChild,
  matchingChildCredit,
  preserveEnrichedTransfer,
  weiEquals,
} from "../../src/live/product/transfers";
import {
  STUDIO_DEV_CANCEL_CHILD_TX,
  STUDIO_DEV_CANCEL_PARENT_TX,
  STUDIO_DEV_FUNDER,
  STUDIO_DEV_PRODUCT_CONTRACT,
  STUDIO_DEV_REWARD_WEI,
  studioDevCancelAddressTxs,
  studioDevCancelChildReceipt,
  studioDevCancelParentReceipt,
} from "./fixtures/studio-dev-cancel-parent-child";

const FUNDER = "0x1111111111111111111111111111111111111111";
const TRANSLATOR = "0x2222222222222222222222222222222222222222";
const CONTRACT = "0x3333333333333333333333333333333333333333";
const OTHER = "0x5555555555555555555555555555555555555555";
const NONCE = "phase-a-nonce-1";
const REWARD = (10n ** 18n).toString(); // 1 GEN
const SUBMIT = 1_800_000_000;
const RECOVER = SUBMIT + 3600;
const CREATE_TX = `0x${"aa".repeat(32)}`;
const CANCEL_TX = `0x${"bb".repeat(32)}`;
const DEPLOY_TX = `0x${"cc".repeat(32)}`;

function ctx(overrides: Partial<ProductWriteContext> = {}): ProductWriteContext {
  return {
    funder: FUNDER,
    chainId: 61997,
    translator: TRANSLATOR,
    connected: true,
    ...overrides,
  };
}

function successAction(txId: string): ProductActionRecord {
  return {
    phase: "success",
    txId,
    statusName: "FINALIZED",
    executionName: "FINISHED_WITH_RETURN",
    parentSuccessful: true,
  };
}

function openTask() {
  return parseProductTask({
    task_id: "will-replace",
    funder: FUNDER,
    translator: TRANSLATOR,
    reward: REWARD,
    source_text: "Phase A live product test.",
    source_locale: "en",
    target_locale: "es",
    string_key: "phase_a.test",
    translation: "",
    state: "open",
    decision: "none",
    payment_status: "none",
    payment_kind: "",
    payout_submitted: false,
    submit_by_unix: SUBMIT,
    recover_after_unix: RECOVER,
    client_nonce: NONCE,
  })!;
}

async function readyCreateSession(): Promise<ProductSession> {
  const taskId = await expectedTaskId(FUNDER, CONTRACT, NONCE);
  const task = { ...openTask(), task_id: taskId };
  return {
    ...emptyProductSession(),
    translator: TRANSLATOR,
    rewardGen: "1",
    address: CONTRACT,
    sourceMatch: true,
    sourceVerifyStatus: "match",
    sourceVerifyReason: "matched",
    sourceVerifiedAddress: CONTRACT,
    sourceVerifiedLocalSha256: "local-sha",
    localSourceSha256: "local-sha",
    boundRewardWei: REWARD,
    boundRewardGen: "1",
    boundFunder: FUNDER,
    boundTranslator: TRANSLATOR,
    clientNonce: NONCE,
    expectedTaskId: taskId,
    submitByUnix: SUBMIT,
    recoverAfterUnix: RECOVER,
    deploy: successAction(DEPLOY_TX),
    create: { ...successAction(CREATE_TX), snapshot: task },
    createTask: task,
    cancel: { phase: "idle" },
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

describe("product quote binding", () => {
  const base = {
    wallet: FUNDER,
    chainId: 61997,
    contract: CONTRACT,
    translator: TRANSLATOR,
    method: "create" as const,
    valueWei: REWARD,
    clientNonce: NONCE,
    submitByUnix: SUBMIT,
    recoverAfterUnix: RECOVER,
    taskId: null,
  };

  it("invalidates when the connected wallet changes", () => {
    const stored = currentProductQuoteBinding(base);
    const current = currentProductQuoteBinding({ ...base, wallet: OTHER });
    expect(productQuoteStillValid(stored, current)).toBe(false);
    expect(productQuoteInvalidReason(stored, current)).toMatch(/wallet changed/i);
  });

  it("invalidates when the chain changes", () => {
    const stored = currentProductQuoteBinding(base);
    const current = currentProductQuoteBinding({ ...base, chainId: 1 });
    expect(productQuoteStillValid(stored, current)).toBe(false);
    expect(productQuoteInvalidReason(stored, current)).toMatch(/chain/i);
  });

  it("invalidates a stale create quote when attached reward changes", () => {
    const stored = currentProductQuoteBinding(base);
    const current = currentProductQuoteBinding({ ...base, valueWei: "2" });
    expect(productQuoteInvalidReason(stored, current)).toMatch(/Attached value changed/i);
  });

  it("invalidates when client_nonce or deadlines change", () => {
    const stored = currentProductQuoteBinding(base);
    expect(productQuoteInvalidReason(stored, currentProductQuoteBinding({ ...base, clientNonce: "other" }))).toMatch(/client_nonce/i);
    expect(productQuoteInvalidReason(stored, currentProductQuoteBinding({ ...base, submitByUnix: SUBMIT + 1 }))).toMatch(/Deadlines/i);
  });

  it("keeps a matching quote", () => {
    const stored = currentProductQuoteBinding(base);
    expect(productQuoteStillValid(stored, currentProductQuoteBinding(base))).toBe(true);
  });
});

describe("create-to-cancel gating", () => {
  function readyForCreateEstimate(): ProductSession {
    return {
      ...emptyProductSession(),
      translator: TRANSLATOR,
      rewardGen: "1",
      address: CONTRACT,
      sourceMatch: true,
      sourceVerifyStatus: "match",
      sourceVerifyReason: "matched",
      sourceVerifiedAddress: CONTRACT,
      sourceVerifiedLocalSha256: "local-sha",
      localSourceSha256: "local-sha",
      deploy: successAction(DEPLOY_TX),
    };
  }

  it("enables Create Estimate with finalized deploy, verified source, translator, reward, and no nonce", () => {
    const session = readyForCreateEstimate();
    expect(session.clientNonce).toBeUndefined();
    expect(createEstimateAllowed(session, ctx(), 10n ** 18n)).toEqual({ ok: true });
    expect(createWriteAllowed(session, ctx(), 10n ** 18n)).toEqual({ ok: true });
    const sign = createSignAllowed(session, ctx(), 10n ** 18n);
    expect(sign.ok).toBe(false);
    if (!sign.ok) expect(sign.reason).toMatch(/client_nonce|Estimate first/i);
    const cancel = cancelWriteAllowed(session, ctx(), 10n ** 18n);
    expect(cancel.ok).toBe(false);
    if (!cancel.ok) expect(cancel.reason).toMatch(/create_task/i);
  });

  it("keeps the same nonce across estimate retries for an unsubmitted create attempt", async () => {
    let session = readyForCreateEstimate();
    session = await bindCreateEstimateIdentity(session, {
      funder: FUNDER,
      nonceFactory: () => "nonce-a",
      nowUnix: SUBMIT - 1800,
    });
    expect(session.clientNonce).toBe("nonce-a");
    const firstTaskId = session.expectedTaskId;
    expect(firstTaskId).toBeTruthy();
    session = await bindCreateEstimateIdentity(session, {
      funder: FUNDER,
      nonceFactory: () => "nonce-b",
      nowUnix: SUBMIT - 1700,
    });
    expect(session.clientNonce).toBe("nonce-a");
    expect(session.expectedTaskId).toBe(firstTaskId);
    expect(session.submitByUnix).toBe(SUBMIT - 1700 + 1800);
    expect(session.recoverAfterUnix).toBe(SUBMIT - 1700 + 5400);
    expect(createSignAllowed(session, ctx(), 10n ** 18n)).toEqual({ ok: true });
  });

  it("binds create deadlines to the provided GenVM now, not the browser clock", async () => {
    const genvmNow = 1_732_604_000;
    const session = await bindCreateEstimateIdentity(readyForCreateEstimate(), {
      funder: FUNDER,
      nonceFactory: () => "nonce-clock",
      nowUnix: genvmNow,
    });
    expect(session.submitByUnix).toBe(genvmNow + 1800);
    expect(session.recoverAfterUnix).toBe(genvmNow + 5400);
    const wall = genvmNow + 58_000_000;
    expect(deadlinesStale(session.submitByUnix, genvmNow)).toBe(false);
    expect(deadlinesStale(session.submitByUnix, wall)).toBe(true);
  });

  it("never reuses a nonce after a submitted create transaction", async () => {
    const session = readyForCreateEstimate();
    session.clientNonce = "old-nonce";
    session.create = { phase: "submitted", txId: CREATE_TX };
    expect(unsubmittedCreateNonce(session)).toBeUndefined();
    const next = await bindCreateEstimateIdentity(session, {
      funder: FUNDER,
      nonceFactory: () => "new-nonce",
      nowUnix: SUBMIT - 1800,
    });
    expect(next.clientNonce).toBe("old-nonce");
    expect(next.create.txId).toBe(CREATE_TX);
    expect(createEstimateAllowed(next, ctx(), 10n ** 18n).ok).toBe(false);
  });

  it("blocks cancel when create is FINALIZED with FINISHED_WITH_ERROR", async () => {
    const ready = await readyCreateSession();
    ready.create = {
      phase: "failed",
      txId: CREATE_TX,
      statusName: "FINALIZED",
      executionName: "FINISHED_WITH_ERROR",
      parentSuccessful: false,
    };
    const blocked = cancelWriteAllowed(ready, ctx(), 10n ** 18n);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toMatch(/No open task|New attempt/i);
  });

  it("blocks cancel until create is finalized, successful, and get_task matches", async () => {
    const idle = emptyProductSession();
    idle.translator = TRANSLATOR;
    idle.rewardGen = "1";
    idle.address = CONTRACT;
    idle.sourceMatch = true;
    idle.sourceVerifyStatus = "match";
    idle.sourceVerifyReason = "matched";
    idle.deploy = successAction(DEPLOY_TX);
    expect(cancelWriteAllowed(idle, ctx(), 10n ** 18n).ok).toBe(false);
    expect(cancelWriteAllowed(idle, ctx(), 10n ** 18n).ok === false && cancelWriteAllowed(idle, ctx(), 10n ** 18n).reason).toMatch(/create_task/i);

    const ready = await readyCreateSession();
    const allowed = cancelWriteAllowed(ready, ctx(), 10n ** 18n);
    expect(allowed).toEqual({ ok: true });
  });

  it("blocks cancel when get_task is not open", async () => {
    const ready = await readyCreateSession();
    ready.createTask = { ...ready.createTask!, state: "cancelled" };
    const blocked = cancelWriteAllowed(ready, ctx(), 10n ** 18n);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toMatch(/open/i);
  });

  it("blocks cancel when funder, translator, reward, or task id diverge", async () => {
    const ready = await readyCreateSession();
    const wrongFunder = { ...ready, createTask: { ...ready.createTask!, funder: OTHER } };
    expect(cancelWriteAllowed(wrongFunder, ctx(), 10n ** 18n).ok).toBe(false);

    const wrongReward = { ...ready, createTask: { ...ready.createTask!, rewardWei: "1" } };
    expect(cancelWriteAllowed(wrongReward, ctx(), 10n ** 18n).ok).toBe(false);

    const wrongId = { ...ready, createTask: { ...ready.createTask!, task_id: "0".repeat(64) } };
    expect(cancelWriteAllowed(wrongId, ctx(), 10n ** 18n).ok).toBe(false);
  });

  it("blocks create until deploy is successful and source matches", () => {
    const session = emptyProductSession();
    session.translator = TRANSLATOR;
    session.rewardGen = "1";
    session.clientNonce = NONCE;
    expect(createWriteAllowed(session, ctx(), 10n ** 18n).ok).toBe(false);
    session.address = CONTRACT;
    session.deploy = successAction(DEPLOY_TX);
    session.sourceMatch = false;
    const blocked = createWriteAllowed(session, ctx(), 10n ** 18n);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toMatch(/source/i);
  });

  it("blocks create when a persisted source match is not bound to this address and hash", () => {
    const session = emptyProductSession();
    session.translator = TRANSLATOR;
    session.rewardGen = "1";
    session.clientNonce = NONCE;
    session.address = CONTRACT;
    session.deploy = successAction(DEPLOY_TX);
    session.sourceMatch = true;
    session.sourceVerifyStatus = "match";
    session.localSourceSha256 = "new-hash";
    session.sourceVerifiedAddress = OTHER;
    session.sourceVerifiedLocalSha256 = "old-hash";
    const blocked = createWriteAllowed(session, ctx(), 10n ** 18n);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toMatch(/source|SHA-256|address/i);
  });

  it("never treats a demo-equal translator as authorized", () => {
    const blocked = deployWriteAllowed(emptyProductSession(), ctx({ translator: FUNDER }));
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toMatch(/different EOA|demo role/i);
  });
});

describe("reload without resubmission", () => {
  it("drops quoting/signing phases that have no tx ID and keeps stored tx IDs", () => {
    const session = emptyProductSession();
    session.deploy = { phase: "quoting" };
    session.create = { phase: "signing", quotedFeeWei: "1" };
    session.cancel = { phase: "waiting", txId: CANCEL_TX, statusName: "ACCEPTED" };
    const durable = resetProductTransientPhases(session);
    expect(durable.deploy.phase).toBe("idle");
    expect(durable.create.phase).toBe("idle");
    expect(durable.cancel.txId).toBe(CANCEL_TX);
    expect(durable.cancel.phase).toBe("waiting");
    expect(neverResubmit(durable.cancel)).toBe("resume");
    expect(hasTxId(durable.cancel)).toBe(true);
  });

  it("persists tx IDs under the product storage key, not the settlement key", () => {
    const session = emptyProductSession();
    session.create = successAction(CREATE_TX);
    saveProductSession(session);
    expect(localStorage.getItem(PRODUCT_STORAGE_KEY)).toContain(CREATE_TX);
    expect(localStorage.getItem("localebounty.live-settlement.v2")).toBeNull();
    const loaded = loadProductSession();
    expect(loaded.create.txId).toBe(CREATE_TX);
    expect(isFinalizedSuccessful(loaded.create)).toBe(true);
  });

  it("does not resubmit after New attempt on a failed create — old tx stays unused", () => {
    const session = emptyProductSession();
    session.create = {
      phase: "failed",
      txId: CREATE_TX,
      statusName: "FINALIZED",
      parentSuccessful: false,
    };
    session.clientNonce = NONCE;
    const next = retryFailedProductAction(session, "create");
    expect(next.create.txId).toBeUndefined();
    expect(next.create.phase).toBe("idle");
    expect(next.clientNonce).toBeUndefined();
    expect(neverResubmit(session.create)).toBe("resume");
  });

  it("clears unsigned quotes on invalidate without dropping tx IDs", () => {
    const session = emptyProductSession();
    session.deploy = { phase: "quoted", quotedFeeWei: "1", quotedBinding: currentProductQuoteBinding({ method: "deploy", valueWei: "0", wallet: FUNDER, chainId: 61997 }) };
    session.create = successAction(CREATE_TX);
    const next = invalidateProductUnsignedQuotes(session);
    expect(next.deploy.phase).toBe("idle");
    expect(next.deploy.quotedFeeWei).toBeUndefined();
    expect(next.create.txId).toBe(CREATE_TX);
  });
});

describe("false payment-success prevention", () => {
  const reward = 10n ** 18n;
  const fee = 126304500000823n;

  it("does not claim refund paid from wallet confirmation or parent success alone", () => {
    const evalResult = evaluateCancelRefund({
      parentSuccessful: true,
      statusName: "FINALIZED",
      executionName: "FINISHED_WITH_RETURN",
      parentTxId: CANCEL_TX,
      rewardWei: reward,
      funder: FUNDER,
      named: TRANSLATOR,
      transfer: { outgoing: [], children: [], parseOk: false, parseNote: "none" },
      actualFee: { available: true, feeWei: fee, source: "primary_fee_spent", reason: "fee" },
    });
    expect(evalResult.verdict).toBe("UNPROVEN");
    expect(evalResult.reason.toLowerCase()).not.toContain("refund paid");
    expect(evalResult.transferLabel.toLowerCase()).not.toContain("refund paid");
  });

  it("does not claim refund paid when outgoing EthSend exists but child credit is missing", () => {
    const evalResult = evaluateCancelRefund({
      parentSuccessful: true,
      statusName: "FINALIZED",
      executionName: "FINISHED_WITH_RETURN",
      parentTxId: CANCEL_TX,
      rewardWei: reward,
      funder: FUNDER,
      named: TRANSLATOR,
      transfer: {
        outgoing: [{ recipient: FUNDER, valueWei: reward.toString(), isEthSend: true, messageType: "0" }],
        children: [],
        parseOk: true,
        parseNote: "outgoing only",
      },
      before: { funder: FUNDER, named: TRANSLATOR, contract: CONTRACT, funderWei: "0", namedWei: "0", contractWei: reward.toString(), unixMs: 1 },
      after: { funder: FUNDER, named: TRANSLATOR, contract: CONTRACT, funderWei: (reward - fee).toString(), namedWei: "0", contractWei: "0", unixMs: 2 },
      actualFee: { available: true, feeWei: fee, source: "primary_fee_spent", reason: "fee" },
    });
    expect(evalResult.verdict).toBe("UNPROVEN");
    expect(evalResult.reason.toLowerCase()).not.toContain("refund paid");
  });

  it("requires outgoing + child value_credited + fee-adjusted funder delta for YES", () => {
    const evalResult = evaluateCancelRefund({
      parentSuccessful: true,
      statusName: "FINALIZED",
      executionName: "FINISHED_WITH_RETURN",
      parentTxId: CANCEL_TX,
      rewardWei: reward,
      funder: FUNDER,
      named: TRANSLATOR,
      transfer: {
        outgoing: [{ recipient: FUNDER, valueWei: reward.toString(), isEthSend: true, messageType: "0", on: "finalized" }],
        children: [
          {
            found: true,
            txId: `0x${"dd".repeat(32)}`,
            triggeredBy: CANCEL_TX,
            triggeredOn: "finalized",
            to: FUNDER,
            valueWei: reward.toString(),
            valueCredited: true,
          },
        ],
        parseOk: true,
        parseNote: "parsed",
      },
      before: { funder: FUNDER, named: TRANSLATOR, contract: CONTRACT, funderWei: "1000000000000000000", namedWei: "0", contractWei: reward.toString(), unixMs: 1 },
      after: {
        funder: FUNDER,
        named: TRANSLATOR,
        contract: CONTRACT,
        funderWei: (10n ** 18n + reward - fee).toString(),
        namedWei: "0",
        contractWei: "0",
        unixMs: 2,
      },
      actualFee: { available: true, feeWei: fee, source: "primary_fee_spent", reason: "fee" },
    });
    expect(evalResult.verdict).toBe("YES");
    expect(evalResult.namedGainWei).toBe("0");
  });

  it("rejects a translator credit even if parent succeeded", () => {
    const evalResult = evaluateCancelRefund({
      parentSuccessful: true,
      statusName: "FINALIZED",
      executionName: "FINISHED_WITH_RETURN",
      parentTxId: CANCEL_TX,
      rewardWei: reward,
      funder: FUNDER,
      named: TRANSLATOR,
      transfer: {
        outgoing: [{ recipient: FUNDER, valueWei: reward.toString(), isEthSend: true }],
        children: [{ found: true, to: FUNDER, valueWei: reward.toString(), valueCredited: true, triggeredBy: CANCEL_TX }],
        parseOk: true,
        parseNote: "parsed",
      },
      before: { funder: FUNDER, named: TRANSLATOR, contract: CONTRACT, funderWei: "0", namedWei: "0", contractWei: "0", unixMs: 1 },
      after: { funder: FUNDER, named: TRANSLATOR, contract: CONTRACT, funderWei: (reward - fee).toString(), namedWei: "1", contractWei: "0", unixMs: 2 },
      actualFee: { available: true, feeWei: fee, source: "primary_fee_spent", reason: "fee" },
    });
    expect(evalResult.verdict).toBe("UNPROVEN");
    expect(evalResult.reason).toMatch(/translator/i);
  });
});

describe("source hash and task id", () => {
  it("hashes a known UTF-8 string to SHA-256", async () => {
    const hex = await sha256Utf8("LocaleBounty");
    const node = createHash("sha256").update("LocaleBounty", "utf8").digest("hex");
    expect(hex).toBe(node);
    expect(hex).toHaveLength(64);
  });

  it("hashes contracts/localebounty.py from disk", () => {
    const file = readFileSync(resolve("contracts/localebounty.py"));
    const hex = createHash("sha256").update(file).digest("hex");
    expect(hex).toHaveLength(64);
    expect(file.toString("utf8")).toContain("class LocaleBounty");
    expect(file.toString("utf8")).toContain("py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng");
  });

  it("derives task id as sha256(funder_bytes || contract_bytes || utf8(nonce))", async () => {
    const nonce = "abc";
    const id = await expectedTaskId(FUNDER, CONTRACT, nonce);
    const raw = Buffer.concat([Buffer.from(addressBytes(FUNDER)), Buffer.from(addressBytes(CONTRACT)), Buffer.from(nonce, "utf8")]);
    expect(id).toBe(createHash("sha256").update(raw).digest("hex"));
  });

  it("does not invent a source match when RPC returns no Python", async () => {
    const result = await compareLocalToDeployed("class LocaleBounty:\n    pass\n", { code: "0xdead" });
    expect(result.match).toBe(false);
    expect(result.status).toBe("UNPROVEN");
  });

  it("matches when RPC returns the same source", async () => {
    const source = "# { \"Depends\": \"py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng\" }\nclass LocaleBounty:\n    pass\n";
    const result = await compareLocalToDeployed(source, source);
    expect(result.match).toBe(true);
    expect(extractPythonSource(source)).toContain("class LocaleBounty");
  });
});

describe("transfer parser and overall verdict", () => {
  it("parses is_eth_send and value_credited from a nested receipt", () => {
    const evidence = collectTransferEvidence(
      {
        messages: [{ is_eth_send: true, messageType: "0", recipient: FUNDER, value: REWARD, on: "finalized" }],
        children: [{ triggered_by: CANCEL_TX, to: FUNDER, value_wei: REWARD, value_credited: true, tx_id: `0x${"ee".repeat(32)}` }],
      },
      CANCEL_TX,
    );
    expect(evidence.parseOk).toBe(true);
    expect(evidence.outgoing[0]?.recipient).toBe(FUNDER);
    expect(evidence.children[0]?.valueCredited).toBe(true);
  });

  it("starts UNPROVEN with no invented YES", () => {
    const overall = overallProductVerdict(emptyProductSession());
    expect(overall.verdict).toBe("UNPROVEN");
    expect(overall.reason).toMatch(/UNPROVEN/i);
  });

  it("genToWei parses user-chosen GEN", () => {
    expect(genToWei("0.5")).toBe(5n * 10n ** 17n);
    expect(genToWei("1")).toBe(10n ** 18n);
    expect(genToWei("")).toBeNull();
    expect(genToWei("x")).toBeNull();
    expect(genToWei("1.123456789012345678")).toBe(1123456789012345678n);
    expect(genToWei("1.1234567890123456789")).toBeNull();
    expect(genRewardError("1.1234567890123456789")).toMatch(/18 fractional digits/);
  });

  it("taskMatchesOpenCreate requires nonce-derived id", async () => {
    const taskId = await expectedTaskId(FUNDER, CONTRACT, NONCE);
    const task = { ...openTask(), task_id: taskId };
    expect(
      taskMatchesOpenCreate({
        task,
        funder: FUNDER,
        translator: TRANSLATOR,
        contract: CONTRACT,
        rewardWei: REWARD,
        clientNonce: NONCE,
        expectedTaskId: taskId,
        submitByUnix: SUBMIT,
        recoverAfterUnix: RECOVER,
      }),
    ).toEqual({ ok: true });
  });
});

describe("wrong-chain write guard", () => {
  it("rejects writes off Studio-dev 61997", () => {
    const blocked = productActionWriteAllowed("deploy", emptyProductSession(), ctx({ chainId: 1 }), 10n ** 18n);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toMatch(/61997/);
  });
});

describe("source match bound to address and PRODUCT_SOURCE hash", () => {
  it("invalidates a persisted match when the local hash changes", () => {
    const session = emptyProductSession();
    session.address = CONTRACT;
    session.sourceMatch = true;
    session.sourceVerifyStatus = "match";
    session.sourceVerifiedAddress = CONTRACT;
    session.sourceVerifiedLocalSha256 = "old-hash";
    session.localSourceSha256 = "old-hash";
    expect(sourceBindingStillValid(session, "old-hash")).toBe(true);
    const dropped = invalidateStaleSourceMatch(session, "new-hash");
    expect(dropped.sourceMatch).toBe(false);
    expect(dropped.sourceVerifyStatus).toBe("UNPROVEN");
    expect(dropped.sourceVerifiedAddress).toBeUndefined();
    expect(dropped.localSourceSha256).toBe("new-hash");
  });

  it("invalidates a persisted match when the contract address changes", () => {
    const session = emptyProductSession();
    session.address = OTHER;
    session.sourceMatch = true;
    session.sourceVerifiedAddress = CONTRACT;
    session.sourceVerifiedLocalSha256 = "same";
    const dropped = invalidateStaleSourceMatch(session, "same");
    expect(dropped.sourceMatch).toBe(false);
    expect(dropped.sourceVerifyReason).toMatch(/unbound|Recheck gen_getContractCode/i);
  });

  it("keeps a match only when address and current hash still bind", () => {
    const session = emptyProductSession();
    session.address = CONTRACT;
    session.sourceMatch = true;
    session.sourceVerifiedAddress = CONTRACT;
    session.sourceVerifiedLocalSha256 = "same";
    const kept = invalidateStaleSourceMatch(session, "same");
    expect(kept.sourceMatch).toBe(true);
    expect(sourceBindingStillValid(kept, "same")).toBe(true);
  });

  it("records the verified address and hash only after a live comparison match", async () => {
    const source = "class LocaleBounty:\n    pass\n";
    const compared = await compareLocalToDeployed(source, source);
    const applied = applySourceComparison(emptyProductSession(), compared, CONTRACT);
    expect(applied.sourceMatch).toBe(true);
    expect(applied.sourceVerifiedAddress).toBe(CONTRACT);
    expect(applied.sourceVerifiedLocalSha256).toBe(compared.localSha256);
  });
});

describe("bound create reward vs later GEN edits", () => {
  it("ignores rewardGen edits after create has a tx ID", async () => {
    const session = await readyCreateSession();
    session.rewardGen = "99";
    expect(sessionRewardWei(session)?.toString()).toBe(REWARD);
    expect(sessionRewardWei({ ...session, boundRewardWei: undefined, create: { ...session.create, quotedValueWei: undefined } })?.toString()).toBe(REWARD);
  });

  it("does not treat a stored paymentEvidence YES as overall proof", async () => {
    const session = await readyCreateSession();
    session.paymentEvidence = "YES";
    session.paymentReason = "stale stored flag";
    session.cancel = successAction(CANCEL_TX);
    session.cancel.executionName = "FINISHED_WITH_RETURN";
    session.cancelTask = { ...session.createTask!, state: "cancelled" };
    const overall = overallProductVerdict(session);
    expect(overall.verdict).toBe("UNPROVEN");
    expect(overall.reason).toMatch(/Stored paymentEvidence is not proof/i);
  });

  it("recomputes YES only from bound reward, get_task, cancel, transfer, fee, and balances", async () => {
    const fee = 126304500000823n;
    const session = await readyCreateSession();
    session.cancel = {
      ...successAction(CANCEL_TX),
      executionName: "FINISHED_WITH_RETURN",
      actualFeeAvailable: true,
      actualFeeWei: fee.toString(),
      actualFeeSource: "primary_fee_spent",
    };
    session.cancelTask = { ...session.createTask!, state: "cancelled" };
    session.transfer = {
      outgoing: [{ recipient: FUNDER, valueWei: REWARD, isEthSend: true, messageType: "0" }],
      children: [
        {
          found: true,
          txId: `0x${"dd".repeat(32)}`,
          triggeredBy: CANCEL_TX,
          to: FUNDER,
          valueWei: REWARD,
          valueCredited: true,
        },
      ],
      parseOk: true,
      parseNote: "parsed",
    };
    session.beforeCancel = {
      funder: FUNDER,
      named: TRANSLATOR,
      contract: CONTRACT,
      funderWei: "1000000000000000000",
      namedWei: "0",
      contractWei: REWARD,
      unixMs: 1,
    };
    session.afterWait = {
      funder: FUNDER,
      named: TRANSLATOR,
      contract: CONTRACT,
      funderWei: (10n ** 18n + 10n ** 18n - fee).toString(),
      namedWei: "0",
      contractWei: "0",
      unixMs: 2,
    };
    session.paymentEvidence = "UNPROVEN";
    const overall = overallProductVerdict(session);
    expect(overall.verdict).toBe("YES");
  });
});

describe("strict child credit matching", () => {
  const reward = REWARD;
  const childTx = `0x${"dd".repeat(32)}`;

  it("does not match a child missing triggered_by, recipient, or amount", () => {
    const incomplete = collectTransferEvidence({
      children: [{ value_credited: true, to: FUNDER, value_wei: reward }],
    });
    expect(matchingChildCredit(incomplete, FUNDER, reward, CANCEL_TX)).toBeUndefined();

    const wrongParent = collectTransferEvidence({
      children: [{ value_credited: true, to: FUNDER, value_wei: reward, triggered_by: CREATE_TX, tx_id: childTx }],
    });
    expect(matchingChildCredit(wrongParent, FUNDER, reward, CANCEL_TX)).toBeUndefined();

    const wrongTo = collectTransferEvidence({
      children: [{ value_credited: true, to: OTHER, value_wei: reward, triggered_by: CANCEL_TX, tx_id: childTx }],
    });
    expect(matchingChildCredit(wrongTo, FUNDER, reward, CANCEL_TX)).toBeUndefined();
  });

  it("keeps payment UNPROVEN when the child is incomplete even if parent succeeded", () => {
    const evalResult = evaluateCancelRefund({
      parentSuccessful: true,
      statusName: "FINALIZED",
      executionName: "FINISHED_WITH_RETURN",
      parentTxId: CANCEL_TX,
      rewardWei: 10n ** 18n,
      funder: FUNDER,
      named: TRANSLATOR,
      transfer: {
        outgoing: [{ recipient: FUNDER, valueWei: reward, isEthSend: true }],
        children: [{ found: true, txId: childTx, valueCredited: true, to: FUNDER, valueWei: reward }],
        parseOk: true,
        parseNote: "missing triggered_by",
      },
      before: { funder: FUNDER, named: TRANSLATOR, contract: CONTRACT, funderWei: "0", namedWei: "0", contractWei: reward, unixMs: 1 },
      after: { funder: FUNDER, named: TRANSLATOR, contract: CONTRACT, funderWei: "1", namedWei: "0", contractWei: "0", unixMs: 2 },
      actualFee: { available: true, feeWei: 1n, source: "primary_fee_spent", reason: "fee" },
    });
    expect(evalResult.verdict).toBe("UNPROVEN");
    expect(evalResult.reason.toLowerCase()).not.toContain("refund paid");
    expect(evalResult.transferLabel).toMatch(/triggered_by/i);
  });

  it("fetches a child receipt when parent fields are incomplete", async () => {
    const parent = collectTransferEvidence({
      messages: [{ is_eth_send: true, recipient: FUNDER, value: reward }],
      children: [{ tx_id: childTx, triggered_by: CANCEL_TX }],
    });
    expect(childReceiptIdsToFetch(parent, CANCEL_TX)).toEqual([childTx]);
    const merged = await enrichTransferWithChildReceipts(parent, CANCEL_TX, async () => ({
      to: FUNDER,
      value_wei: reward,
      value_credited: true,
      triggered_by: CANCEL_TX,
      tx_id: childTx,
    }));
    expect(matchingChildCredit(merged, FUNDER, reward, CANCEL_TX)?.valueCredited).toBe(true);
  });
});

describe("protected clear local tracking", () => {
  it("blocks clear while a transaction is pending", () => {
    const session = emptyProductSession();
    session.deploy = { phase: "waiting", txId: DEPLOY_TX, statusName: "ACCEPTED" };
    const risk = productClearRisk(session);
    expect(risk.blocked).toBe(true);
    expect(risk.pending).toBe(true);
    expect(risk.txIds.deploy).toBe(DEPLOY_TX);
    expect(risk.reason).toMatch(/pending/i);
  });

  it("blocks clear when an uncancelled funded task exists and lists the task and tx IDs", async () => {
    const session = await readyCreateSession();
    const risk = productClearRisk(session);
    expect(risk.blocked).toBe(true);
    expect(risk.uncancelledFundedTask).toBe(true);
    expect(risk.taskId).toBe(session.expectedTaskId);
    expect(risk.txIds.create).toBe(CREATE_TX);
    expect(risk.reason).toMatch(/uncancelled funded task/i);
  });

  it("allows clear on an empty session", () => {
    const risk = productClearRisk(emptyProductSession());
    expect(risk.blocked).toBe(false);
  });
});

describe("persisted GetTimestamp lag", () => {
  it("round-trips genvmLagSeconds with the product session", () => {
    const session = emptyProductSession();
    session.genvmLagSeconds = 58_232_328;
    saveProductSession(session);
    const loaded = loadProductSession();
    expect(loaded.genvmLagSeconds).toBe(58_232_328);
  });
});

describe("Studio-dev cancel parent/child evidence reading", () => {
  it("counts one top-level outgoing EthSend and ignores nested copies", () => {
    const evidence = collectTransferEvidence(
      studioDevCancelParentReceipt,
      STUDIO_DEV_CANCEL_PARENT_TX,
      STUDIO_DEV_REWARD_WEI,
    );
    expect(evidence.outgoing).toHaveLength(1);
    expect(evidence.outgoing[0]?.valueWei).toBe(STUDIO_DEV_REWARD_WEI);
    expect(evidence.outgoing[0]?.recipient).toBe(STUDIO_DEV_FUNDER);
    expect(evidence.children.filter((child) => child.valueCredited === true)).toHaveLength(0);
    expect(studioDevCancelParentReceipt.triggered_transactions).toEqual([]);
    expect(studioDevCancelParentReceipt.consensus_data.leader_receipt.messages).toHaveLength(12);
  });

  it("matches JSON number child value to the bound reward string", () => {
    expect(weiEquals(studioDevCancelChildReceipt.value, STUDIO_DEV_REWARD_WEI)).toBe(true);
    expect(
      listedTxMatchesCancelChild(studioDevCancelChildReceipt, {
        parentTxId: STUDIO_DEV_CANCEL_PARENT_TX,
        contract: STUDIO_DEV_PRODUCT_CONTRACT,
        funder: STUDIO_DEV_FUNDER,
        rewardWei: STUDIO_DEV_REWARD_WEI,
      }),
    ).toBe(true);
  });

  it("discovers the child when parent triggered_transactions is empty", async () => {
    const fetched: string[] = [];
    const evidence = await enrichCancelRefundTransfer({
      parentReceipt: studioDevCancelParentReceipt,
      parentTxId: STUDIO_DEV_CANCEL_PARENT_TX,
      contract: STUDIO_DEV_PRODUCT_CONTRACT,
      funder: STUDIO_DEV_FUNDER,
      rewardWei: STUDIO_DEV_REWARD_WEI,
      fetchTx: async (txId) => {
        fetched.push(txId);
        expect(txId).toBe(STUDIO_DEV_CANCEL_CHILD_TX);
        return studioDevCancelChildReceipt;
      },
      listAddressTxs: async (address) => {
        expect(address).toBe(STUDIO_DEV_PRODUCT_CONTRACT);
        return studioDevCancelAddressTxs;
      },
    });
    expect(fetched).toEqual([STUDIO_DEV_CANCEL_CHILD_TX]);
    const child = matchingChildCredit(
      evidence,
      STUDIO_DEV_FUNDER,
      STUDIO_DEV_REWARD_WEI,
      STUDIO_DEV_CANCEL_PARENT_TX,
    );
    expect(child?.txId).toBe(STUDIO_DEV_CANCEL_CHILD_TX);
    expect(child?.valueCredited).toBe(true);
    expect(child?.triggeredBy).toBe(STUDIO_DEV_CANCEL_PARENT_TX);
    expect(evidence.outgoing).toHaveLength(1);
    expect(evidence.parseNote).toMatch(/sim_getTransactionsForAddress/i);
  });

  it("falls back to listed row fields when child hash fetch fails", async () => {
    const evidence = await enrichCancelRefundTransfer({
      parentReceipt: studioDevCancelParentReceipt,
      parentTxId: STUDIO_DEV_CANCEL_PARENT_TX,
      contract: STUDIO_DEV_PRODUCT_CONTRACT,
      funder: STUDIO_DEV_FUNDER,
      rewardWei: STUDIO_DEV_REWARD_WEI,
      fetchTx: async () => {
        throw new Error("eth_getTransactionByHash failed");
      },
      listAddressTxs: async () => studioDevCancelAddressTxs,
    });
    expect(
      matchingChildCredit(evidence, STUDIO_DEV_FUNDER, STUDIO_DEV_REWARD_WEI, STUDIO_DEV_CANCEL_PARENT_TX)?.valueCredited,
    ).toBe(true);
    expect(evidence.parseNote).toMatch(/listed row/i);
  });

  it("preserves enriched child evidence instead of a parent-only reparse", async () => {
    const enriched = await enrichCancelRefundTransfer({
      parentReceipt: studioDevCancelParentReceipt,
      parentTxId: STUDIO_DEV_CANCEL_PARENT_TX,
      contract: STUDIO_DEV_PRODUCT_CONTRACT,
      funder: STUDIO_DEV_FUNDER,
      rewardWei: STUDIO_DEV_REWARD_WEI,
      fetchTx: async () => studioDevCancelChildReceipt,
      listAddressTxs: async () => studioDevCancelAddressTxs,
    });
    const parentOnly = collectTransferEvidence(
      studioDevCancelParentReceipt,
      STUDIO_DEV_CANCEL_PARENT_TX,
      STUDIO_DEV_REWARD_WEI,
    );
    expect(matchingChildCredit(parentOnly, STUDIO_DEV_FUNDER, STUDIO_DEV_REWARD_WEI, STUDIO_DEV_CANCEL_PARENT_TX)).toBeUndefined();
    const kept = preserveEnrichedTransfer(enriched, parentOnly);
    expect(matchingChildCredit(kept, STUDIO_DEV_FUNDER, STUDIO_DEV_REWARD_WEI, STUDIO_DEV_CANCEL_PARENT_TX)?.txId).toBe(
      STUDIO_DEV_CANCEL_CHILD_TX,
    );
    expect(kept.outgoing).toHaveLength(1);
  });

  it("keeps overall UNPROVEN when payout_submitted is true without child delivery", async () => {
    const session = await readyCreateSession();
    session.cancel = successAction(CANCEL_TX);
    session.cancel.executionName = "FINISHED_WITH_RETURN";
    session.cancelTask = { ...session.createTask!, state: "cancelled", payout_submitted: true };
    session.paymentEvidence = "YES";
    const overall = overallProductVerdict(session);
    expect(overall.verdict).toBe("UNPROVEN");
    expect(overall.reason).toMatch(/payout_submitted/i);
    expect(PAYOUT_SUBMITTED_IS_NOT_PAYMENT).toMatch(/not child delivery/i);
  });
});

describe("stale get_task UI errors", () => {
  const historical = "get_task after cancel: An unknown RPC error occurred.";

  it("recognizes the archived Phase A transient get_task error prefix", () => {
    expect(isGetTaskPrefixedError(historical)).toBe(true);
    expect(isGetTaskPrefixedError("eth_getTransactionByHash failed")).toBe(false);
  });

  it("drops a stale get_task error after a later successful read, keeping a receipt RPC error", () => {
    expect(
      errorAfterSuccessfulRefresh({
        getTaskOk: true,
        getTaskError: historical,
      }),
    ).toBeUndefined();
    expect(
      errorAfterSuccessfulRefresh({
        receiptError: "eth_getTransactionByHash failed while refreshing cancel",
        getTaskOk: true,
        getTaskError: historical,
      }),
    ).toMatch(/eth_getTransactionByHash/);
    expect(
      errorAfterSuccessfulRefresh({
        getTaskOk: false,
        getTaskError: historical,
      }),
    ).toBe(historical);
  });
});
