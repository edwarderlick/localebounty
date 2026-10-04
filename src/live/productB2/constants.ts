/** Phase B2 uses the existing Studio-dev product contract. Separate persist from Phase A and B1. */

export const PRODUCT_B2_STORAGE_KEY = "localebounty.live-product-b2.v1";
export const B2_CONTRACT_ADDRESS = "0x84dA80726e8A0c6d451Ca3FF88d7dD47F3b07D96";

export type B2ActionName = "create" | "submit" | "evaluate" | "recover";

export const B2_SOURCE_TEXT = "Your order is on the way.";
export const B2_SOURCE_LOCALE = "en";
export const B2_TARGET_LOCALE = "es";
export const B2_STRING_KEY = "phase_b2.checkout.delivery.on_the_way";
export const B2_APP_CONTEXT = "Checkout delivery status line shown after payment. Phase B2 reject-path live test.";
export const B2_INTENDED_MEANING = "The customer's paid order has already left and is in transit to them.";
export const B2_SEMANTIC_CRITERIA =
  "La frase en español debe decir que el pedido ya va en camino, no que se enviará más tarde. Conserve la misma promesa. No añada precios, números de seguimiento ni marketing.";
export const B2_SUGGESTED_TRANSLATION = "Tu pedido aún no ha sido enviado.";

export const STATE_OPEN = "open";
export const STATE_SUBMITTED = "submitted";
export const STATE_APPROVED = "approved";
export const STATE_REJECTED = "rejected";
export const STATE_TIMED_OUT = "timed_out";
export const DECISION_NONE = "none";
export const KIND_PAYOUT = "payout";
export const KIND_REFUND = "refund";
