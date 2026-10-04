import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { STUDIO_DEV_CHAIN_ID, STUDIO_DEV_RPC } from "../../src/live/network";
import {
  parseWalletConnectProjectId,
  WALLETCONNECT_APP_METADATA,
  walletConnectInitOptions,
} from "../../src/live/walletConnect";

describe("WalletConnect public-app config", () => {
  it("treats blank env values as disabled and keeps a non-empty id", () => {
    expect(parseWalletConnectProjectId(undefined)).toBeUndefined();
    expect(parseWalletConnectProjectId("")).toBeUndefined();
    expect(parseWalletConnectProjectId("   ")).toBeUndefined();
    expect(parseWalletConnectProjectId("abc123")).toBe("abc123");
  });

  it("uses public LocaleBounty metadata and Studio-dev 61997 RPC", () => {
    const options = walletConnectInitOptions("env-project-id", "http://127.0.0.1:5175");
    expect(options.projectId).toBe("env-project-id");
    expect(options.showQrModal).toBe(true);
    expect(options.optionalChains).toEqual([STUDIO_DEV_CHAIN_ID]);
    expect(options.optionalChains).toEqual([61997]);
    expect(options.rpcMap).toEqual({ [STUDIO_DEV_CHAIN_ID]: STUDIO_DEV_RPC });
    expect(options.rpcMap[61997]).toBe("https://studio-dev.genlayer.com/api");
    expect(options.metadata.name).toBe("LocaleBounty");
    expect(options.metadata.description).toMatch(/LocaleBounty public app/i);
    expect(options.metadata.url).toBe("http://127.0.0.1:5175");
    expect(options.metadata.icons).toEqual(["http://127.0.0.1:5175/favicon.svg"]);
    expect(WALLETCONNECT_APP_METADATA.name).toBe("LocaleBounty");
    expect(WALLETCONNECT_APP_METADATA.description.toLowerCase()).not.toContain("live tests");
  });

  it("does not hardcode a Reown project ID or the old live-tests metadata in source", () => {
    const files = [
      "src/live/walletConnect.ts",
      "src/live/WalletContext.tsx",
      "src/live/eip1193.ts",
      "src/live/WalletCard.tsx",
      "src/components/WalletControl.tsx",
      ".env.example",
    ];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text).not.toMatch(/82a3e381618373fba2f6e309f96ff6ed/i);
      expect(text).not.toContain("LocaleBounty Live Tests");
      expect(text).not.toContain("Studio-dev product and settlement tests");
    }
    expect(readFileSync(".env.example", "utf8")).toMatch(/VITE_WALLETCONNECT_PROJECT_ID=\s*$/m);
  });
});
