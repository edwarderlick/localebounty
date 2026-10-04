/** Phase B1 uses the existing Studio-dev product contract. Separate persist from Phase A. */

export const PRODUCT_B1_STORAGE_KEY = "localebounty.live-product-b1.v1";
export const B1_CONTRACT_ADDRESS = "0x84dA80726e8A0c6d451Ca3FF88d7dD47F3b07D96";

export type B1ActionName = "create" | "submit" | "evaluate" | "recover";

export const B1_SOURCE_TEXT = "Your order is on the way.";
export const B1_SOURCE_LOCALE = "en";
export const B1_TARGET_LOCALE = "es";
export const B1_STRING_KEY = "checkout.delivery.on_the_way";
export const B1_APP_CONTEXT = "Checkout delivery status line shown after payment.";
export const B1_INTENDED_MEANING = "The customer's paid order has already left and is in transit to them.";
export const B1_SEMANTIC_CRITERIA =
  "La frase en español debe decir que el pedido ya va en camino, no que se enviará más tarde. Conserve la misma promesa. No añada precios, números de seguimiento ni marketing.";

export const STATE_OPEN = "open";
export const STATE_SUBMITTED = "submitted";
export const STATE_APPROVED = "approved";
export const STATE_REJECTED = "rejected";
export const STATE_TIMED_OUT = "timed_out";
export const DECISION_NONE = "none";
export const KIND_PAYOUT = "payout";
export const KIND_REFUND = "refund";
