import { describe, expect, it } from "vitest";
import { withTimeout } from "../../src/live/timeout";
import { invalidateQuotedAction } from "../../src/live/persist";

describe("fee quote timeout", () => {
  it("rejects a hung estimate so the card can show an error instead of Estimating forever", async () => {
    const hung = new Promise<never>(() => {});
    await expect(withTimeout(hung, 30, "Fee estimate")).rejects.toThrow(/timed out after 0s|timed out after 1s|timed out/);
  });

  it("resolves when the quote returns before the deadline", async () => {
    const value = await withTimeout(Promise.resolve(7), 200, "Fee estimate");
    expect(value).toBe(7);
  });

  it("clears a persisted quoting action that has no tx ID", () => {
    const next = invalidateQuotedAction({ phase: "quoting" });
    expect(next.phase).toBe("idle");
    expect(next.txId).toBeUndefined();
  });

  it("never drops an action that already has a transaction ID", () => {
    const kept = invalidateQuotedAction({
      phase: "waiting",
      txId: `0x${"ab".repeat(32)}`,
    });
    expect(kept.txId).toBe(`0x${"ab".repeat(32)}`);
    expect(kept.phase).toBe("waiting");
  });
});
