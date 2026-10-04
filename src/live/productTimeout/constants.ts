/** Phase timeout-recovery uses the existing Studio-dev product contract. Separate persist from A/B1/B2. */

export const PRODUCT_TIMEOUT_STORAGE_KEY = "localebounty.live-product-timeout.v1";
export const TIMEOUT_CONTRACT_ADDRESS = "0x84dA80726e8A0c6d451Ca3FF88d7dD47F3b07D96";

export type TimeoutActionName = "create" | "submit" | "recover";

export const TIMEOUT_SOURCE_TEXT = "Your order is on the way.";
export const TIMEOUT_SOURCE_LOCALE = "en";
export const TIMEOUT_TARGET_LOCALE = "es";
export const TIMEOUT_STRING_KEY = "phase_timeout.checkout.delivery.on_the_way";
export const TIMEOUT_APP_CONTEXT = "Checkout delivery status line shown after payment. Timeout-recovery live test. Do not call evaluate_task.";
export const TIMEOUT_INTENDED_MEANING = "The customer's paid order has already left and is in transit to them.";
export const TIMEOUT_SEMANTIC_CRITERIA =
  "La frase en español debe decir que el pedido ya va en camino, no que se enviará más tarde. Conserve la misma promesa. No añada precios, números de seguimiento ni marketing.";
export const TIMEOUT_SUGGESTED_TRANSLATION = "Tu pedido ya va en camino.";

export const STATE_OPEN = "open";
export const STATE_SUBMITTED = "submitted";
export const STATE_APPROVED = "approved";
export const STATE_REJECTED = "rejected";
export const STATE_TIMED_OUT = "timed_out";
export const DECISION_NONE = "none";
export const KIND_PAYOUT = "payout";
export const KIND_REFUND = "refund";
