import { PAYOUT_SUBMITTED_IS_NOT_PAYMENT } from "../product/evidence";
import type { Accent } from "../../types";
import type { V2TaskSummary } from "./summary";

export type V2TaskState =
  | "open"
  | "accepted"
  | "submitted"
  | "approved"
  | "rejected"
  | "cancelled"
  | "timed_out"
  | "expired"
  | "unknown";

export const V2_STATUS_FILTERS = [
  { id: "all", label: "All" },
  { id: "open", label: "Open" },
  { id: "accepted", label: "Accepted" },
  { id: "submitted", label: "Submitted" },
  { id: "approved", label: "Approved" },
  { id: "rejected", label: "Rejected" },
  { id: "cancelled", label: "Cancelled" },
  { id: "expired", label: "Expired" },
  { id: "timed_out", label: "Timed out" },
] as const;

export function v2TaskState(state: string | undefined): V2TaskState {
  switch (state) {
    case "open":
    case "accepted":
    case "submitted":
    case "approved":
    case "rejected":
    case "cancelled":
    case "timed_out":
    case "expired":
      return state;
    default:
      return "unknown";
  }
}

export function v2StatusLabel(state: V2TaskState | string): string {
  switch (v2TaskState(state)) {
    case "open":
      return "Open (unaccepted)";
    case "accepted":
      return "Accepted";
    case "submitted":
      return "Submitted";
    case "approved":
      return "Approved";
    case "rejected":
      return "Rejected";
    case "cancelled":
      return "Cancelled";
    case "expired":
      return "Expired";
    case "timed_out":
      return "Timed out";
    default:
      return state ? `State: ${state}` : "Unknown state";
  }
}

export function v2StatusPillClass(state: V2TaskState | string): string {
  switch (v2TaskState(state)) {
    case "open":
      return "bg-surface-container-high text-on-surface";
    case "accepted":
      return "bg-tertiary-fixed text-on-tertiary-fixed";
    case "submitted":
      return "bg-secondary-fixed text-on-secondary-fixed";
    case "approved":
      return "bg-primary-fixed text-on-primary-fixed";
    case "rejected":
      return "bg-secondary-container text-on-secondary-container";
    case "cancelled":
      return "bg-surface-container-high text-on-surface-variant";
    case "expired":
      return "bg-surface-container-high text-on-surface-variant";
    case "timed_out":
      return "bg-tertiary-fixed-dim text-on-surface";
    default:
      return "bg-surface-container-high text-on-surface-variant";
  }
}

export function isV2TerminalState(state: string | undefined): boolean {
  const s = v2TaskState(state);
  return s === "approved" || s === "rejected" || s === "cancelled" || s === "expired" || s === "timed_out";
}

export function accentFromTaskId(taskId: string): Accent {
  const accents: Accent[] = ["orange", "lime", "cyan", "sand", "pink"];
  let n = 0;
  for (let i = 0; i < taskId.length; i++) n = (n + taskId.charCodeAt(i)) % accents.length;
  return accents[n] ?? "orange";
}

export function paymentDeliveryView(task: Pick<V2TaskSummary, "payment_status" | "payment_kind" | "payout_submitted">): {
  label: string;
  hint: string;
  paid: false;
} {
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
    hint: "Reward is the attached create value. Transfer delivery and payment evidence stay separate.",
    paid: false,
  };
}

export function formatUnix(unix: number): string {
  if (!unix) return "—";
  const date = new Date(unix * 1000);
  if (Number.isNaN(date.getTime())) return String(unix);
  return `${date.toISOString()} (${unix})`;
}
