import { addressesEqual } from "../format";
import { STUDIO_DEV_CHAIN_ID } from "../network";
import type { ProductUiWriteAction } from "./writes";

export type WriteQuoteBinding = {
  wallet: string;
  chainId: number;
  contract: string;
  method: ProductUiWriteAction;
  valueWei: string;
  taskId: string;
  translation: string | null;
};

export function currentWriteQuoteBinding(input: {
  wallet?: string;
  chainId?: number;
  contract: string;
  method: ProductUiWriteAction;
  valueWei: string;
  taskId: string;
  translation?: string | null;
}): WriteQuoteBinding {
  return {
    wallet: input.wallet?.toLowerCase() ?? "",
    chainId: input.chainId ?? 0,
    contract: input.contract.toLowerCase(),
    method: input.method,
    valueWei: input.valueWei,
    taskId: input.taskId.toLowerCase(),
    translation: input.method === "submit" ? input.translation ?? null : null,
  };
}

export function writeQuoteInvalidReason(stored: WriteQuoteBinding | undefined, current: WriteQuoteBinding): string {
  if (!stored) return "No fee quote is bound. Estimate again before signing.";
  if (current.chainId !== STUDIO_DEV_CHAIN_ID) {
    return `Wallet is on chain ${current.chainId}, not Studio-dev ${STUDIO_DEV_CHAIN_ID}. Re-estimate after switching.`;
  }
  if (stored.chainId !== current.chainId) return "Chain changed since the fee quote. Re-estimate.";
  if (!current.wallet || !addressesEqual(stored.wallet, current.wallet)) {
    return "Connected wallet changed since the fee quote. Re-estimate.";
  }
  if (stored.method !== current.method) return "Method changed since the fee quote. Re-estimate.";
  if (stored.valueWei !== current.valueWei) return "Attached value changed since the fee quote. Re-estimate.";
  if (!addressesEqual(stored.contract, current.contract)) return "Contract address changed since the fee quote. Re-estimate.";
  if (stored.taskId !== current.taskId) return "Task ID changed since the fee quote. Re-estimate.";
  if (current.method === "submit" && stored.translation !== current.translation) {
    return "Translation text changed since the fee quote. Re-estimate.";
  }
  return "";
}

export function writeQuoteStillValid(stored: WriteQuoteBinding | undefined, current: WriteQuoteBinding): boolean {
  return writeQuoteInvalidReason(stored, current) === "";
}
