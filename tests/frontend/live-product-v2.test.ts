import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { PRODUCT_STORAGE_KEY } from "../../src/live/product/constants";
import { PAYOUT_SUBMITTED_IS_NOT_PAYMENT } from "../../src/live/product/evidence";
import { PRODUCT_B1_STORAGE_KEY } from "../../src/live/productB1/constants";
import { PRODUCT_B2_STORAGE_KEY } from "../../src/live/productB2/constants";
import { PRODUCT_TIMEOUT_STORAGE_KEY } from "../../src/live/productTimeout/constants";
import { PRODUCT_UI_CONTRACT, PRODUCT_UI_SOURCE_SHA256, PRODUCT_UI_STORAGE_KEY, PRODUCT_UI_WRITES_STORAGE_KEY } from "../../src/live/productUi/constants";
import {
  BROWSER_FEE_QUOTE_NOTE,
  LANE_A_STRING_KEY,
  LANE_B_STRING_KEY,
  LANE_B_SUBMIT_LEAD_SECONDS,
  PRODUCT_V2_STORAGE_KEY,
  STATE_ACCEPTED,
  STATE_CANCELLED,
  STATE_EXPIRED,
  STATE_OPEN,
} from "../../src/live/productV2/constants";
import {
  expireWindowOpen,
  acceptWindowOpen,
  submitTranslationWindowOpen,
  expireClockView,
} from "../../src/live/productV2/expireClock";
import {
  buildLaneAEvidencePayload,
  buildLaneBEvidencePayload,
  evaluateExpireRefund,
  laneBRecoveryVerdict,
  overallLaneAVerdict,
  overallLaneBVerdict,
} from "../../src/live/productV2/evidence";
import {
  acceptBAllowed,
  cancelAAllowed,
  cancelBAllowed,
  createAEstimateAllowed,
  createASignAllowed,
  createDeadlinesForLane,
  deployWriteAllowed,
  expireBAllowed,
  funderCancelAfterAcceptBlocked,
  neverResubmit,
  retryFailedV2Action,
  sourceAllowsV2Create,
  type V2WriteContext,
} from "../../src/live/productV2/guards";
import {
  emptyProductV2Session,
  invalidateV2UnsignedQuotes,
  loadProductV2Session,
  saveProductV2Session,
  type ProductV2ActionRecord,
  type ProductV2Session,
} from "../../src/live/productV2/persist";
import { parseProductV2Task, taskMatchesOpenUnaccepted } from "../../src/live/productV2/task";
import { expectedTaskId } from "../../src/live/product/taskId";

const FUNDER = "0x1111111111111111111111111111111111111111";
const TRANSLATOR = "0x2222222222222222222222222222222222222222";
const OTHER = "0x5555555555555555555555555555555555555555";
const CONTRACT = "0x3333333333333333333333333333333333333333";
const LOCAL_SHA = "v2-local-sha";
const NONCE_A = "phase-c2-lane-a-nonce";
const NONCE_B = "phase-c2-lane-b-nonce";
const REWARD = (10n ** 18n).toString();
const SUBMIT = 1_800_000_000;
const RECOVER = SUBMIT + 3600;
const FEE = 126525250000823n;
const DEPLOY_TX = `0x${"aa".repeat(32)}`;
const CREATE_A_TX = `0x${"bb".repeat(32)}`;
const CANCEL_A_TX = `0x${"cc".repeat(32)}`;
const CREATE_B_TX = `0x${"dd".repeat(32)}`;
const ACCEPT_B_TX = `0x${"ee".repeat(32)}`;
const EXPIRE_B_TX = `0x${"ff".repeat(32)}`;
const CANCEL_B_TX = `0x${"99".repeat(32)}`;
const CHILD_TX = `0x${"11".repeat(32)}`;

function ctx(overrides: Partial<V2WriteContext> = {}): V2WriteContext {
  return { wallet: FUNDER, chainId: 61997, connected: true, ...overrides };
}

function successAction(txId: string): ProductV2ActionRecord {
  return {
    phase: "success",
    txId,
    statusName: "FINALIZED",
    executionName: "FINISHED_WITH_RETURN",
    parentSuccessful: true,
  };
}

