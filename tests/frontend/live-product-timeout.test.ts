import { beforeEach, describe, expect, it } from "vitest";
import { PRODUCT_STORAGE_KEY } from "../../src/live/product/constants";
import { parseProductTask } from "../../src/live/product/task";
import { expectedTaskId } from "../../src/live/product/taskId";
import { PRODUCT_B1_STORAGE_KEY } from "../../src/live/productB1/constants";
import { PRODUCT_B2_STORAGE_KEY } from "../../src/live/productB2/constants";
import { asB1Session, neverResubmit, recoverEstimateAllowed, retryFailedTimeoutAction, type B1WriteContext } from "../../src/live/productTimeout/guards";
import { libraryUnchangedForReject } from "../../src/live/productB1/library";
import {
  PRODUCT_TIMEOUT_STORAGE_KEY,
  TIMEOUT_CONTRACT_ADDRESS,
  TIMEOUT_SOURCE_TEXT,
  TIMEOUT_STRING_KEY,
  TIMEOUT_SUGGESTED_TRANSLATION,
  TIMEOUT_TARGET_LOCALE,
} from "../../src/live/productTimeout/constants";
import { buildTimeoutEvidencePayload, overallTimeoutVerdict } from "../../src/live/productTimeout/evidence";
import {
  emptyTimeoutSession,
  loadTimeoutSession,
  saveTimeoutSession,
  type TimeoutActionRecord,
  type TimeoutSession,
} from "../../src/live/productTimeout/persist";
import { formatDuration, recoveryClockView } from "../../src/live/productTimeout/recoverClock";

const FUNDER = "0x1111111111111111111111111111111111111111";
const TRANSLATOR = "0x2222222222222222222222222222222222222222";
const NONCE = "phase-timeout-nonce-1";
const REWARD = (10n ** 18n).toString();
const SUBMIT = 1_800_000_000;
const RECOVER = SUBMIT + 3600;
const CREATE_TX = `0x${"aa".repeat(32)}`;
const SUBMIT_TX = `0x${"bb".repeat(32)}`;
const RECOVER_TX = `0x${"dd".repeat(32)}`;
const CHILD_TX = `0x${"ee".repeat(32)}`;
const FEE = 126525250000823n;

function ctx(overrides: Partial<B1WriteContext> = {}): B1WriteContext {
  return { wallet: FUNDER, chainId: 61997, connected: true, ...overrides };
}

function successAction(txId: string): TimeoutActionRecord {
  return {
    phase: "success",
    txId,
    statusName: "FINALIZED",
    executionName: "FINISHED_WITH_RETURN",
    parentSuccessful: true,
  };
}

