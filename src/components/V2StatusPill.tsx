import { v2StatusLabel, v2StatusPillClass, v2TaskState } from "../live/productUiV2/status";

export function V2StatusPill({ state }: { state: string }) {
  const normalized = v2TaskState(state);
  return (
    <div
      className={`inline-flex items-center gap-1.5 px-space-sm py-1 font-label-sm text-label-sm uppercase font-bold rounded ${v2StatusPillClass(normalized)}`}
    >
      <span className="w-2 h-2 rounded-full bg-current opacity-70" />
      {v2StatusLabel(normalized)}
    </div>
  );
}
