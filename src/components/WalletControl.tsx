import { Icon } from "./Icon";
import { walletConnectProjectId } from "../live/eip1193";
import { formatGen } from "../live/format";
import { useWallet } from "../live/WalletContext";
import { shortenAddress } from "../lib/addresses";

export function WalletControl() {
  const wallet = useWallet();
  const wcId = walletConnectProjectId();

  if (wallet.connected) {
    return (
      <div className="flex items-center gap-space-sm bg-surface-container px-space-md py-space-xs rounded">
        <div className="flex flex-col text-right min-w-0">
          <span className="font-label-sm text-label-sm text-on-surface-variant font-bold leading-none">
            {wallet.address ? shortenAddress(wallet.address) : "Unlock wallet"}
          </span>
          <span className="font-body-sm text-body-sm font-bold text-secondary leading-tight truncate">
            {wallet.onStudioDev ? "Studio-dev 61997" : `Chain ${wallet.chainId ?? "unknown"}`}
            {wallet.balanceWei != null ? ` · ${formatGen(wallet.balanceWei)}` : ""}
          </span>
        </div>
        <div className="h-6 w-px bg-outline-variant" />
        {wallet.connected && !wallet.onStudioDev ? (
          <button
            type="button"
            onClick={() => void wallet.switchToStudioDev()}
            className="px-space-xs py-0.5 font-label-sm text-label-sm uppercase rounded bg-secondary-container text-on-secondary-container"
          >
            Switch
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => void wallet.disconnect()}
          className="px-space-xs py-0.5 font-label-sm text-label-sm uppercase rounded text-on-surface-variant hover:text-primary"
        >
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-space-xs">
      {wallet.wallets.map((item) => (
        <button
          key={item.id}
          type="button"
          disabled={wallet.connecting}
          onClick={() => void wallet.connectInjected(item)}
          className="inline-flex items-center gap-space-xs bg-primary-container text-on-primary font-label-sm text-label-sm uppercase px-space-sm py-space-xs rounded shadow-[2px_2px_0px_#00170b]"
        >
          {item.icon ? <img src={item.icon} alt="" className="h-4 w-4" /> : <Icon name="account_balance_wallet" />}
          {wallet.connecting ? "Connecting…" : item.name}
        </button>
      ))}
      {wallet.walletConnectEnabled ? (
        <button
          type="button"
          disabled={wallet.connecting}
          onClick={() => void wallet.connectWalletConnect()}
          className="inline-flex items-center gap-space-xs bg-surface-container-high font-label-sm text-label-sm uppercase px-space-sm py-space-xs rounded"
        >
          WalletConnect
        </button>
      ) : wcId ? null : (
        <span className="hidden lg:inline font-label-sm text-label-sm text-on-surface-variant">Connect a wallet</span>
      )}
    </div>
  );
}
