/** Studio-dev only. Do not use studionet (61999) or relabel its SDK preset. */

export const STUDIO_DEV_CHAIN_ID = 61997;
export const STUDIO_DEV_CHAIN_ID_HEX = `0x${STUDIO_DEV_CHAIN_ID.toString(16)}`;
export const STUDIO_DEV_RPC = "https://studio-dev.genlayer.com/api";
export const STUDIO_DEV_NAME = "GenLayer Studio Devnet";
export const STUDIO_DEV_EXPLORER = "https://explorer-studio-dev.genlayer.com";
export const STUDIO_DEV_STUDIO = "https://studio-dev.genlayer.com";
export const STUDIO_DEV_FAUCET = "https://studio-dev.genlayer.com";

export const LOCK_WEI = 10n ** 15n; // 0.001 GEN
export const LOCK_GEN_LABEL = "0.001 GEN";

export const EXTERNAL_WAIT_MS = 90_000;
export const EXTERNAL_POLL_MS = 3_000;
export const RECEIPT_INTERVAL_MS = 3_000;
export const RECEIPT_RETRIES = 80;
export const TRACK_POLL_MS = 1_000;
export const QUOTE_TIMEOUT_MS = 20_000;

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export const STUDIO_DEV_WALLET_CHAIN = {
  chainId: STUDIO_DEV_CHAIN_ID_HEX,
  chainName: STUDIO_DEV_NAME,
  nativeCurrency: { name: "GEN Token", symbol: "GEN", decimals: 18 },
  rpcUrls: [STUDIO_DEV_RPC],
  blockExplorerUrls: [STUDIO_DEV_EXPLORER],
} as const;

/**
 * Time-unit / appeal shape only. Do **not** pin executionBudgetPerRound:
 * Studio-dev's messageFeeParamsBudgetFloor is ~7.65e13 wei. The old 786_500
 * pin produced ~4e6 wei quotes and on-chain BudgetTooLow.
 */
export function deployFeeHint() {
  return {
    leaderTimeunitsAllocation: 125n,
    validatorTimeunitsAllocation: 250n,
    appealRounds: 1n,
    rotations: [1n, 1n],
  };
}
