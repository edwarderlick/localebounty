/** Isolated V2 public product UI. Six V1 routes stay on PRODUCT_UI_CONTRACT. */

export const PRODUCT_UI_V2_CONTRACT = "0x3B06e08182Db177a61B1707f7b5A84834A45F431";
export const PRODUCT_UI_V2_SOURCE_SHA256 = "3cbb7ff08dca3909b9765ce0467e7ddc8c6ec0d7c104e142c892cfafd169a43d";
export const PRODUCT_UI_V2_STORAGE_KEY = "localebounty.product-ui-v2.create.v1";
export const PRODUCT_UI_V2_WRITES_STORAGE_KEY = "localebounty.product-ui-v2.writes.v1";

export const LIST_PAGE_LIMIT = 50;
export const MAX_TEXT = 4096;

export const STATE_OPEN = "open";
export const STATE_ACCEPTED = "accepted";
export const STATE_SUBMITTED = "submitted";
export const STATE_APPROVED = "approved";
export const STATE_REJECTED = "rejected";
export const STATE_TIMED_OUT = "timed_out";
export const STATE_CANCELLED = "cancelled";
export const STATE_EXPIRED = "expired";
export const DECISION_NONE = "none";
export const KIND_PAYOUT = "payout";
export const KIND_REFUND = "refund";
