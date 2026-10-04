import { STUDIO_DEV_CHAIN_ID, STUDIO_DEV_RPC } from "./network";

/** Public app metadata for the WalletConnect / Reown modal. Project ID stays in env. */
export const WALLETCONNECT_APP_METADATA = {
  name: "LocaleBounty",
  description: "LocaleBounty public app: translation bounties for short app strings on GenLayer Studio-dev.",
} as const;

export function parseWalletConnectProjectId(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function walletConnectInitOptions(projectId: string, origin: string) {
  return {
    projectId,
    showQrModal: true,
    optionalChains: [STUDIO_DEV_CHAIN_ID] as [number, ...number[]],
    rpcMap: { [STUDIO_DEV_CHAIN_ID]: STUDIO_DEV_RPC },
    metadata: {
      name: WALLETCONNECT_APP_METADATA.name,
      description: WALLETCONNECT_APP_METADATA.description,
      url: origin,
      icons: [`${origin}/favicon.svg`],
    },
  };
}
