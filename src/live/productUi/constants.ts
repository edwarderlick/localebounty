/** Live product UI slice. Studio-dev only. Separate persist from demoStore and Phase A/B1/B2/timeout harnesses. */

export const PRODUCT_UI_CONTRACT = "0x84dA80726e8A0c6d451Ca3FF88d7dD47F3b07D96";
export const PRODUCT_UI_SOURCE_SHA256 = "6db9fb8027453d0f82d24c978b90c0c3dd81ab9674ab8590766d6beeeb28c93f";
export const PRODUCT_UI_STORAGE_KEY = "localebounty.product-ui.create.v1";
/** Submit/evaluate/cancel/recover tracking. Isolated from create.v1 and harness keys. */
export const PRODUCT_UI_WRITES_STORAGE_KEY = "localebounty.product-ui.writes.v1";

/** Must match contracts/localebounty.py MAX_PAGE. */
export const LIST_PAGE_LIMIT = 50;
export const MAX_TEXT = 4096;
export const MAX_KEY = 128;
export const MAX_LOCALE = 32;
export const MAX_NONCE = 128;

export const DEFAULT_SOURCE_LOCALE = "EN-US";

export const STATE_OPEN = "open";
export const STATE_SUBMITTED = "submitted";
export const STATE_APPROVED = "approved";
export const STATE_REJECTED = "rejected";
export const STATE_TIMED_OUT = "timed_out";
export const STATE_CANCELLED = "cancelled";
export const DECISION_NONE = "none";
export const KIND_PAYOUT = "payout";
export const KIND_REFUND = "refund";

export const BALANCE_PROOF_UNAVAILABLE =
  "Payment balance proof is unavailable. This browser has no before-write EOA snapshot for this contract/task/wallet.";
export const FEE_PAYER_PROOF_UNAVAILABLE =
  "Fee-payer balance proof is UNPROVEN. This browser has no evaluator EOA snapshot for this contract/task/wallet.";
