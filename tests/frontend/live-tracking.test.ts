import { describe, expect, it, beforeEach } from "vitest";
import { applyTxSummaryToLane, consensusLayer } from "../../src/live/tracking";
import { emptyLane, LIVE_STORAGE_KEY, loadSession, saveSession, type LaneRecord } from "../../src/live/persist";
import { extractExecutionError, type TxSummary } from "../../src/live/genlayer";
import type { GenLayerTransaction } from "genlayer-js/types";

const FAILED_ADDR = "0x261ba97DA7C5f161AD9Dcb9286571d3CF0a5EA32";
const FAILED_TX = "0xcff25696bcfbb8f0709dd11b1c07adb4e7a43f7f3c6f2144383004612c211008";
const OK_ADDR = "0x3333333333333333333333333333333333333333";
const OK_TX = `0x${"11".repeat(32)}`;

function failedDeploySummary(): TxSummary {
  return {
    txId: FAILED_TX,
    statusName: "FINALIZED",
    executionName: "FINISHED_WITH_ERROR",
    parentSuccessful: false,
    contractAddress: FAILED_ADDR,
    actualFeeAvailable: false,
  };
}

function successfulDeploySummary(): TxSummary {
  return {
    txId: OK_TX,
    statusName: "FINALIZED",
    executionName: "FINISHED_WITH_RETURN",
    parentSuccessful: true,
    contractAddress: OK_ADDR,
    actualFeeAvailable: false,
  };
}

describe("extractExecutionError", () => {
  it("decodes the Studio-dev validator payload invalid_contract runner malformed", () => {
    const tx = {
      consensus_data: {
        validators: [
          {
            result: "AmludmFsaWRfY29udHJhY3QgcnVubmVyIG1hbGZvcm1lZA==",
            execution_result: "ERROR",
          },
        ],
      },
    } as unknown as GenLayerTransaction;
    expect(extractExecutionError(tx)).toBe("invalid_contract runner malformed");
  });

  it("strips the GenVM UserError 0x01 prefix from submission deadline in the past", () => {
    const tx = {
      consensus_data: {
        leader: { result: "AXN1Ym1pc3Npb24gZGVhZGxpbmUgaW4gdGhlIHBhc3Q=" },
        validators: [{ result: "AXN1Ym1pc3Npb24gZGVhZGxpbmUgaW4gdGhlIHBhc3Q=", execution_result: "ERROR" }],
      },
    } as unknown as GenLayerTransaction;
    expect(extractExecutionError(tx)).toBe("submission deadline in the past");
  });
});

describe("consensusLayer", () => {
  it("says MetaMask confirm is not GenLayer success when execution errored", () => {
    const layers = consensusLayer({
      statusName: "FINALIZED",
      executionName: "FINISHED_WITH_ERROR",
      parentSuccessful: false,
    });
    expect(layers.walletNote).toMatch(/envelope/i);
    expect(layers.error).toMatch(/FINISHED_WITH_ERROR|execution/i);
    expect(layers.error).toMatch(/New attempt|finished/i);
  });

  it("has no error when FINALIZED and isSuccessful", () => {
    const layers = consensusLayer({
      statusName: "FINALIZED",
      executionName: "FINISHED_WITH_RETURN",
      parentSuccessful: true,
    });
    expect(layers.error).toBeUndefined();
  });
});

describe("applyTxSummaryToLane", () => {
  it("does not keep a failed deploy receipt as the live instance, and drops leftover BudgetTooLow copy", () => {
    const lane: LaneRecord = {
      ...emptyLane(),
      address: FAILED_ADDR,
      deployBlocker: "Browser-wallet deployContract was not completed.\nBudgetTooLow",
      deploy: { phase: "waiting", txId: FAILED_TX },
    };
    const next = applyTxSummaryToLane(lane, "deploy", failedDeploySummary());
    expect(next.address).toBeUndefined();
    expect(next.deployBlocker).toBeUndefined();
    expect(next.deploy.phase).toBe("failed");
    expect(next.deploy.parentSuccessful).toBe(false);
    expect(next.deploy.contractAddress).toBe(FAILED_ADDR);
    expect(next.deploy.error).toMatch(/FINISHED_WITH_ERROR/);
  });

  it("keeps tracking ACCEPTED + FINISHED_WITH_ERROR instead of offering a new hash", () => {
    const summary: TxSummary = {
      txId: FAILED_TX,
      statusName: "ACCEPTED",
      executionName: "FINISHED_WITH_ERROR",
      parentSuccessful: false,
      contractAddress: FAILED_ADDR,
      actualFeeAvailable: false,
      executionError: "invalid_contract runner malformed",
    };
    const next = applyTxSummaryToLane(emptyLane(), "deploy", summary);
    expect(next.deploy.phase).toBe("waiting");
    expect(next.address).toBeUndefined();
    expect(next.deploy.error).toMatch(/Waiting for FINALIZED/i);
    expect(next.deploy.error).toMatch(/invalid_contract runner malformed/);
    expect(consensusLayer(summary).error).not.toMatch(/This hash is finished/i);
  });

  it("sets the live instance only after a successful deploy", () => {
    const next = applyTxSummaryToLane(emptyLane(), "deploy", successfulDeploySummary());
    expect(next.address).toBe(OK_ADDR);
    expect(next.deploy.phase).toBe("success");
    expect(next.deployBlocker).toBeUndefined();
  });
});

describe("persist sanitizes failed deploy instances", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    globalThis.localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => store.clear(),
      length: 0,
      key: () => null,
    };
  });

  it("drops failed-deploy address and stale BudgetTooLow blocker on load", () => {
    localStorage.setItem(
      LIVE_STORAGE_KEY,
      JSON.stringify({
        version: 2,
        recipient: "0x2222222222222222222222222222222222222222",
        release: {
          address: FAILED_ADDR,
          deployBlocker: "BudgetTooLow leftover",
          deploy: {
            phase: "failed",
            txId: FAILED_TX,
            statusName: "FINALIZED",
            executionName: "FINISHED_WITH_ERROR",
            parentSuccessful: false,
          },
          lock: { phase: "idle" },
          payout: { phase: "idle" },
          paymentEvidence: "UNPROVEN",
          paymentReason: "none",
        },
      }),
    );
    const loaded = loadSession();
    expect(loaded.release.address).toBeUndefined();
    expect(loaded.release.deployBlocker).toBeUndefined();
    expect(loaded.release.deploy.txId).toBe(FAILED_TX);
  });

  it("keeps a successful deploy address", () => {
    const session = loadSession();
    session.release.address = OK_ADDR;
    session.release.deploy = {
      phase: "success",
      txId: OK_TX,
      statusName: "FINALIZED",
      executionName: "FINISHED_WITH_RETURN",
      parentSuccessful: true,
    };
    saveSession(session);
    expect(loadSession().release.address).toBe(OK_ADDR);
  });
});
