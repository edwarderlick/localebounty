import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  discoverEip6963Wallets,
  isUserRejection,
  readAccounts,
  readChainId,
  requestAccounts,
  readWalletIdentity,
  walletConnectProjectId,
  type DiscoveredWallet,
  type Eip1193Provider,
} from "./eip1193";
import { formatError } from "./format";
import { STUDIO_DEV_CHAIN_ID } from "./network";
import { rpcGetBalance } from "./rpc";
import { switchOrAddStudioDev } from "./switchChain";
import { walletConnectInitOptions } from "./walletConnect";

type WalletContextValue = {
  wallets: DiscoveredWallet[];
  walletConnectEnabled: boolean;
  connecting: boolean;
  connected: boolean;
  address?: `0x${string}`;
  chainId?: number;
  balanceWei?: bigint;
  balanceError?: string;
  walletName?: string;
  walletKind?: DiscoveredWallet["kind"];
  error?: string;
  onStudioDev: boolean;
  connectInjected: (wallet: DiscoveredWallet) => Promise<void>;
  connectWalletConnect: () => Promise<void>;
  disconnect: () => Promise<void>;
  switchToStudioDev: () => Promise<void>;
  refreshBalance: () => Promise<void>;
  verifyBeforeWrite: () => Promise<{ address: `0x${string}`; chainId: number }>;
  provider?: Eip1193Provider;
};

const WALLET_SESSION_KEY = "localebounty.live-wallet-id";

