import { addressesEqual } from "./format";
import { STUDIO_DEV_CHAIN_ID } from "./network";
import type { ActionName, LaneKind } from "./persist";

export type QuoteBinding = {
  wallet: string;
  chainId: number;
  contract: string | null;
  recipient: string | null;
  method: string;
  valueWei: string;
};

export function payoutMethod(kind: LaneKind): "release_to_named_wallet" | "refund_to_funder" {
  return kind === "release" ? "release_to_named_wallet" : "refund_to_funder";
}

export function methodForAction(kind: LaneKind, name: ActionName): string {
  if (name === "deploy") return "deploy";
  if (name === "lock") return "lock";
  return payoutMethod(kind);
}

export function currentQuoteBinding(input: {
  wallet?: string;
  chainId?: number;
  contract?: string | null;
  recipient?: string;
  kind: LaneKind;
  name: ActionName;
  valueWei: string;
}): QuoteBinding {
  return {
    wallet: input.wallet?.toLowerCase() ?? "",
    chainId: input.chainId ?? 0,
    contract: input.name === "deploy" ? null : input.contract?.toLowerCase() ?? null,
    recipient: input.recipient?.toLowerCase() ?? null,
    method: methodForAction(input.kind, input.name),
    valueWei: input.valueWei,
  };
}

export function quoteStillValid(stored: QuoteBinding | undefined, current: QuoteBinding): boolean {
  if (!stored) return false;
  if (stored.chainId !== current.chainId || current.chainId !== STUDIO_DEV_CHAIN_ID) return false;
  if (!stored.wallet || !current.wallet || !addressesEqual(stored.wallet, current.wallet)) return false;
  if (stored.method !== current.method) return false;
  if (stored.valueWei !== current.valueWei) return false;
  if ((stored.contract ?? null) !== (current.contract ?? null)) return false;
  if (!addressesEqual(stored.recipient ?? "", current.recipient ?? "")) return false;
  return true;
}

export function quoteInvalidReason(stored: QuoteBinding | undefined, current: QuoteBinding): string | undefined {
  if (!stored) return "No fee quote is bound. Estimate again before signing.";
  if (current.chainId !== STUDIO_DEV_CHAIN_ID) {
    return `Wallet is on chain ${current.chainId}, not Studio-dev ${STUDIO_DEV_CHAIN_ID}. Re-estimate after switching.`;
  }
  if (stored.chainId !== current.chainId) {
    return "Chain changed since the fee quote. Re-estimate.";
  }
  if (!current.wallet || !addressesEqual(stored.wallet, current.wallet)) {
    return "Connected wallet changed since the fee quote. Re-estimate.";
  }
  if (stored.method !== current.method) {
    return "Method changed since the fee quote. Re-estimate.";
  }
  if (stored.valueWei !== current.valueWei) {
    return "Attached value changed since the fee quote. Re-estimate.";
  }
  if ((stored.contract ?? null) !== (current.contract ?? null) && !addressesEqual(stored.contract ?? "", current.contract ?? "")) {
    return "Contract address changed since the fee quote. Re-estimate.";
  }
  if (!addressesEqual(stored.recipient ?? "", current.recipient ?? "")) {
    return "Recipient changed since the fee quote. Re-estimate.";
  }
  return undefined;
}
