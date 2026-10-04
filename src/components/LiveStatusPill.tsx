import { liveStatusLabel, liveStatusPillClass, liveTaskState } from "../live/productUi/status";

export function LiveStatusPill({ state }: { state: string }) {
  const normalized = liveTaskState(state);
  return (
    <div className={`inline-flex items-center gap-1.5 px-space-sm py-1 font-label-sm text-label-sm uppercase font-bold rounded ${liveStatusPillClass(normalized)}`}>
      <span className="w-2 h-2 rounded-full bg-current opacity-70" />
      {liveStatusLabel(normalized)}
    </div>
  );
}
