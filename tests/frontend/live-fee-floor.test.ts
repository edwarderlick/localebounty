import { describe, expect, it } from "vitest";
import type { TransactionFeeEstimate } from "genlayer-js/types";
import { describeDeployBlocker, quoteMeetsStudioFloor } from "../../src/live/genlayer";
import { deployFeeHint } from "../../src/live/network";

const FLOOR = 76_548_000_000_000n;

function estimateWithBudget(budget: bigint, floor = FLOOR, feeValue = 1n): TransactionFeeEstimate {
  return {
    distribution: {
      leaderTimeunitsAllocation: 125n,
      validatorTimeunitsAllocation: 250n,
      appealRounds: 1n,
      executionBudgetPerRound: budget,
      executionConsumed: 0n,
      totalMessageFees: 0n,
      rotations: [1n, 1n],
      maxPriceGenPerTimeUnit: 2n,
      storageFeeMaxGasPrice: 1n,
      receiptFeeMaxGasPrice: 1n,
    },
    feeValue,
    policy: {
      enabled: true,
      genPerTimeUnit: 1n,
      storageUnitPrice: 250_000_000n,
      receiptGasPrice: 250_000_000n,
      executionBudgetFloor: floor,
    },
  };
}

describe("Studio-dev fee floor", () => {
  it("does not pin the 786500 execution budget that caused BudgetTooLow", () => {
    expect(deployFeeHint()).not.toHaveProperty("executionBudgetPerRound");
    expect("executionBudgetPerRound" in deployFeeHint()).toBe(false);
  });

  it("rejects the live 3974161-wei quote that reverted BudgetTooLow", () => {
    const bad = quoteMeetsStudioFloor(estimateWithBudget(786_500n, FLOOR, 3_974_161n));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toMatch(/BudgetTooLow|below Studio-dev floor/);
  });

  it("accepts a quote at or above the Studio-dev floor", () => {
    expect(quoteMeetsStudioFloor(estimateWithBudget(FLOOR)).ok).toBe(true);
    expect(quoteMeetsStudioFloor(estimateWithBudget(FLOOR + 1n)).ok).toBe(true);
  });

  it("tells the user to re-estimate after BudgetTooLow instead of reusing the tiny quote", () => {
    const text = describeDeployBlocker(new Error("Transaction reverted: EVM tx 0xabc. BudgetTooLow"));
    expect(text).toMatch(/Estimate fee again/i);
    expect(text).toMatch(/BudgetTooLow/);
    expect(text).not.toMatch(/786500 wei quote is fine/);
  });
});
