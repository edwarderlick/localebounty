import { createClient, isSuccessful } from "genlayer-js";
import { studioDevnet } from "genlayer-js/chains";
import { CalldataAddress } from "genlayer-js/types";
import type {
  CalldataEncodable,
  GenLayerClient,
  GenLayerTransaction,
  TransactionFeeEstimate,
  TransactionFeeOptions,
  TransactionHash,
} from "genlayer-js/types";
import type { Eip1193Provider } from "./eip1193";
import { extractFinalizedFee } from "./fees";
import { formatError, isEoaAddress, jsonSafe } from "./format";
import { deployFeeHint, QUOTE_TIMEOUT_MS, RECEIPT_INTERVAL_MS, RECEIPT_RETRIES, STUDIO_DEV_CHAIN_ID, STUDIO_DEV_RPC, TRACK_POLL_MS } from "./network";
import { withTimeout } from "./timeout";
import settlementProbeSource from "../../contracts/experimental/settlement_probe.py?raw";
import localebountySource from "../../contracts/localebounty.py?raw";
import localebountyV2Source from "../../contracts/localebounty_v2.py?raw";

export const SETTLEMENT_PROBE_SOURCE = settlementProbeSource;
export const PRODUCT_SOURCE = localebountySource;
export const PRODUCT_V2_SOURCE = localebountyV2Source;

export function assertStudioDevnetPreset(): void {
  if (studioDevnet.id !== STUDIO_DEV_CHAIN_ID) {
    throw new Error(
      `Installed genlayer-js studioDevnet.id is ${studioDevnet.id}, expected ${STUDIO_DEV_CHAIN_ID}. Do not use studionet.`,
    );
  }
  const rpc = studioDevnet.rpcUrls.default.http[0];
  if (rpc !== STUDIO_DEV_RPC) {
    throw new Error(`Installed studioDevnet RPC is ${rpc}, expected ${STUDIO_DEV_RPC}`);
  }
}

export function createReadClient() {
  assertStudioDevnetPreset();
  return createClient({ chain: studioDevnet });
}

/** GenVM Address is SPECIAL_ADDR bytes, not a hex string. Strings encode as TYPE_STR and Studio-dev rejects them. */
export function toCalldataAddress(value: string): CalldataAddress {
  const hex = value.trim();
  if (!isEoaAddress(hex)) {
    throw new Error(`Not a 20-byte address: ${value}`);
  }
  const bytes = new Uint8Array(20);
  for (let i = 0; i < 20; i++) {
    bytes[i] = Number.parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16);
  }
  return new CalldataAddress(bytes);
}

export function encodeCalldataArgs(args: unknown[] | undefined): CalldataEncodable[] | undefined {
  if (!args) return undefined;
  return args.map((arg) => {
    if (typeof arg === "string" && isEoaAddress(arg)) return toCalldataAddress(arg);
    return arg as CalldataEncodable;
  });
}

export function createWriteClient(address: `0x${string}`, provider: Eip1193Provider) {
  assertStudioDevnetPreset();
  return createClient({
    chain: studioDevnet,
    account: address,
    provider,
  });
}

export function quoteMeetsStudioFloor(estimate: TransactionFeeEstimate): { ok: true } | { ok: false; reason: string } {
  const floor = estimate.policy?.executionBudgetFloor ?? 0n;
  const budget = estimate.distribution.executionBudgetPerRound;
  if (floor > 0n && budget < floor) {
    return {
      ok: false,
      reason: `Quoted executionBudgetPerRound ${budget.toString()} wei is below Studio-dev floor ${floor.toString()} wei (BudgetTooLow). Estimate again; do not sign this quote.`,
    };
  }
  if (estimate.feeValue <= 0n) {
    return { ok: false, reason: "Fee quote feeValue is 0. Estimate again." };
  }
  return { ok: true };
}

export function feesFromEstimate(estimate: TransactionFeeEstimate): TransactionFeeOptions {
  const fees: TransactionFeeOptions = {
    distribution: estimate.distribution,
    feeValue: estimate.feeValue,
  };
  if (estimate.messageAllocations != null) {
    fees.messageAllocations = estimate.messageAllocations;
  }
  return fees;
}

export type TxSummary = {
  txId: string;
  statusName?: string;
  executionName?: string;
  lifecycle?: unknown;
  parentSuccessful: boolean;
  contractAddress?: string;
  recipient?: string;
  receipt?: unknown;
  actualFeeWei?: string;
  actualFeeSource?: string;
  actualFeeAvailable: boolean;
  executionError?: string;
};

