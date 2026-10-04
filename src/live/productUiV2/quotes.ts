import { addressesEqual } from "../format";
import { STUDIO_DEV_CHAIN_ID } from "../network";

export type V2ProductQuoteBinding = {
  wallet: string;
  chainId: number;
  contract: string;
  translator: string | null;
  method: "create" | "accept" | "cancel" | "submit" | "evaluate" | "expire" | "recover";
  valueWei: string;
  clientNonce: string | null;
  submitByUnix: string | null;
  recoverAfterUnix: string | null;
  taskId: string | null;
  translation: string | null;
};

export function currentV2ProductQuoteBinding(input: {
  wallet?: string;
  chainId?: number;
  contract: string;
  translator?: string;
  method: "create" | "accept" | "cancel" | "submit" | "evaluate" | "expire" | "recover";
  valueWei: string;
  clientNonce?: string | null;
  submitByUnix?: number | null;
  recoverAfterUnix?: number | null;
  taskId?: string | null;
  translation?: string | null;
}): V2ProductQuoteBinding {
  const isCreate = input.method === "create";
  const needsTask = input.method !== "create";
  return {
    wallet: input.wallet?.toLowerCase() ?? "",
    chainId: input.chainId ?? 0,
    contract: input.contract.toLowerCase(),
    translator: input.translator?.toLowerCase() ?? null,
    method: input.method,
    valueWei: input.valueWei,
    clientNonce: isCreate ? input.clientNonce ?? null : null,
    submitByUnix: isCreate && input.submitByUnix != null ? String(input.submitByUnix) : null,
    recoverAfterUnix: isCreate && input.recoverAfterUnix != null ? String(input.recoverAfterUnix) : null,
    taskId: needsTask ? input.taskId ?? null : isCreate ? input.taskId ?? null : null,
    translation: input.method === "submit" ? input.translation ?? null : null,
  };
}

export function v2ProductQuoteInvalidReason(
  stored: V2ProductQuoteBinding | undefined,
  current: V2ProductQuoteBinding,
): string | undefined {
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

export function v2ProductQuoteStillValid(
  stored: V2ProductQuoteBinding | undefined,
  current: V2ProductQuoteBinding,
): boolean {
  return v2ProductQuoteInvalidReason(stored, current) === undefined;
}
