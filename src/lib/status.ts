import type { Task, TaskStatus } from "../types";

export const STATUS_FILTERS = [
  { id: "all", label: "All" },
  { id: "open", label: "Open" },
  { id: "in_translation", label: "In translation" },
  { id: "submitted", label: "Submitted" },
  { id: "approved", label: "Approved" },
  { id: "rejected", label: "Rejected" },
] as const;

export function statusLabel(status: TaskStatus): string {
  switch (status) {
    case "open":
      return "Open for translator";
    case "in_translation":
      return "In translation";
    case "submitted":
      return "Submitted (demo)";
    case "approved":
      return "Approved (demo)";
    case "rejected":
      return "Rejected (demo)";
  }
}

export function accentBar(accent: Task["accent"]): string {
  switch (accent) {
    case "orange":
      return "bg-secondary-container";
    case "lime":
      return "bg-tertiary-fixed";
    case "cyan":
      return "bg-primary-fixed-dim";
    case "sand":
      return "bg-tertiary-fixed-dim";
    case "pink":
      return "bg-secondary-fixed-dim";
  }
}

export function statusPillClass(status: TaskStatus): string {
  switch (status) {
    case "open":
      return "bg-surface-container-high text-on-surface";
    case "in_translation":
      return "bg-secondary-fixed text-on-secondary-fixed";
    case "submitted":
      return "bg-surface-container-high text-on-surface";
    case "approved":
      return "bg-primary-fixed text-on-primary-fixed";
    case "rejected":
      return "bg-secondary-container text-on-secondary-container";
  }
}

export function executionLabel(task: Task): string {
  if (task.status === "approved") return "DEMO approved — not an onchain result";
  if (task.status === "rejected") return "DEMO rejected — library unchanged";
  if (task.status === "submitted") return "Awaiting demo simulation";
  return "Not started";
}

export function languageShort(code: string): string {
  return code.split("-")[0] ?? code;
}

export function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

export function slugFromText(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 32);
  return slug || "string";
}