function decodeGenvmPayload(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  try {
    const binary = atob(raw);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    let start = 0;
    if (bytes.length > 1 && (bytes[0] === 1 || bytes[0] === 2)) start = 1;
    const text = new TextDecoder()
      .decode(bytes.slice(start))
      .replace(/^[\u0000-\u001f]+/, "")
      .trim();
    return text || undefined;
  } catch {
    return raw;
  }
}

/** Pull the GenVM / validator reason out of a Studio-dev receipt. */
export function extractExecutionError(tx: GenLayerTransaction): string | undefined {
  const data = tx as GenLayerTransaction & {
    consensus_data?: {
      leader?: { result?: unknown; genvm_result?: { error_description?: string; stderr?: string } };
      validators?: Array<{
        result?: unknown;
        execution_result?: string;
        genvm_result?: { error_description?: string; stderr?: string };
      }>;
    };
  };
  const parts: string[] = [];
  const leader = data.consensus_data?.leader;
  const leaderMsg =
    decodeGenvmPayload(leader?.result) ??
    leader?.genvm_result?.error_description ??
    leader?.genvm_result?.stderr;
  if (leaderMsg) parts.push(leaderMsg);
  for (const validator of data.consensus_data?.validators ?? []) {
    const msg =
      decodeGenvmPayload(validator.result) ??
      validator.genvm_result?.error_description ??
      validator.genvm_result?.stderr;
    if (msg && !parts.includes(msg)) parts.push(msg);
  }
  const useful = parts.filter((part) => part && part !== "agree" && part !== "ERROR");
  return useful[0];
}

export function extractContractAddress(tx: GenLayerTransaction): string | undefined {
  const decoded = tx.txDataDecoded as { contractAddress?: string; contract_address?: string } | undefined;
  if (decoded?.contractAddress) return decoded.contractAddress;
  if (decoded?.contract_address) return decoded.contract_address;
  if (typeof tx.recipient === "string" && /^0x[a-fA-F0-9]{40}$/.test(tx.recipient) && !/^0x0{40}$/i.test(tx.recipient)) {
    return tx.recipient;
  }
  const data = tx.data;
  if (data && typeof data.contract_address === "string") return data.contract_address;
  if (data && typeof data.contractAddress === "string") return data.contractAddress;
  return undefined;
}

export function summarizeTx(txId: string, tx: GenLayerTransaction): TxSummary {
  const receipt = jsonSafe(tx);
  const fee = extractFinalizedFee(receipt);
  const statusName =
    tx.statusName ??
    (typeof tx.status === "string" ? tx.status : undefined);
  return {
    txId,
    statusName,
    executionName: tx.txExecutionResultName,
    lifecycle: jsonSafe(tx.lifecycle),
    parentSuccessful: isSuccessful(tx),
    contractAddress: extractContractAddress(tx),
    recipient: typeof tx.recipient === "string" ? tx.recipient : undefined,
    receipt,
    actualFeeWei: fee.feeWei?.toString(),
    actualFeeSource: fee.source,
    actualFeeAvailable: fee.available,
    executionError: extractExecutionError(tx),
  };
}

