import { describe, expect, it } from "vitest";
import {
  ACTUAL_FEE_CONSUMED_LABEL,
  B1_EVALUATE_ACTUAL_FEE_WEI,
  FEE_DEPOSIT_LABEL,
  PROBE_PAYOUT_ACTUAL_FEE_WEI,
  UNUSED_FEE_DEPOSIT_LABEL,
  feeDepositFigures,
  formatGen,
  weiToGen,
} from "../../src/live/format";

describe("wei-to-GEN formatting", () => {
  it("uses 10^18 wei per GEN", () => {
    expect(weiToGen(10n ** 18n)).toBe("1");
    expect(weiToGen(5n * 10n ** 17n)).toBe("0.5");
    expect(formatGen(10n ** 15n)).toBe("0.001 GEN");
  });

  it("formats the historical probe actual fee as 0.000126304500000823 GEN, not 0.126 GEN", () => {
    expect(weiToGen(PROBE_PAYOUT_ACTUAL_FEE_WEI)).toBe("0.000126304500000823");
    expect(formatGen(PROBE_PAYOUT_ACTUAL_FEE_WEI)).toBe("0.000126304500000823 GEN");
    expect(weiToGen(PROBE_PAYOUT_ACTUAL_FEE_WEI)).not.toMatch(/^0\.126/);
    expect(PROBE_PAYOUT_ACTUAL_FEE_WEI).toBe(126304500000823n);
  });

  it("formats the Phase B1 evaluate actual fee as 0.000126529000000823 GEN", () => {
    expect(weiToGen(B1_EVALUATE_ACTUAL_FEE_WEI)).toBe("0.000126529000000823");
    expect(formatGen(B1_EVALUATE_ACTUAL_FEE_WEI)).toBe("0.000126529000000823 GEN");
    expect(weiToGen(B1_EVALUATE_ACTUAL_FEE_WEI)).not.toMatch(/^0\.126/);
    expect(B1_EVALUATE_ACTUAL_FEE_WEI).toBe(126529000000823n);
  });
});

describe("fee deposit versus actual fee labels", () => {
  it("keeps quote deposit, actual consumption, and unused return as separate labels", () => {
    const figures = feeDepositFigures("760929600010352", "126529000000823");
    expect(figures.depositWei).toBe(760929600010352n);
    expect(figures.actualWei).toBe(126529000000823n);
    expect(figures.unusedWei).toBe(760929600010352n - 126529000000823n);
    expect(figures.depositLabel).toBe(
      `${FEE_DEPOSIT_LABEL}: ${formatGen(760929600010352n)} (760929600010352 wei).`,
    );
    expect(figures.actualLabel).toBe(
      `${ACTUAL_FEE_CONSUMED_LABEL}: ${formatGen(126529000000823n)} (126529000000823 wei).`,
    );
    expect(figures.unusedLabel).toBe(
      `${UNUSED_FEE_DEPOSIT_LABEL}: ${formatGen(760929600010352n - 126529000000823n)} (${(760929600010352n - 126529000000823n).toString()} wei).`,
    );
    expect(figures.depositLabel).toMatch(/required upfront/i);
    expect(figures.actualLabel).toMatch(/consumed/i);
    expect(figures.unusedLabel).toMatch(/returned/i);
    expect(figures.depositLabel).not.toBe(figures.actualLabel);
  });

  it("marks unread actual/unused when only a deposit quote exists", () => {
    const figures = feeDepositFigures("378543600010352");
    expect(figures.depositLabel).toMatch(/378543600010352 wei/);
    expect(figures.actualLabel).toBe(`${ACTUAL_FEE_CONSUMED_LABEL}: unread.`);
    expect(figures.unusedLabel).toBe(`${UNUSED_FEE_DEPOSIT_LABEL}: unread.`);
  });
});
