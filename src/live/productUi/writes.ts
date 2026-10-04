import { jsonSafe, jsonStringifySafe } from "../format";
import type { ProductActionRecord } from "../product/persist";
import type { TransferEvidence } from "../product/transfers";
import type { Verdict } from "../persist";
import type { EoaBalances } from "../rpc";
import type { LibraryEntry } from "../productB1/library";
import { appendAttemptHistory, parseAttemptHistory, type AttemptHistoryEntry } from "./attemptHistory";
import { PRODUCT_UI_CONTRACT, PRODUCT_UI_WRITES_STORAGE_KEY } from "./constants";
import type { WriteQuoteBinding } from "./writeQuotes";

export type ProductUiWriteAction = "submit" | "evaluate" | "cancel" | "recover";

export type WriteBalanceSnapshot = EoaBalances & {
  caller: string;
  callerWei: string;
};

export type ProductUiWriteRecord = Omit<ProductActionRecord, "quotedBinding"> & {
  quotedBinding?: WriteQuoteBinding;
  key: string;
  chainId: number;
  contract: string;
  taskId: string;
  action: ProductUiWriteAction;
  wallet: string;
  boundTranslation?: string;
  rememberedGenvmUnix?: number;
  genvmLagSeconds?: number;
  beforeEvaluate?: EoaBalances;
  afterEvaluate?: EoaBalances;
  beforeBalances?: WriteBalanceSnapshot;
  afterBalances?: WriteBalanceSnapshot;
  transfer?: TransferEvidence;
  libraryCountBefore?: number;
  libraryCountAfter?: number;
  libraryEntry?: LibraryEntry;
  paymentEvidence?: Verdict;
  paymentReason?: string;
  transferLabel?: string;
  balanceLabel?: string;
  attemptHistory?: AttemptHistoryEntry[];
};

export type ProductUiWritesStore = {
  version: 1;
  records: Record<string, ProductUiWriteRecord>;
};

function emptyActionFields(): Omit<ProductActionRecord, "quotedBinding"> {
  return { phase: "idle" };
}

export function productUiWriteKey(input: {
  chainId: number;
  contract: string;
  taskId: string;
  action: ProductUiWriteAction;
  wallet: string;
}): string {
  return `${input.chainId}:${input.contract.trim().toLowerCase()}:${input.taskId.toLowerCase()}:${input.action}:${input.wallet.trim().toLowerCase()}`;
}

export function emptyWriteRecord(input: {
  chainId: number;
  contract?: string;
  taskId: string;
  action: ProductUiWriteAction;
  wallet: string;
}): ProductUiWriteRecord {
  const contract = (input.contract ?? PRODUCT_UI_CONTRACT).trim();
  const key = productUiWriteKey({ ...input, contract });
  return {
    ...emptyActionFields(),
    key,
    chainId: input.chainId,
    contract,
    taskId: input.taskId,
    action: input.action,
    wallet: input.wallet,
  };
}

function durableAction(record: ProductUiWriteRecord): ProductUiWriteRecord {
  if (record.txId) return record;
  if (record.phase === "quoting" || record.phase === "signing" || record.phase === "submitted" || record.phase === "waiting") {
    return { ...record, phase: "idle" };
  }
  return record;
}

function asRecord(raw: unknown): ProductUiWriteRecord | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const rec = raw as Partial<ProductUiWriteRecord>;
  if (rec.action !== "submit" && rec.action !== "evaluate" && rec.action !== "cancel" && rec.action !== "recover") {
    return undefined;
  }
  if (typeof rec.taskId !== "string" || typeof rec.wallet !== "string" || typeof rec.chainId !== "number") return undefined;
  const contract = typeof rec.contract === "string" ? rec.contract : PRODUCT_UI_CONTRACT;
  const key =
    typeof rec.key === "string"
      ? rec.key
      : productUiWriteKey({
          chainId: rec.chainId,
          contract,
          taskId: rec.taskId,
          action: rec.action,
          wallet: rec.wallet,
        });
  return durableAction({
    ...emptyActionFields(),
    ...(rec as ProductUiWriteRecord),
    key,
    chainId: rec.chainId,
    contract,
    taskId: rec.taskId,
    action: rec.action,
    wallet: rec.wallet,
    paymentEvidence:
      rec.paymentEvidence === "YES" || rec.paymentEvidence === "NO" || rec.paymentEvidence === "UNPROVEN"
        ? rec.paymentEvidence
        : undefined,
    attemptHistory: (() => {
      const history = parseAttemptHistory(rec.attemptHistory);
      return history.length ? history : undefined;
    })(),
  });
}

