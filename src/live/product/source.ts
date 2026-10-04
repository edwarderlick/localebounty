import { isRecord } from "../eip1193";
import { addressesEqual } from "../format";
import { sha256Utf8 } from "./taskId";

export type SourceVerifyResult = {
  localSha256: string;
  deployedSha256: string | null;
  match: boolean;
  status: "match" | "mismatch" | "UNPROVEN";
  reason: string;
  deployedSourcePreview?: string;
};

function tryDecodeBase64(raw: string): string | undefined {
  try {
    const binary = atob(raw);
    const text = new TextDecoder().decode(Uint8Array.from(binary, (ch) => ch.charCodeAt(0)));
    return text.includes("class ") || text.includes("Depends") ? text : undefined;
  } catch {
    return undefined;
  }
}

function tryDecodeHex(raw: string): string | undefined {
  const hex = raw.startsWith("0x") ? raw.slice(2) : raw;
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) return undefined;
  try {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    const text = new TextDecoder().decode(bytes);
    return text.includes("class ") || text.includes("Depends") ? text : undefined;
  } catch {
    return undefined;
  }
}

/** Pull Python source from gen_getContractCode / similar RPC shapes. Never invent a match. */
export function extractPythonSource(result: unknown): string | undefined {
  if (typeof result === "string") {
    if (!result) return undefined;
    if (result.includes("class LocaleBounty") || result.includes("py-genlayer:") || result.includes("class ExperimentalSettlementProbe")) {
      return result;
    }
    const trimmed = result.trim();
    if (!trimmed) return undefined;
    return tryDecodeBase64(trimmed) ?? tryDecodeHex(trimmed);
  }
  if (Array.isArray(result)) {
    for (const item of result) {
      const found = extractPythonSource(item);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(result)) return undefined;
  for (const key of ["code", "source", "contract_code", "contractCode", "data", "result"]) {
    if (key in result) {
      const found = extractPythonSource(result[key]);
      if (found) return found;
    }
  }
  return undefined;
}

export async function compareLocalToDeployed(localSource: string, rpcResult: unknown): Promise<SourceVerifyResult> {
  const localSha256 = await sha256Utf8(localSource);
  const deployed = extractPythonSource(rpcResult);
  if (!deployed) {
    return {
      localSha256,
      deployedSha256: null,
      match: false,
      status: "UNPROVEN",
      reason:
        "Studio-dev did not return Python source that could be hashed (gen_getContractCode missing, empty, or not LocaleBounty source). Source match is UNPROVEN. Create stays disabled until a match is proven. Nothing was invented.",
    };
  }
  const deployedSha256 = await sha256Utf8(deployed);
  if (deployedSha256 === localSha256) {
    return {
      localSha256,
      deployedSha256,
      match: true,
      status: "match",
      reason: `Deployed source SHA-256 matches local localebounty.py (${localSha256}).`,
      deployedSourcePreview: deployed.slice(0, 80),
    };
  }
  return {
    localSha256,
    deployedSha256,
    match: false,
    status: "mismatch",
    reason: `Deployed source SHA-256 ${deployedSha256} does not match local ${localSha256}. Create stays disabled. Do not treat this instance as the current product contract.`,
    deployedSourcePreview: deployed.slice(0, 80),
  };
}

export function unverifiedSource(localSha256: string, reason: string): SourceVerifyResult {
  return {
    localSha256,
    deployedSha256: null,
    match: false,
    status: "UNPROVEN",
    reason,
  };
}

export type SourceBindingSession = {
  address?: string;
  sourceMatch: boolean;
  sourceVerifyStatus: "idle" | "match" | "mismatch" | "UNPROVEN";
  sourceVerifyReason: string;
  sourceVerifiedAddress?: string;
  sourceVerifiedLocalSha256?: string;
  localSourceSha256?: string;
  deployedSourceSha256?: string | null;
};

export function sourceBindingStillValid(session: SourceBindingSession, currentLocalSha256: string): boolean {
  if (!session.sourceMatch) return false;
  if (!session.address || !session.sourceVerifiedAddress) return false;
  if (!addressesEqual(session.address, session.sourceVerifiedAddress)) return false;
  if (!session.sourceVerifiedLocalSha256 || !currentLocalSha256) return false;
  return session.sourceVerifiedLocalSha256 === currentLocalSha256;
}

/** Drop a persisted source match unless it is bound to this address and the current PRODUCT_SOURCE SHA-256. */
export function invalidateStaleSourceMatch<T extends SourceBindingSession>(session: T, currentLocalSha256: string): T {
  const next = { ...session, localSourceSha256: currentLocalSha256 };
  if (sourceBindingStillValid(session, currentLocalSha256)) return next;
  if (!session.sourceMatch && !session.sourceVerifiedAddress && !session.sourceVerifiedLocalSha256) {
    return next;
  }
  return {
    ...next,
    sourceMatch: false,
    sourceVerifyStatus: "UNPROVEN",
    sourceVerifyReason:
      "Persisted source match is unbound from the current contract address or PRODUCT_SOURCE SHA-256. Recheck gen_getContractCode before create. Create stays disabled.",
    sourceVerifiedAddress: undefined,
    sourceVerifiedLocalSha256: undefined,
  };
}

export function applySourceComparison<T extends SourceBindingSession>(
  session: T,
  compared: SourceVerifyResult,
  address: string,
): T {
  if (compared.match) {
    return {
      ...session,
      localSourceSha256: compared.localSha256,
      deployedSourceSha256: compared.deployedSha256,
      sourceMatch: true,
      sourceVerifyStatus: "match",
      sourceVerifyReason: compared.reason,
      sourceVerifiedAddress: address,
      sourceVerifiedLocalSha256: compared.localSha256,
    };
  }
  return {
    ...session,
    localSourceSha256: compared.localSha256,
    deployedSourceSha256: compared.deployedSha256,
    sourceMatch: false,
    sourceVerifyStatus: compared.status,
    sourceVerifyReason: compared.reason,
    sourceVerifiedAddress: undefined,
    sourceVerifiedLocalSha256: undefined,
  };
}
