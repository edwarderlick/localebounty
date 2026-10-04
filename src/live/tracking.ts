import type { ActionName, ActionRecord, LaneRecord } from "./persist";
import type { TxSummary } from "./genlayer";

export function consensusLayer(
  summary: Pick<TxSummary, "statusName" | "parentSuccessful" | "executionName" | "executionError">,
): {
  walletNote: string;
  consensusNote: string;
  executionNote: string;
  error?: string;
} {
  const status = summary.statusName ?? "unknown";
  const execution = summary.executionName ?? "unknown";
  const reason = summary.executionError ? ` Reason: ${summary.executionError}.` : "";
  const walletNote =
    "Wallet/EVM confirmation is only the envelope. It is not GenLayer execution success.";
  const consensusNote = `Consensus: ${status}`;
  const executionNote = `Execution: ${execution} · isSuccessful ${String(Boolean(summary.parentSuccessful))}`;
  if (summary.parentSuccessful && status === "FINALIZED") {
    return { walletNote, consensusNote, executionNote };
  }
  if (summary.parentSuccessful) {
    return {
      walletNote,
      consensusNote,
      executionNote,
      error: `Waiting for FINALIZED (now ${status}). Not resubmitting.`,
    };
  }
  if (status === "FINALIZED") {
    return {
      walletNote,
      consensusNote,
      executionNote,
      error: `GenLayer execution is ${execution}.${reason} A confirmed MetaMask tx can still fail execution. This hash is finished — use New attempt, do not resubmit it.`,
    };
  }
  if (execution === "FINISHED_WITH_ERROR") {
    return {
      walletNote,
      consensusNote,
      executionNote,
      error: `Execution already ${execution} while consensus is still ${status}.${reason} Waiting for FINALIZED. Not resubmitting this hash.`,
    };
  }
  return {
    walletNote,
    consensusNote,
    executionNote,
    error: `Not successful yet: status=${status} execution=${execution}. Tracking this ID; not resubmitting.`,
  };
}

export function applyTxSummaryToAction<T extends { executionError?: string; contractAddress?: string }>(
  action: T,
  summary: TxSummary,
): T & {
  phase: ActionRecord["phase"];
  txId: string;
  statusName?: string;
  executionName?: string;
  lifecycle?: unknown;
  parentSuccessful: boolean;
  receipt?: unknown;
  actualFeeWei?: string;
  actualFeeSource?: string;
  actualFeeAvailable: boolean;
  error?: string;
  executionError?: string;
  contractAddress?: string;
} {
  const layers = consensusLayer(summary);
  const finalized = summary.statusName === "FINALIZED";
  const phase: ActionRecord["phase"] = finalized
    ? summary.parentSuccessful
      ? "success"
      : "failed"
    : "waiting";
  return {
    ...action,
    phase,
    txId: summary.txId,
    statusName: summary.statusName,
    executionName: summary.executionName,
    lifecycle: summary.lifecycle,
    parentSuccessful: summary.parentSuccessful,
    receipt: summary.receipt,
    actualFeeWei: summary.actualFeeWei,
    actualFeeSource: summary.actualFeeSource,
    actualFeeAvailable: summary.actualFeeAvailable,
    error: layers.error,
    executionError: summary.executionError ?? action.executionError,
    contractAddress: summary.contractAddress ?? action.contractAddress,
  };
}

export function applyTxSummaryToLane(lane: LaneRecord, name: ActionName, summary: TxSummary): LaneRecord {
  const nextAction = applyTxSummaryToAction(lane[name], summary);
  const finalized = summary.statusName === "FINALIZED";
  let next: LaneRecord = { ...lane, [name]: nextAction };
  if (name === "deploy") {
    next = { ...next, deployBlocker: undefined };
    if (summary.parentSuccessful && summary.contractAddress) {
      next = { ...next, address: summary.contractAddress };
    } else if (finalized && !summary.parentSuccessful && !lane.imported) {
      next = { ...next, address: undefined };
    }
    if (summary.parentSuccessful && finalized && !summary.contractAddress && !next.address) {
      next = {
        ...next,
        deployBlocker:
          "Deploy parent succeeded but the receipt had no contract address. Import the Studio-dev address from the explorer; do not resubmit automatically.",
      };
    }
  }
  return next;
}