export function emptyWritesStore(): ProductUiWritesStore {
  return { version: 1, records: {} };
}

export function loadWritesStore(): ProductUiWritesStore {
  try {
    const raw = localStorage.getItem(PRODUCT_UI_WRITES_STORAGE_KEY);
    if (!raw) return emptyWritesStore();
    const parsed = JSON.parse(raw) as Partial<ProductUiWritesStore>;
    if (parsed.version !== 1 || !parsed.records || typeof parsed.records !== "object") return emptyWritesStore();
    const records: Record<string, ProductUiWriteRecord> = {};
    for (const [key, value] of Object.entries(parsed.records)) {
      const rec = asRecord(value);
      if (rec) records[key] = rec;
    }
    return { version: 1, records };
  } catch {
    return emptyWritesStore();
  }
}

function omitTypedQuoteBlobs(record: ProductUiWriteRecord): ProductUiWriteRecord {
  return {
    ...record,
    quotedDistribution: undefined,
    quotedMessageAllocations: undefined,
  };
}

export function saveWritesStore(store: ProductUiWritesStore): void {
  const records: Record<string, ProductUiWriteRecord> = {};
  for (const [key, value] of Object.entries(store.records)) {
    records[key] = omitTypedQuoteBlobs(durableAction(value));
  }
  try {
    localStorage.setItem(PRODUCT_UI_WRITES_STORAGE_KEY, jsonStringifySafe(jsonSafe({ version: 1, records })));
  } catch {
    // Never throw out of persist.
  }
}

export function getWrite(input: {
  chainId: number;
  contract?: string;
  taskId: string;
  action: ProductUiWriteAction;
  wallet: string;
}): ProductUiWriteRecord {
  const contract = input.contract ?? PRODUCT_UI_CONTRACT;
  const key = productUiWriteKey({ ...input, contract });
  const stored = loadWritesStore().records[key];
  return stored ? durableAction(stored) : emptyWriteRecord({ ...input, contract });
}

export function putWrite(record: ProductUiWriteRecord): ProductUiWriteRecord {
  const store = loadWritesStore();
  store.records[record.key] = record;
  saveWritesStore(store);
  return record;
}

export function withWritePatch(record: ProductUiWriteRecord, patch: Partial<ProductUiWriteRecord>): ProductUiWriteRecord {
  return { ...record, ...patch };
}

export function persistSubmittedWrite(
  record: ProductUiWriteRecord,
  txId: string,
  extra?: Partial<ProductUiWriteRecord>,
): ProductUiWriteRecord {
  return putWrite(
    withWritePatch(record, {
      ...extra,
      phase: "submitted",
      txId,
      submittedAt: Date.now(),
      error: undefined,
    }),
  );
}

/** New attempt after FINALIZED-failed. Archives the old hash; never retries it. Pending tx IDs stay put. */
export function retryFailedWrite(record: ProductUiWriteRecord): ProductUiWriteRecord {
  if (record.statusName !== "FINALIZED" || record.parentSuccessful !== false || !record.txId) return record;
  const history = appendAttemptHistory(record.attemptHistory, {
    txId: record.txId,
    archivedAt: Date.now(),
    statusName: record.statusName,
    executionName: record.executionName,
    parentSuccessful: record.parentSuccessful,
    submittedAt: record.submittedAt,
    error: record.error,
    action: record.action,
    taskId: record.taskId,
  });
  return {
    ...emptyWriteRecord({
      chainId: record.chainId,
      contract: record.contract,
      taskId: record.taskId,
      action: record.action,
      wallet: record.wallet,
    }),
    attemptHistory: history,
  };
}
