import { jsonSafe, jsonStringifySafe } from "../format";
import type { EoaBalances } from "../rpc";
import { rememberGenvmLag, type CreateDeadlineClock } from "../product/clock";
import type { ProductActionRecord } from "../product/persist";
import type { ProductTask } from "../product/task";
import type { TransferEvidence } from "../product/transfers";
import type { Verdict } from "../persist";
import type { LibraryEntry } from "../productB1/library";
import type { B1QuoteBinding } from "../productB1/quotes";
import {
  PRODUCT_TIMEOUT_STORAGE_KEY,
  TIMEOUT_CONTRACT_ADDRESS,
  TIMEOUT_SUGGESTED_TRANSLATION,
  type TimeoutActionName,
} from "./constants";

export type { ProductActionRecord, Verdict, TimeoutActionName };

export type TimeoutActionRecord = Omit<ProductActionRecord, "quotedBinding"> & {
  quotedBinding?: B1QuoteBinding;
};

export type TimeoutSession = {
  version: 1;
  address: string;
  translator: string;
  translation: string;
  rewardGen: string;
  boundFunder?: string;
  boundTranslator?: string;
  boundTranslation?: string;
  boundRewardWei?: string;
  boundRewardGen?: string;
  localSourceSha256?: string;
  deployedSourceSha256?: string | null;
  sourceMatch: boolean;
  sourceVerifyStatus: "idle" | "match" | "mismatch" | "UNPROVEN";
  sourceVerifyReason: string;
  sourceVerifiedAddress?: string;
  sourceVerifiedLocalSha256?: string;
  create: TimeoutActionRecord;
  submit: TimeoutActionRecord;
  recover: TimeoutActionRecord;
  clientNonce?: string;
  expectedTaskId?: string;
  submitByUnix?: number;
  recoverAfterUnix?: number;
  genvmLagSeconds?: number;
  createDeadlineClock?: CreateDeadlineClock;
  task?: ProductTask;
  libraryCountBefore?: number;
  libraryCountAfter?: number;
  libraryEntry?: LibraryEntry;
  transfer?: TransferEvidence;
  beforeCreate?: EoaBalances;
  afterCreate?: EoaBalances;
  beforeSubmit?: EoaBalances;
  afterSubmit?: EoaBalances;
  beforeRecover?: EoaBalances;
  afterRecover?: EoaBalances;
  afterWait?: EoaBalances;
  waitSamples?: EoaBalances[];
  paymentEvidence: Verdict;
  paymentReason: string;
};

function emptyAction(): TimeoutActionRecord {
  return { phase: "idle" };
}

export function emptyTimeoutSession(): TimeoutSession {
  return {
    version: 1,
    address: TIMEOUT_CONTRACT_ADDRESS,
    translator: "",
    translation: TIMEOUT_SUGGESTED_TRANSLATION,
    rewardGen: "",
    sourceMatch: false,
    sourceVerifyStatus: "idle",
    sourceVerifyReason: "Source has not been checked against the existing Studio-dev product contract yet.",
    create: emptyAction(),
    submit: emptyAction(),
    recover: emptyAction(),
    paymentEvidence: "UNPROVEN",
    paymentReason:
      "No Studio-dev timeout-recovery write has been measured yet. Live timeout recovery stays UNPROVEN until a funded wallet creates, submits, waits for recovery_opens_at_unix, and signs recover_undecided_task. This page never calls evaluate_task.",
  };
}

function durableAction(action: TimeoutActionRecord): TimeoutActionRecord {
  if (action.txId) return action;
  if (action.phase === "quoting" || action.phase === "signing" || action.phase === "submitted" || action.phase === "waiting") {
    return { ...action, phase: "idle" };
  }
  return action;
}

function durableSession(session: TimeoutSession): TimeoutSession {
  const next: TimeoutSession = {
    ...session,
    address: TIMEOUT_CONTRACT_ADDRESS,
    create: durableAction(session.create),
    submit: durableAction(session.submit),
    recover: durableAction(session.recover),
  };
  if (next.create.txId && !next.boundRewardWei) {
    next.boundRewardWei = next.create.quotedValueWei ?? next.task?.rewardWei;
    if (next.boundRewardWei && !next.boundRewardGen) next.boundRewardGen = next.rewardGen;
  }
  if (next.genvmLagSeconds != null && Number.isFinite(next.genvmLagSeconds)) {
    rememberGenvmLag(next.genvmLagSeconds);
  }
  return next;
}

