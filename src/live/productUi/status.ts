import { PAYOUT_SUBMITTED_IS_NOT_PAYMENT } from "../product/evidence";
import type { Accent } from "../../types";
import type { LiveTaskSummary } from "./summary";

export type LiveTaskState = "open" | "submitted" | "approved" | "rejected" | "cancelled" | "timed_out" | "unknown";

export const LIVE_STATUS_FILTERS = [
  { id: "all", label: "All" },
  { id: "open", label: "Open" },
  { id: "submitted", label: "Submitted" },
  { id: "approved", label: "Approved" },
  { id: "rejected", label: "Rejected" },
  { id: "cancelled", label: "Cancelled" },
  { id: "timed_out", label: "Timed out" },
] as const;

export function liveTaskState(state: string | undefined): LiveTaskState {
  switch (state) {
    case "open":
    case "submitted":
    case "approved":
    case "rejected":
    case "cancelled":
    case "timed_out":
      return state;
    default:
      return "unknown";
  }
}

export function liveStatusLabel(state: LiveTaskState | string): string {
  switch (liveTaskState(state)) {
    case "open":
      return "Open (funder may cancel)";
    case "submitted":
      return "Submitted";
    case "approved":
      return "Approved";
    case "rejected":
      return "Rejected";
    case "cancelled":
      return "Cancelled";
    case "timed_out":
      return "Timed out";
    default:
      return state ? `State: ${state}` : "Unknown state";
  }
}

export function liveStatusPillClass(state: LiveTaskState | string): string {
  switch (liveTaskState(state)) {
    case "open":
      return "bg-surface-container-high text-on-surface";
    case "submitted":
      return "bg-secondary-fixed text-on-secondary-fixed";
    case "approved":
      return "bg-primary-fixed text-on-primary-fixed";
    case "rejected":
      return "bg-secondary-container text-on-secondary-container";
    case "cancelled":
      return "bg-surface-container-high text-on-surface-variant";
    case "timed_out":
      return "bg-tertiary-fixed-dim text-on-surface";
    default:
      return "bg-surface-container-high text-on-surface-variant";
  }
}

export function accentFromTaskId(taskId: string): Accent {
  const accents: Accent[] = ["orange", "lime", "cyan", "sand", "pink"];
  let n = 0;
  for (let i = 0; i < taskId.length; i++) n = (n + taskId.charCodeAt(i)) % accents.length;
  return accents[n] ?? "orange";
}

export type PaymentDeliveryView = {
  label: string;
  hint: string;
  paid: false;
};

/** `payout_submitted` alone must never be shown as paid. */
export function paymentDeliveryView(task: Pick<LiveTaskSummary, "payment_status" | "payment_kind" | "payout_submitted">): PaymentDeliveryView {
  const kind = task.payment_kind || "none";
  if (task.payout_submitted) {
    return {
      label: `payout_submitted (${kind})`,
      hint: `${PAYOUT_SUBMITTED_IS_NOT_PAYMENT} payment_status=${task.payment_status || "none"}.`,
      paid: false,
    };
  }
  if (task.payment_status && task.payment_status !== "none") {
    return {
      label: `payment_status ${task.payment_status}`,
      hint: `payment_kind=${kind}. This is not proven EOA delivery.`,
      paid: false,
    };
  }
  return {
    label: "No payment recorded",
    hint: "Reward is the attached create value. Delivery is a separate field and is unproven here.",
    paid: false,
  };
}

export function formatUnix(unix: number): string {
  if (!unix) return "—";
  const date = new Date(unix * 1000);
  if (Number.isNaN(date.getTime())) return String(unix);
  return `${date.toISOString()} (${unix})`;
}
