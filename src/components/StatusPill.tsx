import type { TaskStatus } from "../types";
import { statusLabel, statusPillClass } from "../lib/status";

export function StatusPill({ status }: { status: TaskStatus }) {
  return (
    <div className={`inline-flex items-center gap-1.5 px-space-sm py-1 font-label-sm text-label-sm uppercase font-bold rounded ${statusPillClass(status)}`}>
      <span className="w-2 h-2 rounded-full bg-current opacity-70" />
      {statusLabel(status)}
    </div>
  );
}
