import { Icon } from "../components/Icon";
import { walletConnectProjectId } from "./eip1193";
import { formatGen } from "./format";
import { useWallet } from "./WalletContext";

export function WalletCard() {
  const wallet = useWallet();
  const wcId = walletConnectProjectId();

  return (
    <section className="bg-surface-container-lowest p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-md">
      <div className="flex flex-wrap items-start justify-between gap-space-md">
        <div>
          <p className="font-label-sm text-label-sm uppercase tracking-wider text-secondary">Connected wallet — not a demo role</p>
          <h2 className="font-title-lg text-title-lg text-primary uppercase">Studio-dev account</h2>
        </div>
        {wallet.connected ? (
          <button
            type="button"
            onClick={() => void wallet.disconnect()}
            className="font-label-md text-label-md uppercase px-space-md py-space-xs bg-surface-container-high rounded"
          >
            Disconnect
          </button>
        ) : null}
      </div>

      {wallet.connected ? (
        <dl className="grid grid-cols-1 md:grid-cols-2 gap-space-sm font-body-sm text-body-sm">
          <div>
            <dt className="font-label-sm text-label-sm uppercase text-on-surface-variant">Address</dt>
            <dd className="font-mono break-all">{wallet.address ?? "provider attached — unlock if the address is blank"}</dd>
          </div>
          <div>
            <dt className="font-label-sm text-label-sm uppercase text-on-surface-variant">Network</dt>
            <dd>
              chain {wallet.chainId ?? "unknown"} {wallet.onStudioDev ? "(Studio-dev)" : "(wrong chain)"} · {wallet.walletName}
            </dd>
          </div>
          <div>
            <dt className="font-label-sm text-label-sm uppercase text-on-surface-variant">GEN balance (Studio-dev RPC)</dt>
            <dd>{wallet.balanceWei != null ? formatGen(wallet.balanceWei) : wallet.balanceError ?? "Not read"}</dd>
          </div>
        </dl>
      ) : (
        <p className="font-body-md text-body-md text-on-surface-variant">
          No wallet connected. Choose an injected EIP-6963 wallet
          {wallet.walletConnectEnabled ? " or WalletConnect" : ""}.
        </p>
      )}

      {wallet.error ? <p className="text-error font-body-sm text-body-sm">{wallet.error}</p> : null}

      <div className="flex flex-wrap gap-space-sm">
        {wallet.wallets.map((item) => (
          <button
            key={item.id}
            type="button"
            disabled={wallet.connecting}
            onClick={() => void wallet.connectInjected(item)}
            className={
              wallet.connected
                ? "inline-flex items-center gap-space-xs bg-surface-container-high font-label-md text-label-md uppercase px-space-md py-space-sm rounded"
                : "inline-flex items-center gap-space-xs bg-primary-container text-on-primary font-label-md text-label-md uppercase px-space-md py-space-sm rounded shadow-[2px_2px_0px_#00170b]"
            }
          >
            {item.icon ? <img src={item.icon} alt="" className="h-4 w-4" /> : <Icon name="account_balance_wallet" />}
            {wallet.connecting ? "Connecting…" : wallet.connected ? `Use ${item.name}` : `Connect ${item.name}`}
          </button>
        ))}
        {wallet.walletConnectEnabled ? (
          <button
            type="button"
            disabled={wallet.connecting}
            onClick={() => void wallet.connectWalletConnect()}
            className="inline-flex items-center gap-space-xs bg-surface-container-high font-label-md text-label-md uppercase px-space-md py-space-sm rounded"
          >
            WalletConnect
          </button>
        ) : (
          <p className="font-body-sm text-body-sm text-on-surface-variant">
            WalletConnect is hidden. Set `VITE_WALLETCONNECT_PROJECT_ID` in `.env.local` to a public Reown/WalletConnect
            project ID, then restart Vite. Current value: {wcId ? "set" : "absent"}.
          </p>
        )}
        {wallet.connected && !wallet.onStudioDev ? (
          <button
            type="button"
            onClick={() => void wallet.switchToStudioDev()}
            className="inline-flex items-center gap-space-xs bg-secondary-container text-on-secondary-container font-label-md text-label-md uppercase px-space-md py-space-sm rounded shadow-[2px_2px_0px_#00170b]"
          >
            Switch / add Studio-dev
          </button>
        ) : null}
      </div>
    </section>
  );
}