function sourceBound(session: ProductV2Session): ProductV2Session {
  return {
    ...session,
    address: CONTRACT,
    sourceMatch: true,
    sourceVerifyStatus: "match",
    sourceVerifyReason: "matched localebounty_v2.py",
    sourceVerifiedAddress: CONTRACT,
    sourceVerifiedLocalSha256: LOCAL_SHA,
    localSourceSha256: LOCAL_SHA,
    deploy: successAction(DEPLOY_TX),
  };
}

function v2Task(input: {
  taskId: string;
  nonce: string;
  state: string;
  acceptedAt: number;
  submitBy?: number;
  translation?: string;
}) {
  return parseProductV2Task({
    task_id: input.taskId,
    funder: FUNDER,
    translator: TRANSLATOR,
    reward: REWARD,
    source_text: "Phase C2",
    source_locale: "en",
    target_locale: "es",
    string_key: input.nonce === NONCE_A ? LANE_A_STRING_KEY : LANE_B_STRING_KEY,
    translation: input.translation ?? "",
    state: input.state,
    decision: "none",
    payment_status: "none",
    payment_kind: "",
    payout_submitted: false,
    submit_by_unix: input.submitBy ?? SUBMIT,
    recover_after_unix: RECOVER,
    submitted_at_unix: 0,
    decided_at_unix: 0,
    recovery_opens_at_unix: RECOVER,
    client_nonce: input.nonce,
    accepted_at_unix: input.acceptedAt,
  })!;
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

async function readyLaneASession(): Promise<ProductV2Session> {
  const taskId = await expectedTaskId(FUNDER, CONTRACT, NONCE_A);
  return sourceBound({
    ...emptyProductV2Session(),
    translator: TRANSLATOR,
    rewardGen: "1",
    boundFunder: FUNDER,
    boundTranslator: TRANSLATOR,
    nonceA: NONCE_A,
    taskIdA: taskId,
    submitA: SUBMIT,
    recoverA: RECOVER,
    boundRewardAWei: REWARD,
    createA: { ...successAction(CREATE_A_TX), quotedValueWei: REWARD },
    taskA: v2Task({ taskId, nonce: NONCE_A, state: STATE_OPEN, acceptedAt: 0 }),
  });
}

async function readyLaneBOpen(): Promise<ProductV2Session> {
  const taskId = await expectedTaskId(FUNDER, CONTRACT, NONCE_B);
  return sourceBound({
    ...emptyProductV2Session(),
    translator: TRANSLATOR,
    rewardGen: "1",
    boundFunder: FUNDER,
    boundTranslator: TRANSLATOR,
    nonceB: NONCE_B,
    taskIdB: taskId,
    submitB: SUBMIT,
    recoverB: RECOVER,
    boundRewardBWei: REWARD,
    createB: { ...successAction(CREATE_B_TX), quotedValueWei: REWARD },
    taskB: v2Task({ taskId, nonce: NONCE_B, state: STATE_OPEN, acceptedAt: 0 }),
  });
}

async function readyLaneBAccepted(): Promise<ProductV2Session> {
  const open = await readyLaneBOpen();
  return {
    ...open,
    acceptB: successAction(ACCEPT_B_TX),
    taskB: v2Task({ taskId: open.taskIdB!, nonce: NONCE_B, state: STATE_ACCEPTED, acceptedAt: SUBMIT - 10 }),
  };
}

function expireRefundBalances(session: ProductV2Session, expireTx: string, caller: string): ProductV2Session {
  return {
    ...session,
    expireB: {
      ...successAction(expireTx),
      actualFeeAvailable: true,
      actualFeeWei: FEE.toString(),
      actualFeeSource: "primary_fee_spent",
    },
    transferB: transferTo(FUNDER, expireTx),
    expireCaller: caller,
    beforeExpireB: {
      funder: FUNDER,
      named: TRANSLATOR,
      contract: CONTRACT,
      funderWei: (10n ** 20n).toString(),
      namedWei: (10n ** 19n).toString(),
      contractWei: REWARD,
      unixMs: 1,
    },
    afterWaitB: {
      funder: FUNDER,
      named: TRANSLATOR,
      contract: CONTRACT,
      funderWei: (10n ** 20n + 10n ** 18n).toString(),
      namedWei: (10n ** 19n).toString(),
      contractWei: "0",
      unixMs: 2,
    },
    beforeExpireCallerWei: (10n ** 19n).toString(),
    afterExpireCallerWei: (10n ** 19n - FEE).toString(),
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

describe("Phase C2 V2 harness isolation", () => {
  it("uses a unique persist key and does not share V1 / B1 / B2 / timeout / product-ui storage", () => {
    expect(PRODUCT_V2_STORAGE_KEY).toBe("localebounty.live-product-v2.v1");
    expect(PRODUCT_V2_STORAGE_KEY).not.toBe(PRODUCT_STORAGE_KEY);
    expect(PRODUCT_V2_STORAGE_KEY).not.toBe(PRODUCT_B1_STORAGE_KEY);
    expect(PRODUCT_V2_STORAGE_KEY).not.toBe(PRODUCT_B2_STORAGE_KEY);
    expect(PRODUCT_V2_STORAGE_KEY).not.toBe(PRODUCT_TIMEOUT_STORAGE_KEY);
    expect(PRODUCT_V2_STORAGE_KEY).not.toBe(PRODUCT_UI_STORAGE_KEY);
    expect(PRODUCT_V2_STORAGE_KEY).not.toBe(PRODUCT_UI_WRITES_STORAGE_KEY);
    const session = emptyProductV2Session();
    session.createA = successAction(CREATE_A_TX);
    saveProductV2Session(session);
    expect(localStorage.getItem(PRODUCT_V2_STORAGE_KEY)).toContain(CREATE_A_TX);
    expect(localStorage.getItem(PRODUCT_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(PRODUCT_B1_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(PRODUCT_B2_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(PRODUCT_TIMEOUT_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(PRODUCT_UI_STORAGE_KEY)).toBeNull();
    expect(loadProductV2Session().createA.txId).toBe(CREATE_A_TX);
  });

  it("keeps PRODUCT_UI_CONTRACT on the V1 pin", () => {
    expect(PRODUCT_UI_CONTRACT).toBe("0x84dA80726e8A0c6d451Ca3FF88d7dD47F3b07D96");
    expect(PRODUCT_UI_SOURCE_SHA256).toBe("6db9fb8027453d0f82d24c978b90c0c3dd81ab9674ab8590766d6beeeb28c93f");
    const v1 = readFileSync(resolve("contracts/localebounty.py"), "utf8");
    const v2 = readFileSync(resolve("contracts/localebounty_v2.py"), "utf8");
    expect(v2).toContain("def accept_task");
    expect(v2).toContain("def expire_unsubmitted_task");
    expect(v1).not.toContain("def accept_task");
    expect(v1).not.toContain("def expire_unsubmitted_task");
  });
});

describe("create stays disabled until V2 source SHA match", () => {
  it("blocks create when source is unbound even after a successful deploy", async () => {
    const session: ProductV2Session = {
      ...emptyProductV2Session(),
      translator: TRANSLATOR,
      rewardGen: "1",
      address: CONTRACT,
      deploy: successAction(DEPLOY_TX),
      sourceMatch: false,
      sourceVerifyStatus: "UNPROVEN",
      sourceVerifyReason: "not checked",
    };
    const source = sourceAllowsV2Create(session, LOCAL_SHA);
    expect(source.ok).toBe(false);
    if (!source.ok) expect(source.reason).toMatch(/SHA-256|gen_getContractCode|bound/i);
    const create = createAEstimateAllowed(session, ctx(), LOCAL_SHA);
    expect(create.ok).toBe(false);
  });

  it("blocks create until deploy is FINALIZED with FINISHED_WITH_RETURN", () => {
    const session: ProductV2Session = {
      ...sourceBound({
        ...emptyProductV2Session(),
        translator: TRANSLATOR,
        rewardGen: "1",
      }),
      deploy: {
        phase: "success",
        txId: DEPLOY_TX,
        statusName: "FINALIZED",
        executionName: "FINISHED_WITH_ERROR",
        parentSuccessful: true,
      },
    };
    const create = createAEstimateAllowed(session, ctx(), LOCAL_SHA);
    expect(create.ok).toBe(false);
    if (!create.ok) expect(create.reason).toMatch(/FINISHED_WITH_RETURN/);
  });

  it("allows create estimate after source match and deploy with return", () => {
    const session = sourceBound({
      ...emptyProductV2Session(),
      translator: TRANSLATOR,
      rewardGen: "1",
    });
    expect(createAEstimateAllowed(session, ctx(), LOCAL_SHA).ok).toBe(true);
    expect(createASignAllowed(session, ctx(), LOCAL_SHA).ok).toBe(false);
  });
});

describe("lane A cancel only while open and unaccepted", () => {
  it("allows funder cancel on an open unaccepted task", async () => {
    const session = await readyLaneASession();
    expect(cancelAAllowed(session, ctx()).ok).toBe(true);
  });

  it("disables cancel after accepted_at_unix is set", async () => {
    const session = await readyLaneASession();
    const blocked = {
      ...session,
      taskA: { ...session.taskA!, state: STATE_ACCEPTED, accepted_at_unix: SUBMIT - 5 },
    };
    const match = taskMatchesOpenUnaccepted({
      task: blocked.taskA,
      funder: FUNDER,
      translator: TRANSLATOR,
      rewardWei: REWARD,
      clientNonce: NONCE_A,
      expectedTaskId: session.taskIdA!,
      submitByUnix: SUBMIT,
      recoverAfterUnix: RECOVER,
    });
    expect(match.ok).toBe(false);
    if (!match.ok) expect(match.reason).toMatch(/accepted/i);
    expect(cancelAAllowed(blocked, ctx()).ok).toBe(false);
  });
});

describe("lane B accept, cancel unavailable, expire after exclusive deadline", () => {
  it("accepts only the named translator before submit_by", async () => {
    const session = await readyLaneBAccepted();
    const open = {
      ...session,
      acceptB: { phase: "idle" as const },
      taskB: { ...session.taskB!, state: STATE_OPEN, accepted_at_unix: 0 },
    };
    expect(acceptBAllowed(open, ctx({ wallet: TRANSLATOR }), SUBMIT - 1).ok).toBe(true);
    const funder = acceptBAllowed(open, ctx({ wallet: FUNDER }), SUBMIT - 1);
    expect(funder.ok).toBe(false);
    if (!funder.ok) expect(funder.reason).toMatch(/named translator/i);
    const atDeadline = acceptBAllowed(open, ctx({ wallet: TRANSLATOR }), SUBMIT);
    expect(atDeadline.ok).toBe(false);
    expect(acceptWindowOpen(SUBMIT, SUBMIT)).toBe(false);
    expect(acceptWindowOpen(SUBMIT, SUBMIT - 1)).toBe(true);
  });

  it("shows funder cancel unavailable after accept", async () => {
    const session = await readyLaneBAccepted();
    const blocked = funderCancelAfterAcceptBlocked(session);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toMatch(/unavailable after accept/i);
  });

  it("allows expire after exclusive deadline for any studio wallet", async () => {
    const session = await readyLaneBAccepted();
    expect(expireWindowOpen(SUBMIT, SUBMIT)).toBe(false);
    expect(expireWindowOpen(SUBMIT, SUBMIT + 1)).toBe(true);
    const tooSoon = expireBAllowed(session, ctx({ wallet: OTHER }), SUBMIT);
    expect(tooSoon.ok).toBe(false);
    if (!tooSoon.ok) expect(tooSoon.reason).toMatch(/now > submit_by/);
    expect(expireBAllowed(session, ctx({ wallet: OTHER }), SUBMIT + 1).ok).toBe(true);
    expect(expireBAllowed(session, ctx({ wallet: TRANSLATOR }), SUBMIT + 1).ok).toBe(true);
    expect(expireBAllowed(session, ctx({ wallet: FUNDER }), SUBMIT + 1).ok).toBe(true);
  });
});

describe("never resubmit and payout_submitted is not paid", () => {
  it("resumes an existing tx ID instead of estimating a second submit", async () => {
    const session = await readyLaneASession();
    expect(neverResubmit(session.createA)).toBe("resume");
    expect(createAEstimateAllowed(session, ctx(), LOCAL_SHA).ok).toBe(false);
    const retried = retryFailedV2Action(
      {
        ...session,
        createA: {
          ...session.createA,
          statusName: "FINALIZED",
          parentSuccessful: false,
          phase: "failed",
        },
      },
      "createA",
    );
    expect(retried.createA.txId).toBeUndefined();
    expect(retried.createA.phase).toBe("idle");
  });

  it("keeps unsigned quotes invalidated without clearing tx IDs", async () => {
    const session = await readyLaneASession();
    session.cancelA = {
      phase: "quoted",
      quotedFeeWei: "1",
      quotedBinding: {
        wallet: FUNDER.toLowerCase(),
        chainId: 61997,
        contract: CONTRACT.toLowerCase(),
        translator: TRANSLATOR.toLowerCase(),
        method: "cancelA",
        valueWei: "0",
        clientNonce: null,
        submitByUnix: null,
        recoverAfterUnix: null,
        taskId: session.taskIdA!,
      },
    };
    const next = invalidateV2UnsignedQuotes(session);
    expect(next.createA.txId).toBe(CREATE_A_TX);
    expect(next.cancelA.phase).toBe("idle");
    expect(next.cancelA.quotedFeeWei).toBeUndefined();
  });

  it("does not treat payout_submitted as payment in evidence JSON", async () => {
    const session = await readyLaneASession();
    const payload = JSON.parse(buildLaneAEvidencePayload({ wallet: FUNDER, chainId: 61997, session }));
    expect(payload.live_result).toBe("UNPROVEN");
    expect(payload.payout_submitted_is_not_paid).toBe(PAYOUT_SUBMITTED_IS_NOT_PAYMENT);
    expect(overallLaneAVerdict(session).verdict).toBe("UNPROVEN");
  });
});

describe("expire refund recipient is the stored funder", () => {
  it("requires exact outgoing EthSend and child credit to the funder when a third party pays the fee", async () => {
    const session = await readyLaneBAccepted();
    const evalResult = evaluateExpireRefund({
      parentSuccessful: true,
      statusName: "FINALIZED",
      executionName: "FINISHED_WITH_RETURN",
      parentTxId: EXPIRE_B_TX,
      rewardWei: 10n ** 18n,
      funder: FUNDER,
      translator: TRANSLATOR,
      caller: OTHER,
      transfer: transferTo(FUNDER, EXPIRE_B_TX),
      beforeFunderWei: (10n ** 20n).toString(),
      afterFunderWei: (10n ** 20n + 10n ** 18n).toString(),
      beforeNamedWei: (10n ** 19n).toString(),
      afterNamedWei: (10n ** 19n).toString(),
      beforeCallerWei: (10n ** 19n).toString(),
      afterCallerWei: (10n ** 19n - FEE).toString(),
      actualFee: { available: true, feeWei: FEE, source: "primary_fee_spent", reason: "fixture" },
    });
    expect(evalResult.verdict).toBe("YES");
    expect(evalResult.reason).toMatch(/stored funder/);
    expect(evalResult.reason).toMatch(/Caller/);

    const emitOnly = evaluateExpireRefund({
      parentSuccessful: true,
      statusName: "FINALIZED",
      executionName: "FINISHED_WITH_RETURN",
      parentTxId: EXPIRE_B_TX,
      rewardWei: 10n ** 18n,
      funder: FUNDER,
      translator: TRANSLATOR,
      caller: OTHER,
      transfer: {
        outgoing: [{ recipient: FUNDER, valueWei: REWARD, isEthSend: true, messageType: "0" }],
        children: [],
        parseOk: true,
        parseNote: "emit only",
      },
      beforeFunderWei: (10n ** 20n).toString(),
      afterFunderWei: (10n ** 20n + 10n ** 18n).toString(),
      beforeNamedWei: (10n ** 19n).toString(),
      afterNamedWei: (10n ** 19n).toString(),
      beforeCallerWei: (10n ** 19n).toString(),
      afterCallerWei: (10n ** 19n - FEE).toString(),
      actualFee: { available: true, feeWei: FEE, source: "primary_fee_spent", reason: "fixture" },
    });
    expect(emitOnly.verdict).toBe("UNPROVEN");

    const proven: ProductV2Session = {
      ...session,
      expireB: {
        ...successAction(EXPIRE_B_TX),
        actualFeeAvailable: true,
        actualFeeWei: FEE.toString(),
        actualFeeSource: "primary_fee_spent",
      },
      taskB: { ...session.taskB!, state: "expired", payment_kind: "refund", payout_submitted: true },
      transferB: transferTo(FUNDER, EXPIRE_B_TX),
      expireCaller: OTHER,
      beforeExpireB: {
        funder: FUNDER,
        named: TRANSLATOR,
        contract: CONTRACT,
        funderWei: (10n ** 20n).toString(),
        namedWei: (10n ** 19n).toString(),
        contractWei: REWARD,
        unixMs: 1,
      },
      afterWaitB: {
        funder: FUNDER,
        named: TRANSLATOR,
        contract: CONTRACT,
        funderWei: (10n ** 20n + 10n ** 18n).toString(),
        namedWei: (10n ** 19n).toString(),
        contractWei: "0",
        unixMs: 2,
      },
      beforeExpireCallerWei: (10n ** 19n).toString(),
      afterExpireCallerWei: (10n ** 19n - FEE).toString(),
    };
    const overall = overallLaneBVerdict(proven);
    expect(overall.verdict).toBe("YES");
    const payload = JSON.parse(buildLaneBEvidencePayload({ wallet: OTHER, chainId: 61997, session: proven }));
    expect(payload.live_result).toBe("YES");
    expect(payload.expireCaller).toBe(OTHER);
    expect(payload.funder_cancel_after_accept).toBe("unavailable");
    expect(payload.payout_submitted_is_not_paid).toBe(PAYOUT_SUBMITTED_IS_NOT_PAYMENT);
  });
});

describe("deploy write never resubmits", () => {
  it("blocks a second deploy estimate after a tx ID exists", () => {
    const session = sourceBound(emptyProductV2Session());
    expect(neverResubmit(session.deploy)).toBe("resume");
    const allowed = deployWriteAllowed(session, ctx());
    expect(allowed.ok).toBe(false);
    if (!allowed.ok) expect(allowed.reason).toMatch(/Resume tracking/);
  });
});

describe("lane B missed acceptance and unaccepted recovery", () => {
  it("blocks accept after the exclusive submit_by instant", async () => {
    const session = await readyLaneBOpen();
    const missed = acceptBAllowed(session, ctx({ wallet: TRANSLATOR }), SUBMIT);
    expect(missed.ok).toBe(false);
    if (!missed.ok) expect(missed.reason).toMatch(/now < submit_by_unix/);
    expect(acceptWindowOpen(SUBMIT, SUBMIT + 1)).toBe(false);
    expect(acceptBAllowed(session, ctx({ wallet: TRANSLATOR }), SUBMIT - 1).ok).toBe(true);
  });

  it("allows funder cancel on an open unaccepted Lane B task", async () => {
    const session = await readyLaneBOpen();
    expect(cancelBAllowed(session, ctx()).ok).toBe(true);
    expect(cancelBAllowed(session, ctx({ wallet: TRANSLATOR })).ok).toBe(false);
    const accepted = await readyLaneBAccepted();
    const afterAccept = cancelBAllowed(accepted, ctx());
    expect(afterAccept.ok).toBe(false);
    if (!afterAccept.ok) expect(afterAccept.reason).toMatch(/unavailable after accept/i);
  });

  it("blocks Lane B cancel once expire already has a transaction ID", async () => {
    const session = await readyLaneBOpen();
    const blocked = cancelBAllowed({ ...session, expireB: successAction(EXPIRE_B_TX) }, ctx());
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toMatch(/expire_unsubmitted_task already has transaction ID/);
  });

  it("allows expire after the exclusive deadline without a successful accept", async () => {
    const session = await readyLaneBOpen();
    expect(session.acceptB.txId).toBeUndefined();
    expect(expireBAllowed(session, ctx({ wallet: OTHER }), SUBMIT).ok).toBe(false);
    expect(expireBAllowed(session, ctx({ wallet: OTHER }), SUBMIT + 1).ok).toBe(true);
    expect(expireBAllowed(session, ctx({ wallet: FUNDER }), SUBMIT + 1).ok).toBe(true);
    const cancelled = expireBAllowed({ ...session, cancelB: successAction(CANCEL_B_TX) }, ctx({ wallet: OTHER }), SUBMIT + 1);
    expect(cancelled.ok).toBe(false);
    if (!cancelled.ok) expect(cancelled.reason).toMatch(/funder cancel already has transaction ID/i);
  });

  it("still allows expire after accept when now > submit_by", async () => {
    const session = await readyLaneBAccepted();
    expect(expireBAllowed(session, ctx({ wallet: OTHER }), SUBMIT + 1).ok).toBe(true);
    expect(expireBAllowed(session, ctx({ wallet: OTHER }), SUBMIT).ok).toBe(false);
  });

  it("keeps Lane B YES strict and labels unaccepted recovery separately", async () => {
    const open = await readyLaneBOpen();
    const unacceptedExpire = expireRefundBalances(
      {
        ...open,
        taskB: { ...open.taskB!, state: STATE_EXPIRED, payment_kind: "refund", payout_submitted: true },
      },
      EXPIRE_B_TX,
      OTHER,
    );
    expect(overallLaneBVerdict(unacceptedExpire).verdict).toBe("UNPROVEN");
    expect(overallLaneBVerdict(unacceptedExpire).reason).toMatch(/create\/accept are incomplete|accepted_at_unix/i);
    const expireRecovery = laneBRecoveryVerdict(unacceptedExpire);
    expect(expireRecovery.kind).toBe("unaccepted_expire");
    expect(expireRecovery.verdict).toBe("YES");
    expect(expireRecovery.reason).toMatch(/never Lane B YES|not Lane B YES/i);
    const expirePayload = JSON.parse(buildLaneBEvidencePayload({ wallet: OTHER, chainId: 61997, session: unacceptedExpire }));
    expect(expirePayload.live_result).toBe("UNPROVEN");
    expect(expirePayload.recoveryKind).toBe("unaccepted_expire");
    expect(expirePayload.recoveryEvidence).toBe("YES");

    const unacceptedCancel: ProductV2Session = {
      ...open,
      cancelB: {
        ...successAction(CANCEL_B_TX),
        actualFeeAvailable: true,
        actualFeeWei: FEE.toString(),
        actualFeeSource: "primary_fee_spent",
      },
      taskB: { ...open.taskB!, state: STATE_CANCELLED, payment_kind: "refund", payout_submitted: true },
      transferCancelB: transferTo(FUNDER, CANCEL_B_TX),
      beforeCancelB: {
        funder: FUNDER,
        named: TRANSLATOR,
        contract: CONTRACT,
        funderWei: (10n ** 20n).toString(),
        namedWei: (10n ** 19n).toString(),
        contractWei: REWARD,
        unixMs: 1,
      },
      afterWaitCancelB: {
        funder: FUNDER,
        named: TRANSLATOR,
        contract: CONTRACT,
        funderWei: (10n ** 20n + 10n ** 18n - FEE).toString(),
        namedWei: (10n ** 19n).toString(),
        contractWei: "0",
        unixMs: 2,
      },
    };
    expect(overallLaneBVerdict(unacceptedCancel).verdict).toBe("UNPROVEN");
    const cancelRecovery = laneBRecoveryVerdict(unacceptedCancel);
    expect(cancelRecovery.kind).toBe("unaccepted_cancel");
    expect(cancelRecovery.verdict).toBe("YES");
    expect(cancelRecovery.reason).toMatch(/not Lane B YES/);
    const cancelPayload = JSON.parse(buildLaneBEvidencePayload({ wallet: FUNDER, chainId: 61997, session: unacceptedCancel }));
    expect(cancelPayload.live_result).toBe("UNPROVEN");
    expect(cancelPayload.recoveryKind).toBe("unaccepted_cancel");
    expect(cancelPayload.cancel.txId).toBe(CANCEL_B_TX);

    const acceptedExpire = expireRefundBalances(
      {
        ...(await readyLaneBAccepted()),
        taskB: v2Task({
          taskId: open.taskIdB!,
          nonce: NONCE_B,
          state: STATE_EXPIRED,
          acceptedAt: SUBMIT - 10,
        }),
      },
      EXPIRE_B_TX,
      OTHER,
    );
    expect(overallLaneBVerdict(acceptedExpire).verdict).toBe("YES");
    expect(laneBRecoveryVerdict(acceptedExpire).kind).toBe("none");
    expect(laneBRecoveryVerdict(acceptedExpire).verdict).toBe("UNPROVEN");
  });

  it("uses the selected Lane B lead and loads old sessions without cancelB", () => {
    expect(createDeadlinesForLane(1_000_000, "B").leadSeconds).toBe(LANE_B_SUBMIT_LEAD_SECONDS);
    expect(createDeadlinesForLane(1_000_000, "B", 600).leadSeconds).toBe(600);
    expect(createDeadlinesForLane(1_000_000, "B", 600).submitByUnix).toBe(1_000_600);
    expect(BROWSER_FEE_QUOTE_NOTE).toMatch(/estimateTransactionFees/);
    expect(BROWSER_FEE_QUOTE_NOTE).toMatch(/estimateTransactionFeesForWrite/);
    expect(BROWSER_FEE_QUOTE_NOTE).toMatch(/CLI/);
    expect(BROWSER_FEE_QUOTE_NOTE).toMatch(/Browser fee estimation is available/);
    localStorage.setItem(
      PRODUCT_V2_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        translator: TRANSLATOR,
        rewardGen: "1",
        sourceMatch: false,
        sourceVerifyStatus: "idle",
        sourceVerifyReason: "legacy",
        deploy: { phase: "idle" },
        createA: { phase: "idle" },
        cancelA: { phase: "idle" },
        createB: { phase: "success", txId: CREATE_B_TX },
        acceptB: { phase: "idle" },
        expireB: { phase: "idle" },
        paymentA: "UNPROVEN",
        paymentAReason: "legacy",
        paymentB: "UNPROVEN",
        paymentBReason: "legacy",
      }),
    );
    const loaded = loadProductV2Session();
    expect(loaded.cancelB.phase).toBe("idle");
    expect(loaded.cancelB.txId).toBeUndefined();
    expect(loaded.laneBLeadSeconds).toBe(LANE_B_SUBMIT_LEAD_SECONDS);
    expect(loaded.createB.txId).toBe(CREATE_B_TX);
    expect(emptyProductV2Session().cancelB.phase).toBe("idle");
  });
});

describe("submit_by_unix exclusive/inclusive boundaries", () => {
  const deadline = 1_790_001_800;

  it("accepts before, closes accept at, and expires after submit_by_unix", () => {
    expect(acceptWindowOpen(deadline, deadline - 1)).toBe(true);
    expect(submitTranslationWindowOpen(deadline, deadline - 1)).toBe(true);
    expect(expireWindowOpen(deadline, deadline - 1)).toBe(false);

    expect(acceptWindowOpen(deadline, deadline)).toBe(false);
    expect(submitTranslationWindowOpen(deadline, deadline)).toBe(true);
    expect(expireWindowOpen(deadline, deadline)).toBe(false);

    expect(acceptWindowOpen(deadline, deadline + 1)).toBe(false);
    expect(submitTranslationWindowOpen(deadline, deadline + 1)).toBe(false);
    expect(expireWindowOpen(deadline, deadline + 1)).toBe(true);
  });

  it("labels the exact deadline as accept closed and submit still open", () => {
    const atDeadline = expireClockView(deadline, deadline);
    expect(atDeadline.open).toBe(false);
    expect(atDeadline.gateLabel).toMatch(/accept_task is closed/);
    expect(atDeadline.gateLabel).toMatch(/now < submit_by/);
    expect(atDeadline.gateLabel).toMatch(/submit_translation for an accepted task is still allowed/);
    expect(atDeadline.gateLabel).toMatch(/now <= submit_by/);
    expect(atDeadline.gateLabel).toMatch(/Expire waits until now > submit_by/);
    expect(atDeadline.gateLabel).not.toMatch(/accept is allowed at the exact deadline/i);
  });
});
