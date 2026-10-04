import { jsonSafe, jsonStringifySafe } from "../format";
import type { EoaBalances } from "../rpc";
import { rememberGenvmLag, type CreateDeadlineClock } from "../product/clock";
import type { ProductActionRecord } from "../product/persist";
import type { ProductTask } from "../product/task";
import type { TransferEvidence } from "../product/transfers";
import type { Verdict } from "../persist";
import { PRODUCT_B1_STORAGE_KEY, B1_CONTRACT_ADDRESS, type B1ActionName } from "./constants";
import type { LibraryEntry } from "./library";
import type { B1QuoteBinding } from "./quotes";

export type { ProductActionRecord, Verdict, B1ActionName };

export type B1ActionRecord = Omit<ProductActionRecord, "quotedBinding"> & {
  quotedBinding?: B1QuoteBinding;
};

export type B1Session = {
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
  create: B1ActionRecord;
  submit: B1ActionRecord;
  evaluate: B1ActionRecord;
  recover: B1ActionRecord;
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
  beforeEvaluate?: EoaBalances;
  afterEvaluate?: EoaBalances;
  beforeRecover?: EoaBalances;
  afterRecover?: EoaBalances;
  afterWait?: EoaBalances;
  waitSamples?: EoaBalances[];
  paymentEvidence: Verdict;
  paymentReason: string;
};

function emptyAction(): B1ActionRecord {
  return { phase: "idle" };
}

export function emptyB1Session(): B1Session {
  return {
    version: 1,
    address: B1_CONTRACT_ADDRESS,
    translator: "",
    translation: "",
    rewardGen: "",
    sourceMatch: false,
    sourceVerifyStatus: "idle",
    sourceVerifyReason: "Source has not been checked against the existing Studio-dev product contract yet.",
    create: emptyAction(),
    submit: emptyAction(),
    evaluate: emptyAction(),
    recover: emptyAction(),
    paymentEvidence: "UNPROVEN",
    paymentReason:
      "No Studio-dev Phase B1 write has been measured yet. Live result stays UNPROVEN until a funded wallet completes this page.",
  };
}

function durableAction(action: B1ActionRecord): B1ActionRecord {
  if (action.txId) return action;
  if (action.phase === "quoting" || action.phase === "signing" || action.phase === "submitted" || action.phase === "waiting") {
    return { ...action, phase: "idle" };
  }
  return action;
}

function durableSession(session: B1Session): B1Session {
  const next: B1Session = {
    ...session,
    address: session.address || B1_CONTRACT_ADDRESS,
    create: durableAction(session.create),
    submit: durableAction(session.submit),
    evaluate: durableAction(session.evaluate),
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

function asAction(raw: unknown): B1ActionRecord {
  if (!raw || typeof raw !== "object") return emptyAction();
  return { ...emptyAction(), ...(raw as B1ActionRecord) };
}

export function loadB1Session(): B1Session {
  try {
    const raw = localStorage.getItem(PRODUCT_B1_STORAGE_KEY);
    if (!raw) return emptyB1Session();
    const parsed = JSON.parse(raw) as Partial<B1Session>;
    if (parsed.version !== 1) return emptyB1Session();
    return durableSession({
      ...emptyB1Session(),
      ...parsed,
      address: B1_CONTRACT_ADDRESS,
      translator: typeof parsed.translator === "string" ? parsed.translator : "",
      translation: typeof parsed.translation === "string" ? parsed.translation : "",
      rewardGen: typeof parsed.rewardGen === "string" ? parsed.rewardGen : "",
      create: asAction(parsed.create),
      submit: asAction(parsed.submit),
      evaluate: asAction(parsed.evaluate),
      recover: asAction(parsed.recover),
      paymentEvidence: parsed.paymentEvidence === "YES" || parsed.paymentEvidence === "NO" ? parsed.paymentEvidence : "UNPROVEN",
      paymentReason:
        typeof parsed.paymentReason === "string" ? parsed.paymentReason : emptyB1Session().paymentReason,
    });
  } catch {
    return emptyB1Session();
  }
}

function omitTypedQuoteBlobs(action: B1ActionRecord): B1ActionRecord {
  return { ...action, quotedDistribution: undefined, quotedMessageAllocations: undefined };
}

export function saveB1Session(session: B1Session): void {
  const display = durableSession({
    ...session,
    address: B1_CONTRACT_ADDRESS,
    create: omitTypedQuoteBlobs(session.create),
    submit: omitTypedQuoteBlobs(session.submit),
    evaluate: omitTypedQuoteBlobs(session.evaluate),
    recover: omitTypedQuoteBlobs(session.recover),
  });
  try {
    localStorage.setItem(PRODUCT_B1_STORAGE_KEY, jsonStringifySafe(jsonSafe(display)));
  } catch {
    // Never throw out of persist.
  }
}

export function clearB1Session(): B1Session {
  const next = emptyB1Session();
  saveB1Session(next);
  return next;
}

export function invalidateQuotedB1Action(action: B1ActionRecord): B1ActionRecord {
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

export function invalidateB1UnsignedQuotes(session: B1Session): B1Session {
  return {
    ...session,
    create: invalidateQuotedB1Action(session.create),
    submit: invalidateQuotedB1Action(session.submit),
    evaluate: invalidateQuotedB1Action(session.evaluate),
    recover: invalidateQuotedB1Action(session.recover),
  };
}

export function resetB1TransientPhases(session: B1Session): B1Session {
  return durableSession(session);
}

export function withB1Action(session: B1Session, name: B1ActionName, patch: Partial<B1ActionRecord>): B1Session {
  return { ...session, [name]: { ...session[name], ...patch } };
}

export function bindB1Funder(session: B1Session, funder: string): B1Session {
  return { ...session, boundFunder: session.boundFunder ?? funder };
}

export function bindB1Translator(session: B1Session, translator: string): B1Session {
  return { ...session, boundTranslator: session.boundTranslator ?? translator };
}
