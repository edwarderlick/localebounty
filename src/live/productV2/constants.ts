/** Phase C2 V2 harness. Isolated persist. Public screens stay on V1. */

export const PRODUCT_V2_STORAGE_KEY = "localebounty.live-product-v2.v1";

export type ProductV2ActionName = "deploy" | "createA" | "cancelA" | "createB" | "cancelB" | "acceptB" | "expireB";

export const MIN_REVIEW_SECONDS = 3600;
export const LANE_A_SUBMIT_LEAD_SECONDS = 1800;
/** Default Lane B accept window. 300s is too short for wallet switch + Studio-dev finalization. */
export const LANE_B_SUBMIT_LEAD_SECONDS = 1800;
export const LANE_B_LEAD_MIN_SECONDS = 600;
export const LANE_B_LEAD_MAX_SECONDS = 7200;
export const LANE_B_LEAD_PRESETS: { seconds: number; label: string }[] = [
  { seconds: 600, label: "10 minutes (tight)" },
  { seconds: 900, label: "15 minutes" },
  { seconds: 1800, label: "30 minutes" },
  { seconds: 3600, label: "1 hour" },
  { seconds: 7200, label: "2 hours" },
];
export const DEADLINE_STALE_SECONDS = 60;
export const MAX_RECOVERY_SECONDS = 30 * 24 * 60 * 60;

export function normalizeLaneBLeadSeconds(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(n)) return LANE_B_SUBMIT_LEAD_SECONDS;
  const trunc = Math.trunc(n);
  if (trunc < LANE_B_LEAD_MIN_SECONDS) return LANE_B_LEAD_MIN_SECONDS;
  if (trunc > LANE_B_LEAD_MAX_SECONDS) return LANE_B_LEAD_MAX_SECONDS;
  return trunc;
}

export const V2_SOURCE_FILE = "contracts/localebounty_v2.py";
export const V2_RUNNER = "py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng";

export const TEST_SOURCE_LOCALE = "en";
export const TEST_TARGET_LOCALE = "es";
export const LANE_A_SOURCE_TEXT = "Phase C2 lane A: unaccepted create then funder cancel.";
export const LANE_A_STRING_KEY = "phase_c2.lane_a.cancel";
export const LANE_A_APP_CONTEXT = "Live Product V2 harness lane A. Do not submit a translation.";
export const LANE_A_INTENDED_MEANING = "Lock then cancel while still open and unaccepted.";
export const LANE_A_SEMANTIC_CRITERIA = "Meaning preserved; unused in this cancel lane.";
export const LANE_B_SOURCE_TEXT = "Phase C2 lane B: accept then expire unsubmitted.";
export const LANE_B_STRING_KEY = "phase_c2.lane_b.accept_expire";
export const LANE_B_APP_CONTEXT = "Live Product V2 harness lane B. Translator accepts; nobody submits; expire after deadline.";
export const LANE_B_INTENDED_MEANING = "Translator commits, then unused bounty expires to the funder.";
export const LANE_B_SEMANTIC_CRITERIA = "Meaning preserved; unused because this lane never submits.";

export const STATE_OPEN = "open";
export const STATE_ACCEPTED = "accepted";
export const STATE_CANCELLED = "cancelled";
export const STATE_EXPIRED = "expired";
export const DECISION_NONE = "none";
export const KIND_REFUND = "refund";

export const HISTORICAL_PROBE_PAYOUT_FEE_NOTE =
  "An earlier experimental probe payout write on Studio-dev consumed 0.000126304500000823 GEN (126304500000823 wei) in actual protocol fee. That is not 0.126 GEN. The fee quote is a deposit required upfront; unused deposit is returned. Obtain a fresh quote before every signature.";

export const BROWSER_FEE_QUOTE_NOTE =
  "This page quotes fees through genlayer-js estimateTransactionFees (deploy) and estimateTransactionFeesForWrite (writes). A separate genlayer CLI attempt reported that client.estimateTransactionFees is not a function. Browser fee estimation is available; that CLI gap is not this harness.";
