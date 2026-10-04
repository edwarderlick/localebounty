import { jsonSafe, jsonStringifySafe } from "../format";
import type { EoaBalances } from "../rpc";
import { rememberGenvmLag, type CreateDeadlineClock } from "../product/clock";
import type { ProductActionRecord } from "../product/persist";
import type { ProductTask } from "../product/task";
import type { TransferEvidence } from "../product/transfers";
import type { Verdict } from "../persist";
import type { LibraryEntry } from "../productB1/library";
import type { B1QuoteBinding } from "../productB1/quotes";
import { B2_CONTRACT_ADDRESS, B2_SUGGESTED_TRANSLATION, PRODUCT_B2_STORAGE_KEY, type B2ActionName } from "./constants";

export type { ProductActionRecord, Verdict, B2ActionName };

export type B2ActionRecord = Omit<ProductActionRecord, "quotedBinding"> & {
  quotedBinding?: B1QuoteBinding;
};

export type B2Session = {
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
  create: B2ActionRecord;
  submit: B2ActionRecord;
  evaluate: B2ActionRecord;
  recover: B2ActionRecord;
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

function emptyAction(): B2ActionRecord {
  return { phase: "idle" };
}

export function emptyB2Session(): B2Session {
  return {
    version: 1,
    address: B2_CONTRACT_ADDRESS,
    translator: "",
    translation: B2_SUGGESTED_TRANSLATION,
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
      "No Studio-dev Phase B2 write has been measured yet. Live B2 rejection stays UNPROVEN until a funded wallet completes this page. AI is not assumed to reject.",
  };
}

function durableAction(action: B2ActionRecord): B2ActionRecord {
  if (action.txId) return action;
  if (action.phase === "quoting" || action.phase === "signing" || action.phase === "submitted" || action.phase === "waiting") {
    return { ...action, phase: "idle" };
  }
  return action;
}

function durableSession(session: B2Session): B2Session {
  const next: B2Session = {
    ...session,
    address: B2_CONTRACT_ADDRESS,
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

function asAction(raw: unknown): B2ActionRecord {
  if (!raw || typeof raw !== "object") return emptyAction();
  return { ...emptyAction(), ...(raw as B2ActionRecord) };
}

export function loadB2Session(): B2Session {
  try {
    const raw = localStorage.getItem(PRODUCT_B2_STORAGE_KEY);
    if (!raw) return emptyB2Session();
    const parsed = JSON.parse(raw) as Partial<B2Session>;
    if (parsed.version !== 1) return emptyB2Session();
    return durableSession({
      ...emptyB2Session(),
      ...parsed,
      address: B2_CONTRACT_ADDRESS,
      translator: typeof parsed.translator === "string" ? parsed.translator : "",
      translation: typeof parsed.translation === "string" ? parsed.translation : B2_SUGGESTED_TRANSLATION,
      rewardGen: typeof parsed.rewardGen === "string" ? parsed.rewardGen : "",
      create: asAction(parsed.create),
      submit: asAction(parsed.submit),
      evaluate: asAction(parsed.evaluate),
      recover: asAction(parsed.recover),
      paymentEvidence: parsed.paymentEvidence === "YES" || parsed.paymentEvidence === "NO" ? parsed.paymentEvidence : "UNPROVEN",
      paymentReason:
        typeof parsed.paymentReason === "string" ? parsed.paymentReason : emptyB2Session().paymentReason,
    });
  } catch {
    return emptyB2Session();
  }
}

function omitTypedQuoteBlobs(action: B2ActionRecord): B2ActionRecord {
  return { ...action, quotedDistribution: undefined, quotedMessageAllocations: undefined };
}

export function saveB2Session(session: B2Session): void {
  const display = durableSession({
    ...session,
    address: B2_CONTRACT_ADDRESS,
    create: omitTypedQuoteBlobs(session.create),
    submit: omitTypedQuoteBlobs(session.submit),
    evaluate: omitTypedQuoteBlobs(session.evaluate),
    recover: omitTypedQuoteBlobs(session.recover),
  });
  try {
    localStorage.setItem(PRODUCT_B2_STORAGE_KEY, jsonStringifySafe(jsonSafe(display)));
  } catch {
    // Never throw out of persist.
  }
}

export function clearB2Session(): B2Session {
  const next = emptyB2Session();
  saveB2Session(next);
  return next;
}

export function invalidateQuotedB2Action(action: B2ActionRecord): B2ActionRecord {
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

export function invalidateB2UnsignedQuotes(session: B2Session): B2Session {
  return {
    ...session,
    create: invalidateQuotedB2Action(session.create),
    submit: invalidateQuotedB2Action(session.submit),
    evaluate: invalidateQuotedB2Action(session.evaluate),
    recover: invalidateQuotedB2Action(session.recover),
  };
}

export function resetB2TransientPhases(session: B2Session): B2Session {
  return durableSession(session);
}

export function withB2Action(session: B2Session, name: B2ActionName, patch: Partial<B2ActionRecord>): B2Session {
  return { ...session, [name]: { ...session[name], ...patch } };
}

export function bindB2Funder(session: B2Session, funder: string): B2Session {
  return { ...session, boundFunder: session.boundFunder ?? funder };
}

export function bindB2Translator(session: B2Session, translator: string): B2Session {
  return { ...session, boundTranslator: session.boundTranslator ?? translator };
}
