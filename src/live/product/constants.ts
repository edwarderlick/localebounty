/** Phase A product test constants. Studio-dev only. */

export const PRODUCT_STORAGE_KEY = "localebounty.live-product.v1";

export type ProductActionName = "deploy" | "create" | "cancel";

export const MIN_REVIEW_SECONDS = 3600;
export const CREATE_SUBMIT_LEAD_SECONDS = 1800;
export const DEADLINE_STALE_SECONDS = 60;
/** Must match contracts/localebounty.py MAX_RECOVERY_SECONDS. */
export const MAX_RECOVERY_SECONDS = 30 * 24 * 60 * 60;

/** Historical probe payout-write actual fee. 1 GEN = 10^18 wei. Never treat as the current quote. */
export const HISTORICAL_PROBE_PAYOUT_FEE_NOTE =
  "An earlier experimental probe payout write on Studio-dev consumed 0.000126304500000823 GEN (126304500000823 wei) in actual protocol fee. That is not 0.126 GEN. The fee quote is a deposit required upfront; unused deposit is returned. Obtain a fresh quote before every signature.";

export const TEST_SOURCE_TEXT = "Phase A live product test.";
export const TEST_SOURCE_LOCALE = "en";
export const TEST_TARGET_LOCALE = "es";
export const TEST_STRING_KEY = "phase_a.test";
export const TEST_APP_CONTEXT = "Live Product Test Phase A";
export const TEST_INTENDED_MEANING = "Confirm create then cancel refund.";
export const TEST_SEMANTIC_CRITERIA = "Meaning preserved; short string.";

export const STATE_OPEN = "open";
export const STATE_CANCELLED = "cancelled";
export const DECISION_NONE = "none";
export const PAYMENT_NONE = "none";
export const KIND_REFUND = "refund";
