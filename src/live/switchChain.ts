import type { Eip1193Provider } from "./eip1193";
import { isRecord } from "./eip1193";
import { STUDIO_DEV_CHAIN_ID, STUDIO_DEV_CHAIN_ID_HEX, STUDIO_DEV_WALLET_CHAIN } from "./network";
import { formatError } from "./format";

export async function switchOrAddStudioDev(provider: Eip1193Provider): Promise<void> {
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: STUDIO_DEV_CHAIN_ID_HEX }],
    });
    return;
  } catch (error) {
    const code = isRecord(error) ? error.code : undefined;
    const nested = isRecord(error) && isRecord(error.data) ? error.data.code : undefined;
    if (code !== 4902 && nested !== 4902 && code !== -32603) {
      throw new Error(`Could not switch to Studio-dev (${STUDIO_DEV_CHAIN_ID}): ${formatError(error)}`);
    }
  }

  try {
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [STUDIO_DEV_WALLET_CHAIN],
    });
  } catch (error) {
    throw new Error(`Could not add Studio-dev (${STUDIO_DEV_CHAIN_ID}): ${formatError(error)}`);
  }

  await provider.request({
    method: "wallet_switchEthereumChain",
    params: [{ chainId: STUDIO_DEV_CHAIN_ID_HEX }],
  });
}