function sourceBound(session: TimeoutSession): TimeoutSession {
  return {
    ...session,
    address: TIMEOUT_CONTRACT_ADDRESS,
    sourceMatch: true,
    sourceVerifyStatus: "match",
    sourceVerifyReason: "matched",
    sourceVerifiedAddress: TIMEOUT_CONTRACT_ADDRESS,
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

async function readySubmittedSession(): Promise<TimeoutSession> {
  const taskId = await expectedTaskId(FUNDER, TIMEOUT_CONTRACT_ADDRESS, NONCE);
  const task = parseProductTask({
    task_id: taskId,
    funder: FUNDER,
    translator: TRANSLATOR,
    reward: REWARD,
    source_text: TIMEOUT_SOURCE_TEXT,
    source_locale: "en",
    target_locale: TIMEOUT_TARGET_LOCALE,
    string_key: TIMEOUT_STRING_KEY,
    translation: TIMEOUT_SUGGESTED_TRANSLATION,
    state: "submitted",
    decision: "none",
    payment_status: "none",
    payment_kind: "",
    payout_submitted: false,
    submit_by_unix: SUBMIT,
    recover_after_unix: RECOVER,
    submitted_at_unix: SUBMIT,
    decided_at_unix: 0,
    recovery_opens_at_unix: RECOVER,
    client_nonce: NONCE,
  })!;
  return sourceBound({
    ...emptyTimeoutSession(),
    translator: TRANSLATOR,
    translation: TIMEOUT_SUGGESTED_TRANSLATION,
    rewardGen: "1",
    boundFunder: FUNDER,
    boundTranslator: TRANSLATOR,
    boundTranslation: TIMEOUT_SUGGESTED_TRANSLATION,
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

function withTimeoutProof(session: TimeoutSession): TimeoutSession {
  return {
    ...session,
    recover: {
      ...successAction(RECOVER_TX),
      actualFeeAvailable: true,
      actualFeeWei: FEE.toString(),
      actualFeeSource: "primary_fee_spent",
    },
    task: {
      ...session.task!,
      state: "timed_out",
      decision: "timed_out",
      payment_kind: "refund",
      payout_submitted: true,
    },
    libraryCountBefore: 0,
    libraryCountAfter: 0,
    libraryEntry: undefined,
    transfer: transferTo(FUNDER, RECOVER_TX),
    beforeRecover: {
      funder: FUNDER,
      named: TRANSLATOR,
      contract: TIMEOUT_CONTRACT_ADDRESS,
      funderWei: (10n ** 20n).toString(),
      namedWei: (10n ** 19n).toString(),
      contractWei: REWARD,
      unixMs: 1,
    },
    afterWait: {
      funder: FUNDER,
      named: TRANSLATOR,
      contract: TIMEOUT_CONTRACT_ADDRESS,
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

describe("timeout-recovery isolation", () => {
  it("uses a unique string key and never shares A/B1/B2 storage", () => {
    expect(TIMEOUT_SOURCE_TEXT).toBe("Your order is on the way.");
    expect(TIMEOUT_STRING_KEY).toBe("phase_timeout.checkout.delivery.on_the_way");
    const session = emptyTimeoutSession();
    session.create = successAction(CREATE_TX);
    saveTimeoutSession(session);
    expect(localStorage.getItem(PRODUCT_TIMEOUT_STORAGE_KEY)).toContain(CREATE_TX);
    expect(localStorage.getItem(PRODUCT_B2_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(PRODUCT_B1_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(PRODUCT_STORAGE_KEY)).toBeNull();
    expect(loadTimeoutSession().address).toBe(TIMEOUT_CONTRACT_ADDRESS);
    expect(loadTimeoutSession().create.txId).toBe(CREATE_TX);
    expect("evaluate" in loadTimeoutSession()).toBe(false);
  });
});

describe("recovery clock and too-early gate", () => {
  it("formats a countdown and local date", () => {
    expect(formatDuration(3661)).toBe("1h 01m 01s");
    const view = recoveryClockView(RECOVER, RECOVER - 90);
    expect(view.open).toBe(false);
    expect(view.remainingSeconds).toBe(90);
    expect(view.countdownLabel).toMatch(/Too early to sign/i);
    expect(view.localDate).not.toBe("(none)");
    expect(recoveryClockView(RECOVER, RECOVER).open).toBe(true);
  });

  it("disables recover Sign before recovery_opens_at_unix and allows it at that time", async () => {
    const submitted = await readySubmittedSession();
    const opens = submitted.task!.recovery_opens_at_unix;
    expect(recoverEstimateAllowed(asB1Session(submitted), ctx(), opens - 1).ok).toBe(false);
    expect(recoverEstimateAllowed(asB1Session(submitted), ctx(), opens - 1).reason).toMatch(/disabled until/i);
    expect(recoverEstimateAllowed(asB1Session(submitted), ctx(), opens).ok).toBe(true);
  });

  it("never resubmits a stored recover hash", async () => {
    const submitted = await readySubmittedSession();
    submitted.recover = { phase: "waiting", txId: RECOVER_TX, statusName: "ACCEPTED" };
    expect(neverResubmit(submitted.recover)).toBe("resume");
    const failed = {
      ...submitted,
      recover: { phase: "failed" as const, txId: RECOVER_TX, statusName: "FINALIZED", parentSuccessful: false },
    };
    const next = retryFailedTimeoutAction(failed, "recover");
    expect(next.recover.txId).toBeUndefined();
    expect(neverResubmit(failed.recover)).toBe("resume");
  });
});

describe("timeout-recovery verdict", () => {
  it("stays UNPROVEN while submitted and tells the user to wait", async () => {
    const submitted = await readySubmittedSession();
    const overall = overallTimeoutVerdict(submitted);
    expect(overall.verdict).toBe("UNPROVEN");
    expect(overall.reason).toMatch(/stays submitted/i);
    expect(overall.reason).toMatch(/recovery_opens_at_unix/);
    expect(JSON.parse(buildTimeoutEvidencePayload({ wallet: FUNDER, chainId: 61997, session: submitted })).evaluateNeverCalled).toBe(
      true,
    );
  });

  it("does not treat evaluate approve/reject as timeout YES", async () => {
    const submitted = await readySubmittedSession();
    submitted.task = { ...submitted.task!, state: "rejected", decision: "rejected", payment_kind: "refund" };
    expect(overallTimeoutVerdict(submitted).verdict).toBe("UNPROVEN");
    expect(overallTimeoutVerdict(submitted).reason).toMatch(/never calls evaluate_task/i);
  });

  it("proves YES only for timed_out refund with unchanged library, funder child credit, and zero translator delta", async () => {
    const session = withTimeoutProof(await readySubmittedSession());
    const overall = overallTimeoutVerdict(session);
    expect(overall.verdict).toBe("YES");
    expect(overall.reason).toMatch(/Timeout recovery proven/i);
    const payload = JSON.parse(buildTimeoutEvidencePayload({ wallet: FUNDER, chainId: 61997, session }));
    expect(payload.live_result).toBe("YES");
    expect(payload.intent).toBe("timeout_recovery");
    session.libraryCountAfter = 1;
    expect(overallTimeoutVerdict(session).verdict).toBe("UNPROVEN");
  });

  it("stays UNPROVEN if the translator gained from settlement", async () => {
    const session = withTimeoutProof(await readySubmittedSession());
    session.afterWait = {
      ...session.afterWait!,
      namedWei: (10n ** 19n + 1n).toString(),
    };
    expect(overallTimeoutVerdict(session).verdict).toBe("UNPROVEN");
    expect(overallTimeoutVerdict(session).reason).toMatch(/Other party delta|Translator settlement delta/i);
  });

  it("requires library absence for this task", () => {
    expect(libraryUnchangedForReject({ countBefore: 0, countAfter: 0, entry: undefined, taskId: "task-1" })).toEqual({ ok: true });
    expect(libraryUnchangedForReject({ countBefore: 0, countAfter: 1, entry: undefined, taskId: "task-1" }).ok).toBe(false);
  });
});
