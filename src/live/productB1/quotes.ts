import { addressesEqual } from "../format";
import { STUDIO_DEV_CHAIN_ID } from "../network";
import type { B1ActionName } from "./constants";

export type B1QuoteBinding = {
  wallet: string;
  chainId: number;
  contract: string | null;
  translator: string | null;
  method: B1ActionName;
  valueWei: string;
  clientNonce: string | null;
  submitByUnix: string | null;
  recoverAfterUnix: string | null;
  taskId: string | null;
  translation: string | null;
};

export function currentB1QuoteBinding(input: {
  wallet?: string;
  chainId?: number;
  contract?: string | null;
  translator?: string;
  method: B1ActionName;
  valueWei: string;
  clientNonce?: string | null;
  submitByUnix?: number | null;
  recoverAfterUnix?: number | null;
  taskId?: string | null;
  translation?: string | null;
}): B1QuoteBinding {
  return {
    wallet: input.wallet?.toLowerCase() ?? "",
    chainId: input.chainId ?? 0,
    contract: input.contract?.toLowerCase() ?? null,
    translator: input.translator?.toLowerCase() ?? null,
    method: input.method,
    valueWei: input.valueWei,
    clientNonce: input.method === "create" ? input.clientNonce ?? null : null,
    submitByUnix: input.method === "create" && input.submitByUnix != null ? String(input.submitByUnix) : null,
    recoverAfterUnix: input.method === "create" && input.recoverAfterUnix != null ? String(input.recoverAfterUnix) : null,
    taskId: input.method === "create" ? null : input.taskId ?? null,
    translation: input.method === "submit" ? input.translation ?? null : null,
  };
}

export function b1QuoteInvalidReason(stored: B1QuoteBinding | undefined, current: B1QuoteBinding): string | undefined {
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
  if ((stored.contract ?? null) !== (current.contract ?? null) && !addressesEqual(stored.contract ?? "", current.contract ?? "")) {
    return "Contract address changed since the fee quote. Re-estimate.";
  }
  if (current.method === "create") {
    if (!addressesEqual(stored.translator ?? "", current.translator ?? "")) {
      return "Named translator changed since the fee quote. Re-estimate.";
    }
    if (stored.clientNonce !== current.clientNonce) return "client_nonce changed since the fee quote. Re-estimate.";
    if (stored.submitByUnix !== current.submitByUnix || stored.recoverAfterUnix !== current.recoverAfterUnix) {
      return "Deadlines changed since the fee quote. Re-estimate.";
    }
  }
  if (current.method !== "create" && stored.taskId !== current.taskId) {
    return "Task ID changed since the fee quote. Re-estimate.";
  }
  if (current.method === "submit" && stored.translation !== current.translation) {
    return "Translation text changed since the fee quote. Re-estimate.";
  }
  return undefined;
}

export function b1QuoteStillValid(stored: B1QuoteBinding | undefined, current: B1QuoteBinding): boolean {
  return b1QuoteInvalidReason(stored, current) === undefined;
}
