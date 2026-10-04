import { Icon } from "./Icon";

export function LanguagePair({ from, to }: { from: string; to: string }) {
  return (
    <div className="flex items-center gap-1 px-space-sm py-0.5 bg-surface-container-high font-label-sm text-label-sm rounded text-primary font-bold">
      <span>{from}</span>
      <Icon name="arrow_forward" className="text-xs" />
      <span>{to}</span>
    </div>
  );
}
