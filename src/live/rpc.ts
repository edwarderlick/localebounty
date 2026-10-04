import { STUDIO_DEV_RPC } from "./network";
import { formatError } from "./format";

type JsonRpcResult = {
  result?: unknown;
  error?: { message?: string; code?: number };
};

async function studioDevRpc(method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(STUDIO_DEV_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method,
      params,
    }),
  });
  if (!response.ok) {
    throw new Error(`Studio-dev RPC HTTP ${response.status}`);
  }
  const body = (await response.json()) as JsonRpcResult;
  if (body.error) {
    throw new Error(body.error.message ?? `Studio-dev RPC error ${body.error.code ?? ""}`.trim());
  }
  return body.result;
}

export async function rpcGetBalance(address: string): Promise<bigint> {
  try {
    const result = await studioDevRpc("eth_getBalance", [address, "latest"]);
    if (typeof result !== "string" && typeof result !== "number") {
      throw new Error("eth_getBalance did not return hex");
    }
    return BigInt(result);
  } catch (error) {
    throw new Error(`Studio-dev eth_getBalance failed: ${formatError(error)}`);
  }
}

export type EoaBalances = {
  funder: string;
  named: string;
  contract: string | null;
  funderWei: string;
  namedWei: string;
  contractWei: string | null;
  unixMs: number;
};

export async function rpcGetContractCode(address: string): Promise<unknown> {
  try {
    return await studioDevRpc("gen_getContractCode", [address]);
  } catch (error) {
    throw new Error(`Studio-dev gen_getContractCode failed: ${formatError(error)}`);
  }
}

export async function rpcGetTransaction(txId: string): Promise<unknown> {
  try {
    return await studioDevRpc("eth_getTransactionByHash", [txId]);
  } catch (error) {
    throw new Error(`Studio-dev eth_getTransactionByHash failed: ${formatError(error)}`);
  }
}

export async function rpcGetTransactionsForAddress(address: string): Promise<unknown[]> {
  try {
    const result = await studioDevRpc("sim_getTransactionsForAddress", [address]);
    if (Array.isArray(result)) return result;
    if (result && typeof result === "object") {
      const rec = result as { transactions?: unknown; txs?: unknown };
      if (Array.isArray(rec.transactions)) return rec.transactions;
      if (Array.isArray(rec.txs)) return rec.txs;
    }
    throw new Error("sim_getTransactionsForAddress did not return an array");
  } catch (error) {
    throw new Error(`Studio-dev sim_getTransactionsForAddress failed: ${formatError(error)}`);
  }
}

export async function readEoaBalances(input: {
  funder: string;
  named: string;
  contract?: string | null;
}): Promise<EoaBalances> {
  const funderWei = await rpcGetBalance(input.funder);
  const namedWei = await rpcGetBalance(input.named);
  const contractWei = input.contract ? await rpcGetBalance(input.contract) : null;
  return {
    funder: input.funder,
    named: input.named,
    contract: input.contract ?? null,
    funderWei: funderWei.toString(),
    namedWei: namedWei.toString(),
    contractWei: contractWei?.toString() ?? null,
    unixMs: Date.now(),
  };
}