const WalletContext = createContext<WalletContextValue | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [wallets, setWallets] = useState<DiscoveredWallet[]>([]);
  const [connecting, setConnecting] = useState(false);
  const [address, setAddress] = useState<`0x${string}` | undefined>();
  const [chainId, setChainId] = useState<number | undefined>();
  const [balanceWei, setBalanceWei] = useState<bigint | undefined>();
  const [balanceError, setBalanceError] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [active, setActive] = useState<DiscoveredWallet | undefined>();
  const wcRef = useRef<Eip1193Provider | undefined>();
  const activeRef = useRef<DiscoveredWallet | undefined>();
  activeRef.current = active;

  const walletConnectEnabled = Boolean(walletConnectProjectId());

  const refreshBalance = useCallback(async (nextAddress = address) => {
    if (!nextAddress) {
      setBalanceWei(undefined);
      setBalanceError(undefined);
      return;
    }
    try {
      const wei = await rpcGetBalance(nextAddress);
      setBalanceWei(wei);
      setBalanceError(undefined);
    } catch (err) {
      setBalanceWei(undefined);
      setBalanceError(formatError(err));
    }
  }, [address]);

  const attachListeners = useCallback((wallet: DiscoveredWallet) => {
    const provider = wallet.provider;
    const onAccounts = (...args: unknown[]) => {
      const accounts = Array.isArray(args[0]) ? (args[0] as string[]) : [];
      const next = accounts[0];
      if (!next || !/^0x[a-fA-F0-9]{40}$/.test(next)) {
        // MetaMask emits [] while locked or while the confirm sheet is open.
        // Keep the last address and provider so the page does not flash disconnected.
        setError("MetaMask briefly reported no account (lock or confirm sheet). Unlock if needed — the connection was kept.");
        return;
      }
      const checksum = next as `0x${string}`;
      setAddress(checksum);
      setError(undefined);
      void refreshBalance(checksum);
    };
    const onChain = (...args: unknown[]) => {
      const value = args[0];
      if (typeof value === "string" || typeof value === "number") {
        setChainId(Number(value));
      }
    };
    const onDisconnect = () => {
      if (wallet.kind === "walletconnect") {
        setAddress(undefined);
        setChainId(undefined);
        setBalanceWei(undefined);
        setActive(undefined);
        return;
      }
      setError("Wallet sent a disconnect event (often lock/sleep). Unlock and click Connect if the address is blank. Tracking was not cleared.");
    };
    provider.on?.("accountsChanged", onAccounts);
    provider.on?.("chainChanged", onChain);
    provider.on?.("disconnect", onDisconnect);
    return () => {
      provider.removeListener?.("accountsChanged", onAccounts);
      provider.removeListener?.("chainChanged", onChain);
      provider.removeListener?.("disconnect", onDisconnect);
    };
  }, [refreshBalance]);

  useEffect(() => {
    const found = discoverEip6963Wallets();
    setWallets(found);
    const onAnnounce = (event: Event) => {
      const detail = (event as CustomEvent).detail as {
        info?: { uuid?: string; name?: string; icon?: string; rdns?: string };
        provider?: Eip1193Provider;
      };
      const uuid = detail.info?.uuid;
      const provider = detail.provider;
      if (!uuid || !provider) return;
      setWallets((current) => {
        if (current.some((item) => item.id === uuid)) return current;
        return [
          ...current,
          {
            id: uuid,
            name: detail.info?.name ?? "Injected wallet",
            icon: detail.info?.icon,
            rdns: detail.info?.rdns,
            kind: "injected",
            provider,
          },
        ];
      });
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    return () => window.removeEventListener("eip6963:announceProvider", onAnnounce);
  }, []);

  useEffect(() => {
    if (!active) return;
    return attachListeners(active);
  }, [active, attachListeners]);

  useEffect(() => {
    if (address || connecting || active) return;
    let savedId: string | null = null;
    try {
      savedId = sessionStorage.getItem(WALLET_SESSION_KEY);
    } catch {
      return;
    }
    if (!savedId) return;
    const wallet = wallets.find((item) => item.id === savedId);
    if (!wallet) return;
    void (async () => {
      try {
        const accounts = await readAccounts(wallet.provider);
        if (!accounts[0]) return;
        const nextChain = await readChainId(wallet.provider);
        setActive(wallet);
        setAddress(accounts[0]);
        setChainId(nextChain);
        await refreshBalance(accounts[0]);
      } catch {
        // Silent restore only; user can click Connect.
      }
    })();
  }, [wallets, address, connecting, active, refreshBalance]);

  const finishConnect = useCallback(
    async (wallet: DiscoveredWallet) => {
      const accounts = await requestAccounts(wallet.provider);
      if (!accounts[0]) throw new Error("Wallet returned no account");
      const nextChain = await readChainId(wallet.provider);
      setActive(wallet);
      setAddress(accounts[0]);
      setChainId(nextChain);
      setError(undefined);
      try {
        sessionStorage.setItem(WALLET_SESSION_KEY, wallet.id);
      } catch {
        // sessionStorage may be blocked; connection still works.
      }
      await refreshBalance(accounts[0]);
    },
    [refreshBalance],
  );

  const connectInjected = useCallback(
    async (wallet: DiscoveredWallet) => {
      setConnecting(true);
      setError(undefined);
      try {
        await finishConnect(wallet);
      } catch (err) {
        setError(isUserRejection(err) ? "Wallet rejected the connection request." : formatError(err));
        throw err;
      } finally {
        setConnecting(false);
      }
    },
    [finishConnect],
  );

  const connectWalletConnect = useCallback(async () => {
    const projectId = walletConnectProjectId();
    if (!projectId) {
      setError("WalletConnect is hidden until VITE_WALLETCONNECT_PROJECT_ID is set.");
      return;
    }
    setConnecting(true);
    setError(undefined);
    try {
      const { EthereumProvider } = await import("@walletconnect/ethereum-provider");
      const provider = await EthereumProvider.init(walletConnectInitOptions(projectId, window.location.origin));
      await provider.connect();
      wcRef.current = provider as unknown as Eip1193Provider;
      const wallet: DiscoveredWallet = {
        id: "walletconnect",
        name: "WalletConnect",
        kind: "walletconnect",
        provider: provider as unknown as Eip1193Provider,
      };
      await finishConnect(wallet);
    } catch (err) {
      setError(isUserRejection(err) ? "WalletConnect request was rejected." : formatError(err));
      throw err;
    } finally {
      setConnecting(false);
    }
  }, [finishConnect]);

  const disconnect = useCallback(async () => {
    try {
      await wcRef.current?.disconnect?.();
      await activeRef.current?.provider.disconnect?.();
    } catch {
      // Wallet disconnect is best-effort; never export keys.
    }
    wcRef.current = undefined;
    setActive(undefined);
    setAddress(undefined);
    setChainId(undefined);
    setBalanceWei(undefined);
    setError(undefined);
    try {
      sessionStorage.removeItem(WALLET_SESSION_KEY);
    } catch {
      // ignore
    }
  }, []);

  const verifyBeforeWrite = useCallback(async () => {
    const provider = activeRef.current?.provider;
    if (!provider) throw new Error("Connect a wallet before signing.");
    try {
      const identity = await readWalletIdentity(provider);
      setAddress(identity.address);
      setChainId(identity.chainId);
      setError(undefined);
      return identity;
    } catch {
      const accounts = await requestAccounts(provider);
      if (!accounts[0]) throw new Error("Selected wallet has no account. Unlock it, then retry.");
      const chainId = await readChainId(provider);
      setAddress(accounts[0]);
      setChainId(chainId);
      setError(undefined);
      return { address: accounts[0], chainId };
    }
  }, []);

  const switchToStudioDev = useCallback(async () => {
    const provider = activeRef.current?.provider;
    if (!provider) {
      setError("Connect a wallet before switching network.");
      return;
    }
    try {
      await switchOrAddStudioDev(provider);
      const nextChain = await readChainId(provider);
      setChainId(nextChain);
      setError(undefined);
      const accounts = await readAccounts(provider);
      if (accounts[0]) await refreshBalance(accounts[0]);
    } catch (err) {
      setError(isUserRejection(err) ? "Wallet rejected the Studio-dev network switch." : formatError(err));
    }
  }, [refreshBalance]);

  const value = useMemo<WalletContextValue>(
    () => ({
      wallets,
      walletConnectEnabled,
      connecting,
      connected: Boolean(address || active),
      address,
      chainId,
      balanceWei,
      balanceError,
      walletName: active?.name,
      walletKind: active?.kind,
      error,
      onStudioDev: chainId === STUDIO_DEV_CHAIN_ID,
      connectInjected,
      connectWalletConnect,
      disconnect,
      switchToStudioDev,
      refreshBalance: () => refreshBalance(),
      verifyBeforeWrite,
      provider: active?.provider,
    }),
    [
      wallets,
      walletConnectEnabled,
      connecting,
      address,
      chainId,
      balanceWei,
      balanceError,
      active,
      error,
      connectInjected,
      connectWalletConnect,
      disconnect,
      switchToStudioDev,
      refreshBalance,
      verifyBeforeWrite,
    ],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet() {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used within WalletProvider");
  return ctx;
}
