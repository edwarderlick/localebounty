import { parseWalletConnectProjectId } from "./walletConnect";

export type Eip1193RequestArgs = {
  method: string;
  params?: unknown;
};

export type Eip1193Provider = {
  request: (args: Eip1193RequestArgs) => Promise<unknown>;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
  disconnect?: () => Promise<void>;
};

export type Eip6963ProviderInfo = {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
};

export type Eip6963ProviderDetail = {
  info: Eip6963ProviderInfo;
  provider: Eip1193Provider;
};

export type DiscoveredWallet = {
  id: string;
  name: string;
  icon?: string;
  rdns?: string;
  kind: "injected" | "walletconnect";
  provider: Eip1193Provider;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function walletConnectProjectId(): string | undefined {
  return parseWalletConnectProjectId(import.meta.env.VITE_WALLETCONNECT_PROJECT_ID);
}

export function discoverEip6963Wallets(): DiscoveredWallet[] {
  const found = new Map<string, DiscoveredWallet>();

  function onAnnounce(event: Event) {
    const detail = (event as CustomEvent<Eip6963ProviderDetail>).detail;
    if (!detail?.info?.uuid || !detail.provider) return;
    found.set(detail.info.uuid, {
      id: detail.info.uuid,
      name: detail.info.name,
      icon: detail.info.icon,
      rdns: detail.info.rdns,
      kind: "injected",
      provider: detail.provider,
    });
  }

  window.addEventListener("eip6963:announceProvider", onAnnounce);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  window.removeEventListener("eip6963:announceProvider", onAnnounce);

  if (found.size === 0) {
    const injected = window.ethereum;
    if (injected) {
      found.set("injected", {
        id: "injected",
        name: "Injected wallet",
        kind: "injected",
        provider: injected,
      });
    }
  }

  return [...found.values()];
}

export async function requestAccounts(provider: Eip1193Provider): Promise<`0x${string}`[]> {
  const result = await provider.request({ method: "eth_requestAccounts" });
  if (!Array.isArray(result)) return [];
  return result.filter((item): item is `0x${string}` => typeof item === "string" && /^0x[a-fA-F0-9]{40}$/.test(item));
}

export async function readAccounts(provider: Eip1193Provider): Promise<`0x${string}`[]> {
  const result = await provider.request({ method: "eth_accounts" });
  if (!Array.isArray(result)) return [];
  return result.filter((item): item is `0x${string}` => typeof item === "string" && /^0x[a-fA-F0-9]{40}$/.test(item));
}

export async function readChainId(provider: Eip1193Provider): Promise<number> {
  const result = await provider.request({ method: "eth_chainId" });
  if (typeof result !== "string" && typeof result !== "number") {
    throw new Error("Wallet did not return eth_chainId");
  }
  return Number(result);
}

export async function readWalletIdentity(provider: Eip1193Provider): Promise<{
  address: `0x${string}`;
  chainId: number;
}> {
  const accounts = await readAccounts(provider);
  if (!accounts[0]) throw new Error("Selected wallet has no account. Reconnect before signing.");
  const chainId = await readChainId(provider);
  return { address: accounts[0], chainId };
}

export function isUserRejection(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const code = error.code;
  const message = String(error.message ?? error.shortMessage ?? "");
  return (
    code === 4001 ||
    code === "ACTION_REJECTED" ||
    /user rejected|rejected the request|denied transaction/i.test(message)
  );
}
