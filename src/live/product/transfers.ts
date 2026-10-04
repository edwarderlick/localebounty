import { isRecord } from "../eip1193";
import { addressesEqual, isEoaAddress } from "../format";

export type OutgoingTransfer = {
  recipient?: string;
  valueWei?: string;
  isEthSend: boolean;
  messageType?: string;
  on?: string;
};

export type ChildDelivery = {
  found: boolean;
  txId?: string;
  triggeredBy?: string;
  triggeredOn?: string;
  to?: string;
  valueWei?: string;
  valueCredited: boolean | null;
};

export type TransferEvidence = {
  outgoing: OutgoingTransfer[];
  children: ChildDelivery[];
  parseOk: boolean;
  parseNote: string;
};

function asWeiString(value: unknown): string | undefined {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value)).toString();
  if (typeof value === "string") {
    const t = value.trim();
    if (/^\d+$/.test(t)) return t;
    if (/^0x[0-9a-fA-F]+$/.test(t)) {
      try {
        return BigInt(t).toString();
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function asAddress(value: unknown): string | undefined {
  if (typeof value === "string" && isEoaAddress(value)) return value;
  return undefined;
}

function messageIsEthSend(record: Record<string, unknown>): boolean {
  const messageType = record.messageType ?? record.message_type;
  return record.is_eth_send === true || record.isEthSend === true || messageType === "0" || messageType === 0;
}

function outgoingFromMessage(record: Record<string, unknown>): OutgoingTransfer | undefined {
  if (!messageIsEthSend(record)) return undefined;
  const recipient = asAddress(record.recipient ?? record.to ?? record.address);
  const valueWei = asWeiString(record.value_wei ?? record.valueWei ?? record.value);
  if (!recipient && valueWei == null) return undefined;
  const messageType = record.messageType ?? record.message_type;
  return {
    recipient,
    valueWei,
    isEthSend: true,
    messageType: messageType != null ? String(messageType) : undefined,
    on: typeof record.on === "string" ? record.on : typeof record.triggered_on === "string" ? record.triggered_on : undefined,
  };
}

/** Parent outgoing EthSend lives on the top-level `messages` array. Nested copies are ignored. */
export function extractOutgoingEthSends(receipt: unknown): OutgoingTransfer[] {
  if (!isRecord(receipt) || !Array.isArray(receipt.messages)) return [];
  const found: OutgoingTransfer[] = [];
  for (const item of receipt.messages) {
    if (!isRecord(item)) continue;
    const outgoing = outgoingFromMessage(item);
    if (outgoing) found.push(outgoing);
  }
  return found;
}

function childFromRecord(record: Record<string, unknown>, expectedRewardWei?: string): ChildDelivery {
  const valueCreditedRaw = record.value_credited ?? record.valueCredited;
  const hasCredit = valueCreditedRaw === true || valueCreditedRaw === false;
  const rawValue = record.value_wei ?? record.valueWei ?? record.value;
  return {
    found: true,
    txId: asStringId(record.tx_id ?? record.txId ?? record.hash ?? record.transactionHash),
    triggeredBy: asStringId(record.triggered_by ?? record.triggeredBy),
    triggeredOn:
      typeof record.triggered_on === "string"
        ? record.triggered_on
        : typeof record.triggeredOn === "string"
          ? record.triggeredOn
          : undefined,
    to: asAddress(record.to ?? record.recipient ?? record.to_address ?? record.toAddress),
    valueWei: weiEquals(rawValue, expectedRewardWei) ? expectedRewardWei : asWeiString(rawValue),
    valueCredited: hasCredit ? Boolean(valueCreditedRaw) : null,
  };
}

export function extractChildDeliveries(receipt: unknown, parentTxId?: string, expectedRewardWei?: string): ChildDelivery[] {
  const found: ChildDelivery[] = [];
  if (!isRecord(receipt)) return found;
  if (Array.isArray(receipt.children)) {
    for (const item of receipt.children) {
      if (!isRecord(item)) continue;
      found.push(childFromRecord(item, expectedRewardWei));
    }
  }
  if (Array.isArray(receipt.triggered_transactions)) {
    for (const id of receipt.triggered_transactions) {
      if (typeof id !== "string" || !id) continue;
      if (found.some((child) => child.txId?.toLowerCase() === id.toLowerCase())) continue;
      found.push({
        found: false,
        txId: id,
        triggeredBy: parentTxId,
        valueCredited: null,
      });
    }
  }
  const topLevel = childDeliveryFromTx(receipt, expectedRewardWei);
  if (topLevel && topLevel.valueCredited === true && topLevel.triggeredBy) {
    const dup = found.some(
      (child) =>
        child.txId &&
        topLevel.txId &&
        child.txId.toLowerCase() === topLevel.txId.toLowerCase() &&
        child.triggeredBy?.toLowerCase() === topLevel.triggeredBy?.toLowerCase(),
    );
    if (!dup) found.push(topLevel);
  }
  return found;
}

export function weiEquals(raw: unknown, expected?: string): boolean {
  if (!expected) return false;
  const parsed = asWeiString(raw);
  if (parsed === expected) return true;
  if (typeof raw === "number" && Number.isFinite(raw) && Number(expected) === raw) return true;
  if (typeof raw === "string" && raw.trim() !== "" && Number(raw) === Number(expected) && Number.isFinite(Number(raw))) {
    return true;
  }
  return false;
}

export function txHashOf(tx: unknown): string | undefined {
  if (!isRecord(tx)) return undefined;
  return asStringId(tx.hash ?? tx.tx_id ?? tx.txId ?? tx.transactionHash);
}

export function childDeliveryFromTx(tx: unknown, expectedRewardWei?: string): ChildDelivery | undefined {
  if (!isRecord(tx)) return undefined;
  const valueCreditedRaw = tx.value_credited ?? tx.valueCredited;
  const triggeredBy = asStringId(tx.triggered_by ?? tx.triggeredBy);
  if (valueCreditedRaw !== true && !triggeredBy) return undefined;
  const rawValue = tx.value_wei ?? tx.valueWei ?? tx.value;
  const to = asAddress(tx.to_address ?? tx.toAddress ?? tx.to ?? tx.recipient);
  return {
    found: true,
    txId: txHashOf(tx),
    triggeredBy,
    triggeredOn:
      typeof tx.triggered_on === "string" ? tx.triggered_on : typeof tx.triggeredOn === "string" ? tx.triggeredOn : undefined,
    to,
    valueWei: weiEquals(rawValue, expectedRewardWei) ? expectedRewardWei : asWeiString(rawValue),
    valueCredited: valueCreditedRaw === true ? true : valueCreditedRaw === false ? false : null,
  };
}

export function listedTxMatchesCancelChild(
  tx: unknown,
  input: { parentTxId: string; contract: string; funder: string; rewardWei: string },
): boolean {
  if (!isRecord(tx)) return false;
  const from = asAddress(tx.from_address ?? tx.fromAddress ?? tx.from ?? tx.sender ?? tx.origin_address);
  const to = asAddress(tx.to_address ?? tx.toAddress ?? tx.to ?? tx.recipient);
  const triggeredBy = asStringId(tx.triggered_by ?? tx.triggeredBy);
  const status = String(tx.status ?? tx.statusName ?? "").toUpperCase();
  const credited = tx.value_credited ?? tx.valueCredited;
  if (!from || !addressesEqual(from, input.contract)) return false;
  if (!to || !addressesEqual(to, input.funder)) return false;
  if (!triggeredBy || triggeredBy.toLowerCase() !== input.parentTxId.toLowerCase()) return false;
  if (status !== "FINALIZED") return false;
  if (credited !== true) return false;
  return weiEquals(tx.value ?? tx.value_wei ?? tx.valueWei, input.rewardWei);
}

function asStringId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function collectTransferEvidence(
  receipt: unknown,
  parentTxId?: string,
  expectedRewardWei?: string,
): TransferEvidence {
  if (receipt == null) {
    return {
      outgoing: [],
      children: [],
      parseOk: false,
      parseNote: "No receipt to parse. Transfer delivery is UNPROVEN.",
    };
  }
  const outgoing = extractOutgoingEthSends(receipt);
  const children = extractChildDeliveries(receipt, parentTxId, expectedRewardWei);
  if (!outgoing.length && !children.length) {
    return {
      outgoing,
      children,
      parseOk: false,
      parseNote:
        "Receipt had no top-level outgoing EthSend and no child value_credited fields. Nested message copies are ignored. Transfer delivery is UNPROVEN. Nothing was invented.",
    };
  }
  return {
    outgoing,
    children,
    parseOk: true,
    parseNote: `Parsed ${outgoing.length} top-level outgoing EthSend message(s) and ${children.length} child delivery record(s). Nested message copies are not counted.`,
  };
}

export function matchingOutgoingTo(evidence: TransferEvidence, recipient: string, valueWei: string): OutgoingTransfer | undefined {
  return evidence.outgoing.find(
    (item) => item.recipient && addressesEqual(item.recipient, recipient) && item.valueWei === valueWei && item.isEthSend,
  );
}

export function childCreditFullyMatches(
  item: ChildDelivery,
  recipient: string,
  valueWei: string,
  parentTxId?: string,
): boolean {
  if (item.valueCredited !== true) return false;
  if (!item.to || !addressesEqual(item.to, recipient)) return false;
  if (!item.valueWei || item.valueWei !== valueWei) return false;
  if (!parentTxId || !item.triggeredBy) return false;
  return item.triggeredBy.toLowerCase() === parentTxId.toLowerCase();
}

export function matchingChildCredit(
  evidence: TransferEvidence,
  recipient: string,
  valueWei: string,
  parentTxId?: string,
): ChildDelivery | undefined {
  return evidence.children.find((item) => childCreditFullyMatches(item, recipient, valueWei, parentTxId));
}

export function childCreditRequirementNote(parentTxId?: string): string {
  return `Child credit requires value_credited=true, exact funder recipient, exact reward amount, and triggered_by equal to the cancel parent tx ID${parentTxId ? ` ${parentTxId}` : ""}. Incomplete or unrelated children stay UNPROVEN.`;
}

export function childReceiptIdsToFetch(evidence: TransferEvidence, parentTxId: string): string[] {
  const ids = new Set<string>();
  for (const child of evidence.children) {
    if (!child.txId) continue;
    if (child.txId.toLowerCase() === parentTxId.toLowerCase()) continue;
    const triggeredBy = child.triggeredBy;
    const complete =
      child.valueCredited === true &&
      Boolean(child.to) &&
      Boolean(child.valueWei) &&
      triggeredBy != null &&
      triggeredBy.toLowerCase() === parentTxId.toLowerCase();
    if (!complete) ids.add(child.txId);
  }
  return [...ids];
}

export function mergeTransferEvidence(
  base: TransferEvidence,
  extraReceipt: unknown,
  parentTxId?: string,
  expectedRewardWei?: string,
): TransferEvidence {
  const extra = collectTransferEvidence(extraReceipt, parentTxId, expectedRewardWei);
  const outgoing = [...base.outgoing];
  for (const item of extra.outgoing) {
    const dup = outgoing.some(
      (existing) =>
        existing.recipient === item.recipient && existing.valueWei === item.valueWei && existing.isEthSend === item.isEthSend,
    );
    if (!dup) outgoing.push(item);
  }
  const children = [...base.children];
  for (const item of extra.children) {
    const dup = children.some((existing) => {
      if (existing.txId && item.txId && existing.txId.toLowerCase() === item.txId.toLowerCase()) {
        return (
          existing.triggeredBy?.toLowerCase() === item.triggeredBy?.toLowerCase() &&
          existing.valueCredited === item.valueCredited
        );
      }
      return (
        existing.txId === item.txId &&
        existing.triggeredBy === item.triggeredBy &&
        existing.to === item.to &&
        existing.valueWei === item.valueWei &&
        existing.valueCredited === item.valueCredited
      );
    });
    if (!dup) children.push(item);
  }
  return {
    outgoing,
    children,
    parseOk: outgoing.length > 0 || children.length > 0,
    parseNote: extra.parseOk
      ? `${base.parseNote} Merged child receipt: ${extra.parseNote}`
      : `${base.parseNote} Child receipt fetch did not add complete delivery fields. Transfer delivery is UNPROVEN.`,
  };
}

export async function enrichTransferWithChildReceipts(
  evidence: TransferEvidence,
  parentTxId: string,
  fetchTx: (txId: string) => Promise<unknown>,
  expectedRewardWei?: string,
): Promise<TransferEvidence> {
  const ids = childReceiptIdsToFetch(evidence, parentTxId);
  if (!ids.length) {
    if (!evidence.children.some((child) => child.txId)) {
      return {
        ...evidence,
        parseNote: `${evidence.parseNote} ${childCreditRequirementNote(parentTxId)} No child receipt IDs were available to fetch.`,
      };
    }
    return evidence;
  }
  let next = evidence;
  for (const id of ids) {
    try {
      const raw = await fetchTx(id);
      next = mergeTransferEvidence(next, raw, parentTxId, expectedRewardWei);
    } catch (err) {
      next = {
        ...next,
        parseOk: next.parseOk,
        parseNote: `${next.parseNote} Child ${id} fetch failed (${err instanceof Error ? err.message : String(err)}). Transfer delivery is UNPROVEN.`,
      };
    }
  }
  return next;
}

/** Keep a child discovered via address listing when a later parent-only parse has no child. */
export function preserveEnrichedTransfer(
  existing: TransferEvidence | undefined,
  parentOnly: TransferEvidence,
): TransferEvidence {
  if (!existing) return parentOnly;
  const existingChild = existing.children.some((child) => child.valueCredited === true && Boolean(child.triggeredBy));
  const parentChild = parentOnly.children.some((child) => child.valueCredited === true && Boolean(child.triggeredBy));
  if (existingChild && !parentChild) {
    return {
      outgoing: parentOnly.outgoing.length ? parentOnly.outgoing : existing.outgoing,
      children: existing.children,
      parseOk: true,
      parseNote: `${existing.parseNote} Preserved enriched child delivery; a parent-only reparse did not replace it.`,
    };
  }
  return parentOnly;
}

export async function enrichCancelRefundTransfer(input: {
  parentReceipt: unknown;
  parentTxId: string;
  contract: string;
  funder: string;
  rewardWei: string;
  fetchTx: (txId: string) => Promise<unknown>;
  listAddressTxs: (address: string) => Promise<unknown[]>;
}): Promise<TransferEvidence> {
  let evidence = collectTransferEvidence(input.parentReceipt, input.parentTxId, input.rewardWei);
  if (matchingChildCredit(evidence, input.funder, input.rewardWei, input.parentTxId)) {
    return evidence;
  }
  evidence = await enrichTransferWithChildReceipts(evidence, input.parentTxId, input.fetchTx, input.rewardWei);
  if (matchingChildCredit(evidence, input.funder, input.rewardWei, input.parentTxId)) {
    return evidence;
  }

  let listed: unknown[] = [];
  try {
    listed = await input.listAddressTxs(input.contract);
  } catch (err) {
    return {
      ...evidence,
      parseNote: `${evidence.parseNote} sim_getTransactionsForAddress failed (${err instanceof Error ? err.message : String(err)}). Parent triggered_transactions may be empty. Transfer delivery is UNPROVEN.`,
    };
  }

  const matches = listed.filter((tx) =>
    listedTxMatchesCancelChild(tx, {
      parentTxId: input.parentTxId,
      contract: input.contract,
      funder: input.funder,
      rewardWei: input.rewardWei,
    }),
  );
  if (!matches.length) {
    return {
      ...evidence,
      parseNote: `${evidence.parseNote} ${childCreditRequirementNote(input.parentTxId)} Listed ${listed.length} contract address tx(s); none matched cancel child (from=contract, to=funder, triggered_by=parent, FINALIZED, value_credited, exact reward).`,
    };
  }

  for (const row of matches) {
    const id = txHashOf(row);
    if (id) {
      try {
        const childTx = await input.fetchTx(id);
        evidence = mergeTransferEvidence(evidence, childTx, input.parentTxId, input.rewardWei);
        continue;
      } catch (err) {
        evidence = {
          ...evidence,
          parseNote: `${evidence.parseNote} Child ${id} eth_getTransactionByHash failed (${err instanceof Error ? err.message : String(err)}). Using listed row fields.`,
        };
      }
    }
    evidence = mergeTransferEvidence(evidence, row, input.parentTxId, input.rewardWei);
  }

  if (matchingChildCredit(evidence, input.funder, input.rewardWei, input.parentTxId)) {
    return {
      ...evidence,
      parseOk: true,
      parseNote: `${evidence.parseNote} Discovered child transfer via sim_getTransactionsForAddress after parent triggered_transactions was empty.`,
    };
  }
  return {
    ...evidence,
    parseNote: `${evidence.parseNote} ${childCreditRequirementNote(input.parentTxId)}`,
  };
}
