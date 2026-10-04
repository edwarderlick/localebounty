import { afterEach, describe, expect, it, vi } from "vitest";
import { STUDIO_DEV_RPC } from "../../src/live/network";
import { rpcGetTransaction, rpcGetTransactionsForAddress } from "../../src/live/rpc";

describe("Studio-dev transaction RPC methods", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rpcGetTransaction calls eth_getTransactionByHash, not gen_getTransaction", async () => {
    const methods: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        methods.push(body.method);
        expect(_url).toBe(STUDIO_DEV_RPC);
        expect(body.params).toEqual(["0xabc"]);
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { hash: "0xabc" } }), {
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    const result = await rpcGetTransaction("0xabc");
    expect(result).toEqual({ hash: "0xabc" });
    expect(methods).toEqual(["eth_getTransactionByHash"]);
    expect(methods).not.toContain("gen_getTransaction");
  });

  it("rpcGetTransactionsForAddress calls sim_getTransactionsForAddress", async () => {
    const methods: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        methods.push(body.method);
        expect(body.params).toEqual(["0x84dA80726e8A0c6d451Ca3FF88d7dD47F3b07D96"]);
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [{ hash: "0x1" }] }), {
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    const result = await rpcGetTransactionsForAddress("0x84dA80726e8A0c6d451Ca3FF88d7dD47F3b07D96");
    expect(result).toEqual([{ hash: "0x1" }]);
    expect(methods).toEqual(["sim_getTransactionsForAddress"]);
  });

  it("unwraps { transactions } and { txs } envelopes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { transactions: [{ hash: "0x2" }] } }), {
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    expect(await rpcGetTransactionsForAddress("0x1")).toEqual([{ hash: "0x2" }]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { txs: [{ hash: "0x3" }] } }), {
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    expect(await rpcGetTransactionsForAddress("0x1")).toEqual([{ hash: "0x3" }]);
  });
});
