import { describe, expect, it } from "vitest";
import { CalldataAddress } from "genlayer-js/types";
import { encodeCalldataArgs, toCalldataAddress } from "../../src/live/genlayer";
import { formatError } from "../../src/live/format";

const RECIPIENT = "0x7E4E1f7DcC3DA063F9110477Ad348C90E8599253";

describe("GenVM Address encoding", () => {
  it("converts a 20-byte hex string into CalldataAddress bytes", () => {
    const addr = toCalldataAddress(RECIPIENT);
    expect(addr).toBeInstanceOf(CalldataAddress);
    expect(addr.bytes).toHaveLength(20);
    expect(Array.from(addr.bytes.slice(0, 3))).toEqual([0x7e, 0x4e, 0x1f]);
  });

  it("wraps lock args so they are not encoded as TYPE_STR", () => {
    const encoded = encodeCalldataArgs([RECIPIENT, "not-an-address", 1n]);
    expect(encoded?.[0]).toBeInstanceOf(CalldataAddress);
    expect(encoded?.[1]).toBe("not-an-address");
    expect(encoded?.[2]).toBe(1n);
  });

  it("rejects a truncated address", () => {
    expect(() => toCalldataAddress("0x7E4E1f7D")).toThrow(/20-byte/);
  });

  it("explains the Studio-dev invalid-parameters JSON-RPC error", () => {
    expect(formatError({ code: -32602, message: "Missing or invalid parameters. Double check you have provided the correct parameters." })).toMatch(
      /20-byte Address/i,
    );
  });

  it("decodes a base64 Studio-dev UserError instead of the Address hint", () => {
    const payload = Buffer.concat([Buffer.from([1]), Buffer.from("recovery deadline too far")]).toString("base64");
    const message = formatError({
      code: -32602,
      message: "Missing or invalid parameters. Double check you have provided the correct parameters.",
      data: { receipt: { result: payload } },
    });
    expect(message).toMatch(/recovery deadline too far/i);
    expect(message).toMatch(/GetTimestamp/i);
    expect(message).not.toMatch(/20-byte Address/i);
  });

  it("decodes a 0x01 hex UserError payload", () => {
    const hex = "0x01" + Buffer.from("zero value rejected", "utf8").toString("hex");
    const message = formatError({
      code: -32602,
      message: "Missing or invalid parameters. Double check you have provided the correct parameters.",
      cause: { data: { result: hex } },
    });
    expect(message).toMatch(/zero value rejected/i);
    expect(message).not.toMatch(/20-byte Address/i);
  });

  it("does not treat execution failed as Address-only when the receipt is missing", () => {
    const message = formatError({
      code: -32602,
      message: "Missing or invalid parameters. Double check you have provided the correct parameters.",
      details: "execution failed",
    });
    expect(message).toMatch(/deadline or value check/i);
    expect(message).not.toMatch(/not hex strings/i);
  });
});
