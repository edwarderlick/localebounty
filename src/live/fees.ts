import { isRecord } from "./eip1193";

export type FinalizedFee = {
  available: boolean;
  feeWei?: bigint;
  source?: string;
  reason: string;
};

function asBigInt(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return BigInt(value.trim());
  return undefined;
}

function firstRecord(value: unknown, keys: string[]): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    const inner = value[key];
    if (isRecord(inner)) return inner;
  }
  return undefined;
}

function pickFee(record: Record<string, unknown>, key: string): bigint | undefined {
  return asBigInt(record[key]);
}

/**
 * Studio receipts may include fee accounting. Parent success and submitted
 * feeValue are not the charged fee. If the receipt does not prove a net fee,
 * callers must label refund accounting UNPROVEN.
 */
export function extractFinalizedFee(receipt: unknown): FinalizedFee {
  if (!isRecord(receipt)) {
    return { available: false, reason: "No receipt object to read a finalized fee from." };
  }

  const accounting =
    firstRecord(receipt, ["feeAccounting", "fee_accounting", "studioFeeAccounting"]) ??
    (isRecord(receipt.feeAccounting) ? receipt.feeAccounting : undefined) ??
    (isRecord(receipt.data) ? firstRecord(receipt.data, ["feeAccounting", "fee_accounting"]) : undefined);

  const pool: Record<string, unknown> = { ...receipt, ...(accounting ?? {}) };

  const spent = pickFee(pool, "primary_fee_spent") ?? pickFee(pool, "primaryFeeSpent");
  if (spent != null) {
    return {
      available: true,
      feeWei: spent,
      source: "primary_fee_spent",
      reason: `Receipt primary_fee_spent is ${spent.toString()} wei.`,
    };
  }

  const required = pickFee(pool, "primary_fee_required") ?? pickFee(pool, "primaryFeeRequired") ?? pickFee(pool, "required_fee_value") ?? pickFee(pool, "requiredFeeValue");
  const refunded = pickFee(pool, "primary_fee_refunded") ?? pickFee(pool, "primaryFeeRefunded") ?? pickFee(pool, "total_refunded") ?? pickFee(pool, "totalRefunded");
  if (required != null && refunded != null && required >= refunded) {
    const net = required - refunded;
    return {
      available: true,
      feeWei: net,
      source: "primary_fee_required - primary_fee_refunded",
      reason: `Receipt net fee is ${net.toString()} wei (${required.toString()} required − ${refunded.toString()} refunded).`,
    };
  }

  const paid = pickFee(pool, "paid_fee_value") ?? pickFee(pool, "paidFeeValue");
  if (paid != null && refunded != null && paid >= refunded) {
    const net = paid - refunded;
    return {
      available: true,
      feeWei: net,
      source: "paid_fee_value - refunded",
      reason: `Receipt net fee is ${net.toString()} wei (${paid.toString()} paid − ${refunded.toString()} refunded).`,
    };
  }

  return {
    available: false,
    reason:
      "Finalized receipt does not expose a net protocol fee (primary_fee_spent or required−refunded). Submitted feeValue is not treated as the charged fee.",
  };
}
