import { addressesEqual } from "../format";
import { STUDIO_DEV_CHAIN_ID } from "../network";
import type { ProductV2ActionName } from "./constants";

export type ProductV2QuoteBinding = {
  wallet: string;
  chainId: number;
  contract: string | null;
  translator: string | null;
  method: ProductV2ActionName;
  valueWei: string;
  clientNonce: string | null;
  submitByUnix: string | null;
  recoverAfterUnix: string | null;
  taskId: string | null;
};

export function currentV2QuoteBinding(input: {
  wallet?: string;
  chainId?: number;
  contract?: string | null;
  translator?: string;
  method: ProductV2ActionName;
  valueWei: string;
  clientNonce?: string | null;
  submitByUnix?: number | null;
  recoverAfterUnix?: number | null;
  taskId?: string | null;
}): ProductV2QuoteBinding {
  const isCreate = input.method === "createA" || input.method === "createB";
  const needsTask =
    input.method === "cancelA" ||
    input.method === "cancelB" ||
    input.method === "acceptB" ||
    input.method === "expireB";
  return {
    wallet: input.wallet?.toLowerCase() ?? "",
    chainId: input.chainId ?? 0,
    contract: input.method === "deploy" ? null : input.contract?.toLowerCase() ?? null,
    translator: input.translator?.toLowerCase() ?? null,
    method: input.method,
    valueWei: input.valueWei,
    clientNonce: isCreate ? input.clientNonce ?? null : null,
    submitByUnix: isCreate && input.submitByUnix != null ? String(input.submitByUnix) : null,
    recoverAfterUnix: isCreate && input.recoverAfterUnix != null ? String(input.recoverAfterUnix) : null,
    taskId: needsTask ? input.taskId ?? null : null,
  };
}

export function v2QuoteInvalidReason(
  stored: ProductV2QuoteBinding | undefined,
  current: ProductV2QuoteBinding,
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
  if (current.method !== "deploy") {
    if ((stored.contract ?? null) !== (current.contract ?? null) && !addressesEqual(stored.contract ?? "", current.contract ?? "")) {
      return "Contract address changed since the fee quote. Re-estimate.";
    }
  }
  if (current.method === "createA" || current.method === "createB") {
    if (!addressesEqual(stored.translator ?? "", current.translator ?? "")) {
      return "Named translator changed since the fee quote. Re-estimate.";
    }
    if (stored.clientNonce !== current.clientNonce) return "client_nonce changed since the fee quote. Re-estimate.";
    if (stored.submitByUnix !== current.submitByUnix || stored.recoverAfterUnix !== current.recoverAfterUnix) {
      return "Deadlines changed since the fee quote. Re-estimate.";
    }
  }
  if (
    (current.method === "cancelA" ||
      current.method === "cancelB" ||
      current.method === "acceptB" ||
      current.method === "expireB") &&
    stored.taskId !== current.taskId
  ) {
    return "Task ID changed since the fee quote. Re-estimate.";
  }
  return undefined;
}

export function v2QuoteStillValid(stored: ProductV2QuoteBinding | undefined, current: ProductV2QuoteBinding): boolean {
  return v2QuoteInvalidReason(stored, current) === undefined;
}
