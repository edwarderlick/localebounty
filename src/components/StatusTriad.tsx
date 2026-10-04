import type { Task } from "../types";
import { executionLabel } from "../lib/status";

function Cell({ title, kicker, value, hint }: { title: string; kicker: string; value: string; hint: string }) {
  return (
    <div className="bg-surface-container-lowest p-space-md rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-xs">
      <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">{kicker}</span>
      <h3 className="font-title-lg text-title-lg text-primary uppercase">{title}</h3>
      <p className="font-headline-sm text-headline-sm text-primary">{value}</p>
      <p className="font-body-sm text-body-sm text-on-surface-variant">{hint}</p>
    </div>
  );
}

export function StatusTriad({ task }: { task: Task }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-space-md">
      <Cell
        kicker="Field 01"
        title="Transaction status"
        value="Not available in demo"
        hint="No broadcast, hash, or block confirmation exists in this frontend."
      />
      <Cell
        kicker="Field 02"
        title="Execution result"
        value={executionLabel(task)}
        hint="In-app demo state only. Not a live GenLayer receipt."
      />
      <Cell
        kicker="Field 03"
        title="Payment status"
        value="Not available in demo"
        hint="No GEN is locked or paid in demo mode."
      />
    </div>
  );
}
