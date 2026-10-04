import { Link } from "react-router-dom";
import { formatGen } from "../live/format";
import { paymentDeliveryView } from "../live/productUi/status";
import type { LiveTaskSummary } from "../live/productUi/summary";
import { liveTaskHref } from "../lib/paths";
import { accentBar } from "../lib/status";
import { shortenAddress } from "../lib/addresses";
import { accentFromTaskId } from "../live/productUi/status";
import { Icon } from "./Icon";
import { LanguagePair } from "./LanguagePair";
import { LiveStatusPill } from "./LiveStatusPill";

export function LiveTaskCard({ task }: { task: LiveTaskSummary }) {
  const payment = paymentDeliveryView(task);
  let rewardLabel = "Unreadable reward";
  try {
    rewardLabel = formatGen(BigInt(task.rewardWei));
  } catch {
    rewardLabel = `${task.rewardWei} wei`;
  }
  return (
    <article className="group relative flex flex-col justify-between bg-surface-container-lowest rounded shadow-[4px_4px_0px_#00170b] hover:shadow-[6px_6px_0px_#00170b] hover:-translate-y-0.5 transition-all overflow-hidden">
      <div className={`h-2 w-full ${accentBar(accentFromTaskId(task.task_id))}`} />
      <div className="p-space-lg flex flex-col gap-space-md">
        <div className="flex items-center justify-between gap-space-sm">
          <LiveStatusPill state={task.state} />
          <LanguagePair from={task.source_locale || "?"} to={task.target_locale || "?"} />
        </div>
        <div className="flex items-baseline justify-between bg-surface-container-low p-space-sm rounded">
          <span className="font-label-sm text-label-sm uppercase text-on-surface-variant tracking-wider">
            Attached reward
          </span>
          <div className="flex items-center gap-1">
            <Icon name="token" className="text-secondary-container text-base" />
            <span className="font-headline-sm text-headline-sm font-bold text-primary">{rewardLabel}</span>
          </div>
        </div>
        <div className="flex flex-col gap-space-xs">
          <span className="font-label-sm text-label-sm uppercase text-on-surface-variant tracking-wider">
            String key
          </span>
          <blockquote className="font-title-lg text-title-lg text-primary p-space-sm rounded-none border-l-4 border-l-secondary-container">
            {task.string_key || "—"}
          </blockquote>
        </div>
        <div className="flex flex-col gap-1 bg-surface-container-high/60 p-space-sm rounded text-body-sm text-on-surface">
          <span className="font-label-sm text-label-sm uppercase text-on-surface-variant font-bold">Payment delivery</span>
          <span>{payment.label}</span>
          <span className="text-on-surface-variant">{payment.hint}</span>
        </div>
        <div className="flex items-center justify-between text-body-sm pt-space-xs">
          <span className="text-on-surface-variant font-label-sm text-label-sm uppercase">Named translator</span>
          <span className="font-bold text-primary">{shortenAddress(task.translator)}</span>
        </div>
      </div>
      <div className="p-space-md bg-surface-container flex items-center justify-between gap-space-sm">
        <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant break-all">
          {task.task_id}
        </span>
        <Link
          to={liveTaskHref(task.task_id)}
          className="inline-flex items-center gap-1 font-label-md text-label-md uppercase font-bold text-secondary-container hover:text-primary transition-colors flex-shrink-0"
        >
          <span>View task detail</span>
          <Icon name="arrow_forward" className="text-sm" />
        </Link>
      </div>
    </article>
  );
}
