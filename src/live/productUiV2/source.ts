import { addressesEqual } from "../format";
import { PRODUCT_V2_SOURCE } from "../genlayer";
import { compareLocalToDeployed } from "../product/source";
import { sha256Utf8 } from "../product/taskId";
import { rpcGetContractCode } from "../rpc";
import { PRODUCT_UI_V2_CONTRACT, PRODUCT_UI_V2_SOURCE_SHA256 } from "./constants";
import { loadProductUiV2Session, saveProductUiV2Session, type ProductUiV2Session } from "./persist";

export type V2SourceFields = {
  sourceMatch: boolean;
  sourceVerifyStatus: ProductUiV2Session["sourceVerifyStatus"];
  sourceVerifyReason: string;
  localSourceSha256?: string;
  deployedSourceSha256?: string | null;
  sourceVerifiedAddress?: string;
  sourceVerifiedLocalSha256?: string;
  sourceRecheckedThisLoad?: boolean;
};

export const V2_SOURCE_RECHECK_PENDING_REASON =
  "Rechecking gen_getContractCode against the pinned V2 source this load. Estimate and Sign stay disabled until that check matches. Resume tracking stays available for a stored hash.";

export function pendingV2SourceFields(session?: Pick<ProductUiV2Session, "localSourceSha256">): V2SourceFields {
  return {
    sourceMatch: false,
    sourceVerifyStatus: "idle",
    sourceVerifyReason: V2_SOURCE_RECHECK_PENDING_REASON,
    localSourceSha256: session?.localSourceSha256,
    deployedSourceSha256: undefined,
    sourceVerifiedAddress: undefined,
    sourceVerifiedLocalSha256: undefined,
    sourceRecheckedThisLoad: false,
  };
}

/** Overlay only source-verification fields. Create identity and tracking stay on `session`. */
export function applyV2SourceFields(session: ProductUiV2Session, fields: V2SourceFields): ProductUiV2Session {
  return {
    ...session,
    sourceMatch: fields.sourceMatch,
    sourceVerifyStatus: fields.sourceVerifyStatus,
    sourceVerifyReason: fields.sourceVerifyReason,
    localSourceSha256: fields.localSourceSha256 ?? session.localSourceSha256,
    deployedSourceSha256: fields.deployedSourceSha256,
    sourceVerifiedAddress: fields.sourceVerifiedAddress,
    sourceVerifiedLocalSha256: fields.sourceVerifiedLocalSha256,
    sourceRecheckedThisLoad: fields.sourceRecheckedThisLoad ?? false,
  };
}

export function v2SourceFields(session: ProductUiV2Session): V2SourceFields {
  const { sourceMatch, sourceVerifyStatus, sourceVerifyReason, localSourceSha256, deployedSourceSha256,
    sourceVerifiedAddress, sourceVerifiedLocalSha256, sourceRecheckedThisLoad } = session;
  return { sourceMatch, sourceVerifyStatus, sourceVerifyReason, localSourceSha256, deployedSourceSha256,
    sourceVerifiedAddress, sourceVerifiedLocalSha256, sourceRecheckedThisLoad };
}

export function beginV2SourceRecheck(session: ProductUiV2Session): ProductUiV2Session {
  return applyV2SourceFields(session, pendingV2SourceFields(session));
}

export function persistV2SourceFields(fields: V2SourceFields): ProductUiV2Session {
  const next = applyV2SourceFields(loadProductUiV2Session(), fields);
  saveProductUiV2Session(next);
  return next;
}