export async function waitForTx(readClient: GenLayerClient<typeof studioDevnet>, txId: string): Promise<TxSummary> {
  const tx = await readClient.waitForFinalization({
    hash: txId as TransactionHash,
    interval: RECEIPT_INTERVAL_MS,
    retries: RECEIPT_RETRIES,
    fullTransaction: true,
  });
  return summarizeTx(txId, tx);
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** Poll getTransaction so the UI can show ACCEPTED/execution before waitForFinalization returns. */
export async function watchTx(
  readClient: GenLayerClient<typeof studioDevnet>,
  txId: string,
  onUpdate: (summary: TxSummary) => void,
): Promise<TxSummary> {
  const deadline = Date.now() + RECEIPT_INTERVAL_MS * RECEIPT_RETRIES;
  let last: TxSummary | undefined;
  while (Date.now() < deadline) {
    try {
      const tx = await readClient.getTransaction({ hash: txId as TransactionHash });
      last = summarizeTx(txId, tx);
      onUpdate(last);
      if (last.statusName === "FINALIZED") return last;
    } catch {
      // Hash may not be indexed on Studio-dev yet.
    }
    await sleep(TRACK_POLL_MS);
  }
  if (last?.statusName === "FINALIZED") return last;
  const finalSummary = await waitForTx(readClient, txId);
  onUpdate(finalSummary);
  return finalSummary;
}

async function requireStudioFloor(estimate: TransactionFeeEstimate): Promise<TransactionFeeEstimate> {
  const check = quoteMeetsStudioFloor(estimate);
  if (!check.ok) throw new Error(check.reason);
  return estimate;
}

export async function quoteDeploy(): Promise<TransactionFeeEstimate> {
  const client = createReadClient();
  const estimate = await withTimeout(client.estimateTransactionFees(deployFeeHint()), QUOTE_TIMEOUT_MS, "Fee estimate");
  return requireStudioFloor(estimate);
}

export async function quoteWrite(input: {
  address: `0x${string}`;
  functionName: string;
  args?: unknown[];
  value?: bigint;
  from?: `0x${string}`;
}): Promise<TransactionFeeEstimate> {
  assertStudioDevnetPreset();
  const client = createClient({
    chain: studioDevnet,
    ...(input.from ? { account: input.from } : {}),
  });
  const estimate = await withTimeout(
    client.estimateTransactionFeesForWrite({
      address: input.address,
      functionName: input.functionName,
      args: encodeCalldataArgs(input.args) as never,
      value: input.value ?? 0n,
      ...(input.from ? { account: { address: input.from } as never } : {}),
    }),
    QUOTE_TIMEOUT_MS,
    "Fee estimate",
  );
  return requireStudioFloor(estimate);
}

export async function submitDeploy(
  writeClient: ReturnType<typeof createWriteClient>,
  estimate: TransactionFeeEstimate,
): Promise<string> {
  const txId = await writeClient.deployContract({
    code: SETTLEMENT_PROBE_SOURCE,
    args: [],
    fees: feesFromEstimate(estimate),
  });
  return String(txId);
}

export async function submitProductDeploy(
  writeClient: ReturnType<typeof createWriteClient>,
  estimate: TransactionFeeEstimate,
): Promise<string> {
  const txId = await writeClient.deployContract({
    code: PRODUCT_SOURCE,
    args: [],
    fees: feesFromEstimate(estimate),
  });
  return String(txId);
}

export async function submitProductV2Deploy(
  writeClient: ReturnType<typeof createWriteClient>,
  estimate: TransactionFeeEstimate,
): Promise<string> {
  const txId = await writeClient.deployContract({
    code: PRODUCT_V2_SOURCE,
    args: [],
    fees: feesFromEstimate(estimate),
  });
  return String(txId);
}

export async function readProductView(
  readClient: ReturnType<typeof createReadClient>,
  address: string,
  functionName: string,
  args: unknown[] = [],
): Promise<unknown> {
  return readClient.readContract({
    address: address as `0x${string}`,
    functionName,
    args: encodeCalldataArgs(args) as never,
    jsonSafeReturn: true,
  });
}

export async function readProductTask(
  readClient: ReturnType<typeof createReadClient>,
  address: string,
  taskId: string,
): Promise<unknown> {
  return readProductView(readClient, address, "get_task", [taskId]);
}

export async function submitWrite(
  writeClient: ReturnType<typeof createWriteClient>,
  input: {
    address: `0x${string}`;
    functionName: string;
    args?: unknown[];
    value?: bigint;
    estimate: TransactionFeeEstimate;
  },
): Promise<string> {
  const txId = await writeClient.writeContract({
    address: input.address,
    functionName: input.functionName,
    args: encodeCalldataArgs(input.args) as never,
    value: input.value ?? 0n,
    fees: feesFromEstimate(input.estimate),
  });
  return String(txId);
}

export async function readSnapshot(
  readClient: ReturnType<typeof createReadClient>,
  address: string,
): Promise<unknown> {
  return readClient.readContract({
    address: address as `0x${string}`,
    functionName: "get_snapshot",
    args: [],
    jsonSafeReturn: true,
  });
}

export function describeDeployBlocker(error: unknown): string {
  const detail = formatError(error);
  if (/BudgetTooLow|executionBudgetPerRound .* below Studio-dev floor/i.test(detail)) {
    return `BudgetTooLow: Studio-dev rejected the fee budget. Estimate fee again — expect about 0.08 GEN, not a few million wei. ${detail}`;
  }
  return `Deploy did not complete. ${detail}`;
}
