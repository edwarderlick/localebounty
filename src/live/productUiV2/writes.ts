import { jsonSafe, jsonStringifySafe } from "../format";
import type { ProductActionRecord } from "../product/persist";
import type { TransferEvidence } from "../product/transfers";
import type { Verdict } from "../persist";
import type { EoaBalances } from "../rpc";
import type { LibraryEntry } from "../productB1/library";
import { appendAttemptHistory, parseAttemptHistory, type AttemptHistoryEntry } from "../productUi/attemptHistory";
import { PRODUCT_UI_V2_CONTRACT, PRODUCT_UI_V2_WRITES_STORAGE_KEY } from "./constants";
import type { V2ProductQuoteBinding } from "./quotes";

export type ProductUiV2WriteAction = "accept" | "cancel" | "submit" | "evaluate" | "expire" | "recover";

export type V2WriteBalanceSnapshot = EoaBalances & {
  caller: string;
  callerWei: string;
};

export type ProductUiV2WriteRecord = Omit<ProductActionRecord, "quotedBinding"> & {
  quotedBinding?: V2ProductQuoteBinding;
  key: string;
  chainId: number;
  contract: string;
  taskId: string;
  action: ProductUiV2WriteAction;
  wallet: string;
  boundTranslation?: string;
  rememberedGenvmUnix?: number;
  genvmLagSeconds?: number;
  beforeEvaluate?: EoaBalances;
  afterEvaluate?: EoaBalances;
  beforeBalances?: V2WriteBalanceSnapshot;
  afterBalances?: V2WriteBalanceSnapshot;
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

export type ProductUiV2WritesStore = {
  version: 1;
  records: Record<string, ProductUiV2WriteRecord>;
};

function emptyActionFields(): Omit<ProductActionRecord, "quotedBinding"> {
  return { phase: "idle" };
}

export function productUiV2WriteKey(input: {
  chainId: number;
  contract: string;
  taskId: string;
  action: ProductUiV2WriteAction;
  wallet: string;
}): string {
  return `${input.chainId}:${input.contract.trim().toLowerCase()}:${input.taskId.toLowerCase()}:${input.action}:${input.wallet.trim().toLowerCase()}`;
}

export function emptyWriteRecord(input: {
  chainId: number;
  contract?: string;
  taskId: string;
  action: ProductUiV2WriteAction;
  wallet: string;
}): ProductUiV2WriteRecord {
  const contract = (input.contract ?? PRODUCT_UI_V2_CONTRACT).trim();
  const key = productUiV2WriteKey({ ...input, contract });
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

function durableAction(record: ProductUiV2WriteRecord): ProductUiV2WriteRecord {
  if (record.txId) return record;
  if (record.phase === "quoting" || record.phase === "signing" || record.phase === "submitted" || record.phase === "waiting") {
    return { ...record, phase: "idle" };
  }
  return record;
}

function asRecord(raw: unknown): ProductUiV2WriteRecord | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const rec = raw as Partial<ProductUiV2WriteRecord>;
  if (
    rec.action !== "accept" &&
    rec.action !== "cancel" &&
    rec.action !== "submit" &&
    rec.action !== "evaluate" &&
    rec.action !== "expire" &&
    rec.action !== "recover"
  ) {
    return undefined;
  }
  if (typeof rec.taskId !== "string" || typeof rec.wallet !== "string" || typeof rec.chainId !== "number") return undefined;
  const contract = typeof rec.contract === "string" ? rec.contract : PRODUCT_UI_V2_CONTRACT;
  const key =
    typeof rec.key === "string"
      ? rec.key
      : productUiV2WriteKey({
          chainId: rec.chainId,
          contract,
          taskId: rec.taskId,
          action: rec.action,
          wallet: rec.wallet,
        });
  return durableAction({
    ...emptyActionFields(),
    ...(rec as ProductUiV2WriteRecord),
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

export function loadV2WritesStore(): ProductUiV2WritesStore {
  try {
    const raw = localStorage.getItem(PRODUCT_UI_V2_WRITES_STORAGE_KEY);
    if (!raw) return { version: 1, records: {} };
    const parsed = JSON.parse(raw) as Partial<ProductUiV2WritesStore>;
    if (parsed.version !== 1 || !parsed.records || typeof parsed.records !== "object") return { version: 1, records: {} };
    const records: Record<string, ProductUiV2WriteRecord> = {};
    for (const [key, value] of Object.entries(parsed.records)) {
      const rec = asRecord(value);
      if (rec) records[key] = rec;
    }
    return { version: 1, records };
  } catch {
    return { version: 1, records: {} };
  }
}

export function saveV2WritesStore(store: ProductUiV2WritesStore): void {
  const records: Record<string, ProductUiV2WriteRecord> = {};
  for (const [key, value] of Object.entries(store.records)) {
    records[key] = {
      ...durableAction(value),
      quotedDistribution: undefined,
      quotedMessageAllocations: undefined,
    };
  }
  try {
    localStorage.setItem(PRODUCT_UI_V2_WRITES_STORAGE_KEY, jsonStringifySafe(jsonSafe({ version: 1, records })));
  } catch {
    // Never throw out of persist.
  }
}

export function getV2Write(input: {
  chainId: number;
  contract?: string;
  taskId: string;
  action: ProductUiV2WriteAction;
  wallet: string;
}): ProductUiV2WriteRecord {
  const contract = input.contract ?? PRODUCT_UI_V2_CONTRACT;
  const key = productUiV2WriteKey({ ...input, contract });
  const stored = loadV2WritesStore().records[key];
  return stored ? durableAction(stored) : emptyWriteRecord({ ...input, contract });
}

export function putV2Write(record: ProductUiV2WriteRecord): ProductUiV2WriteRecord {
  const store = loadV2WritesStore();
  store.records[record.key] = record;
  saveV2WritesStore(store);
  return record;
}

export function withV2WritePatch(
  record: ProductUiV2WriteRecord,
  patch: Partial<ProductUiV2WriteRecord>,
): ProductUiV2WriteRecord {
  return { ...record, ...patch };
}

export function persistSubmittedV2Write(
  record: ProductUiV2WriteRecord,
  txId: string,
  extra?: Partial<ProductUiV2WriteRecord>,
): ProductUiV2WriteRecord {
  return putV2Write(
    withV2WritePatch(record, {
      ...extra,
      phase: "submitted",
      txId,
      submittedAt: Date.now(),
      error: undefined,
    }),
  );
}

export function retryFailedV2Write(record: ProductUiV2WriteRecord): ProductUiV2WriteRecord {
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
  return putV2Write({
    ...emptyWriteRecord(record),
    attemptHistory: history,
  });
}

export function writeIdentityOrEmpty(input: {
  wallet?: string;
  chainId?: number;
  taskId: string;
  action: ProductUiV2WriteAction;
}): ProductUiV2WriteRecord {
  if (!input.wallet || input.chainId == null) {
    return emptyWriteRecord({
      chainId: input.chainId ?? 0,
      taskId: input.taskId,
      action: input.action,
      wallet: input.wallet ?? "",
    });
  }
  return getV2Write({
    chainId: input.chainId,
    taskId: input.taskId,
    action: input.action,
    wallet: input.wallet,
  });
}