export function sourceAllowsV2ProductCreate(
  session: ProductUiV2Session,
  currentLocalSha256?: string,
): { ok: true } | { ok: false; reason: string } {
  if (!session.sourceRecheckedThisLoad) {
    return { ok: false, reason: V2_SOURCE_RECHECK_PENDING_REASON };
  }
  const hash = (currentLocalSha256 ?? session.localSourceSha256 ?? "").toLowerCase();
  if (hash !== PRODUCT_UI_V2_SOURCE_SHA256) {
    return {
      ok: false,
      reason: `Local localebounty_v2.py SHA-256 is ${hash || "missing"}; pin is ${PRODUCT_UI_V2_SOURCE_SHA256}. Create stays disabled.`,
    };
  }
  if (!session.sourceMatch || session.sourceVerifyStatus !== "match") {
    return { ok: false, reason: session.sourceVerifyReason || "V2 source is not bound to the deployed contract." };
  }
  if (!session.sourceVerifiedAddress || !addressesEqual(session.sourceVerifiedAddress, PRODUCT_UI_V2_CONTRACT)) {
    return { ok: false, reason: `Source match is not bound to ${PRODUCT_UI_V2_CONTRACT}.` };
  }
  if (session.sourceVerifiedLocalSha256?.toLowerCase() !== PRODUCT_UI_V2_SOURCE_SHA256) {
    return { ok: false, reason: "Source match is not bound to the pinned localebounty_v2.py SHA-256." };
  }
  if (session.deployedSourceSha256?.toLowerCase() !== PRODUCT_UI_V2_SOURCE_SHA256) {
    return { ok: false, reason: "Deployed gen_getContractCode SHA-256 does not match the V2 pin." };
  }
  return { ok: true };
}

export async function checkV2ProductSource(input?: {
  getContractCode?: (address: string) => Promise<unknown>;
  localSource?: string;
}): Promise<V2SourceFields> {
  const localSource = input?.localSource ?? PRODUCT_V2_SOURCE;
  const localSha256 = await sha256Utf8(localSource);
  const pinOk = localSha256.toLowerCase() === PRODUCT_UI_V2_SOURCE_SHA256;
  const getCode = input?.getContractCode ?? rpcGetContractCode;
  try {
    const raw = await getCode(PRODUCT_UI_V2_CONTRACT);
    const compared = await compareLocalToDeployed(localSource, raw);
    const deployed = compared.deployedSha256?.toLowerCase() ?? null;
    const match = pinOk && compared.match && deployed === PRODUCT_UI_V2_SOURCE_SHA256;
    return {
      localSourceSha256: localSha256,
      deployedSourceSha256: compared.deployedSha256,
      sourceMatch: match,
      sourceVerifyStatus: match ? "match" : compared.status === "UNPROVEN" ? "UNPROVEN" : "mismatch",
      sourceVerifyReason: match
        ? `Deployed ${PRODUCT_UI_V2_CONTRACT} matches localebounty_v2.py SHA-256 ${PRODUCT_UI_V2_SOURCE_SHA256}.`
        : pinOk
          ? compared.reason
          : `Working tree localebounty_v2.py hashes to ${localSha256}, not the C3 pin ${PRODUCT_UI_V2_SOURCE_SHA256}.`,
      sourceVerifiedAddress: match ? PRODUCT_UI_V2_CONTRACT : undefined,
      sourceVerifiedLocalSha256: match ? localSha256 : undefined,
      sourceRecheckedThisLoad: true,
    };
  } catch (err) {
    return {
      localSourceSha256: localSha256,
      deployedSourceSha256: null,
      sourceMatch: false,
      sourceVerifyStatus: "UNPROVEN",
      sourceVerifyReason: `Source match is UNPROVEN: ${err instanceof Error ? err.message : String(err)} Create stays disabled until gen_getContractCode matches ${PRODUCT_UI_V2_SOURCE_SHA256}.`,
      sourceVerifiedAddress: undefined,
      sourceVerifiedLocalSha256: undefined,
      sourceRecheckedThisLoad: true,
    };
  }
}

/** Hash-check deployed code, then merge only source fields into the latest stored session. */
export async function verifyV2ProductSource(
  _session?: ProductUiV2Session,
  deps?: { getContractCode?: (address: string) => Promise<unknown>; localSource?: string },
): Promise<ProductUiV2Session> {
  const fields = await checkV2ProductSource(deps);
  return { ...persistV2SourceFields(fields), sourceRecheckedThisLoad: true };
}