function asAction(raw: unknown): TimeoutActionRecord {
  if (!raw || typeof raw !== "object") return emptyAction();
  return { ...emptyAction(), ...(raw as TimeoutActionRecord) };
}

export function loadTimeoutSession(): TimeoutSession {
  try {
    const raw = localStorage.getItem(PRODUCT_TIMEOUT_STORAGE_KEY);
    if (!raw) return emptyTimeoutSession();
    const parsed = JSON.parse(raw) as Partial<TimeoutSession> & { evaluate?: TimeoutActionRecord };
    if (parsed.version !== 1) return emptyTimeoutSession();
    return durableSession({
      ...emptyTimeoutSession(),
      ...parsed,
      address: TIMEOUT_CONTRACT_ADDRESS,
      translator: typeof parsed.translator === "string" ? parsed.translator : "",
      translation: typeof parsed.translation === "string" ? parsed.translation : TIMEOUT_SUGGESTED_TRANSLATION,
      rewardGen: typeof parsed.rewardGen === "string" ? parsed.rewardGen : "",
      create: asAction(parsed.create),
      submit: asAction(parsed.submit),
      recover: asAction(parsed.recover),
      paymentEvidence: parsed.paymentEvidence === "YES" || parsed.paymentEvidence === "NO" ? parsed.paymentEvidence : "UNPROVEN",
      paymentReason:
        typeof parsed.paymentReason === "string" ? parsed.paymentReason : emptyTimeoutSession().paymentReason,
    });
  } catch {
    return emptyTimeoutSession();
  }
}

function omitTypedQuoteBlobs(action: TimeoutActionRecord): TimeoutActionRecord {
  return { ...action, quotedDistribution: undefined, quotedMessageAllocations: undefined };
}

export function saveTimeoutSession(session: TimeoutSession): void {
  const display = durableSession({
    ...session,
    address: TIMEOUT_CONTRACT_ADDRESS,
    create: omitTypedQuoteBlobs(session.create),
    submit: omitTypedQuoteBlobs(session.submit),
    recover: omitTypedQuoteBlobs(session.recover),
  });
  try {
    localStorage.setItem(PRODUCT_TIMEOUT_STORAGE_KEY, jsonStringifySafe(jsonSafe(display)));
  } catch {
    // Never throw out of persist.
  }
}

export function clearTimeoutSession(): TimeoutSession {
  const next = emptyTimeoutSession();
  saveTimeoutSession(next);
  return next;
}

export function invalidateQuotedTimeoutAction(action: TimeoutActionRecord): TimeoutActionRecord {
  if (action.txId) return action;
  if (action.phase !== "quoted" && action.phase !== "quoting" && !action.quotedBinding) return action;
  return {
    ...action,
    phase: "idle",
    quotedBinding: undefined,
    quotedFeeWei: undefined,
    quotedValueWei: undefined,
    quotedDistribution: undefined,
    quotedMessageAllocations: undefined,
    error: action.phase === "quoted" ? "Fee quote invalidated. Estimate again before signing." : action.error,
  };
}

export function invalidateTimeoutUnsignedQuotes(session: TimeoutSession): TimeoutSession {
  return {
    ...session,
    create: invalidateQuotedTimeoutAction(session.create),
    submit: invalidateQuotedTimeoutAction(session.submit),
    recover: invalidateQuotedTimeoutAction(session.recover),
  };
}

export function resetTimeoutTransientPhases(session: TimeoutSession): TimeoutSession {
  return durableSession(session);
}

export function withTimeoutAction(
  session: TimeoutSession,
  name: TimeoutActionName,
  patch: Partial<TimeoutActionRecord>,
): TimeoutSession {
  return { ...session, [name]: { ...session[name], ...patch } };
}

export function bindTimeoutFunder(session: TimeoutSession, funder: string): TimeoutSession {
  return { ...session, boundFunder: session.boundFunder ?? funder };
}

export function bindTimeoutTranslator(session: TimeoutSession, translator: string): TimeoutSession {
  return { ...session, boundTranslator: session.boundTranslator ?? translator };
}
