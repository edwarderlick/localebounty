import { Link } from "react-router-dom";
import { formatActor } from "../lib/addresses";
import { demoHref } from "../lib/paths";
import { accentBar } from "../lib/status";
import type { Task } from "../types";
import { Icon } from "./Icon";
import { LanguagePair } from "./LanguagePair";
import { StatusPill } from "./StatusPill";

function cta(task: Task): { to: string; label: string; icon: string } {
  if (task.status === "submitted") {
    return { to: demoHref(`/tasks/${task.id}/decision`), label: "View decision", icon: "query_stats" };
  }
  if (task.status === "approved") {
    return { to: demoHref("/library"), label: "View in library", icon: "dataset" };
  }
  if (task.status === "open" || task.status === "in_translation") {
    return { to: demoHref(`/tasks/${task.id}`), label: "View task detail", icon: "arrow_forward" };
  }
  return { to: demoHref(`/tasks/${task.id}/decision`), label: "View result", icon: "gavel" };
}

export function TaskCard({ task }: { task: Task }) {
  const action = cta(task);
  return (
    <article className="group relative flex flex-col justify-between bg-surface-container-lowest rounded shadow-[4px_4px_0px_#00170b] hover:shadow-[6px_6px_0px_#00170b] hover:-translate-y-0.5 transition-all overflow-hidden">
      <div className={`h-2 w-full ${accentBar(task.accent)}`} />
      <div className="p-space-lg flex flex-col gap-space-md">
        <div className="flex items-center justify-between gap-space-sm">
          <StatusPill status={task.status} />
          <LanguagePair from={task.sourceLanguage} to={task.targetLanguage} />
        </div>
        <div className="flex items-baseline justify-between bg-surface-container-low p-space-sm rounded">
          <span className="font-label-sm text-label-sm uppercase text-on-surface-variant tracking-wider">
            Intended reward (demo)
          </span>
          <div className="flex items-center gap-1">
            <Icon name="token" className="text-secondary-container text-base" />
            <span className="font-headline-sm text-headline-sm font-bold text-primary">{task.intendedRewardGen} GEN</span>
          </div>
        </div>
        <div className="flex flex-col gap-space-xs">
          <span className="font-label-sm text-label-sm uppercase text-on-surface-variant tracking-wider">
            Source string
          </span>
          <blockquote className="font-title-lg text-title-lg text-primary p-space-sm rounded-none border-l-4 border-l-secondary-container italic">
            “{task.sourceText}”
          </blockquote>
        </div>
        {task.status === "approved" && task.submission ? (
          <div className="flex flex-col gap-1 bg-primary-fixed/30 p-space-sm rounded text-body-sm">
            <span className="font-label-sm text-label-sm uppercase text-primary font-bold">Approved demo string</span>
            <span className="font-title-md text-title-md">{task.submission.text}</span>
          </div>
        ) : (
          <div className="flex flex-col gap-1 bg-surface-container-high/60 p-space-sm rounded text-body-sm text-on-surface">
            <span className="font-label-sm text-label-sm uppercase text-on-surface-variant font-bold">Requirement</span>
            <span>{task.requirements[0] ?? "See task detail"}</span>
          </div>
        )}
        <div className="flex items-center justify-between text-body-sm pt-space-xs">
          <span className="text-on-surface-variant font-label-sm text-label-sm uppercase">Named translator</span>
          <span className="font-bold text-primary">{formatActor(task.translatorAddress, task.translatorLabel)}</span>
        </div>
      </div>
      <div className="p-space-md bg-surface-container flex items-center justify-between">
        <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">
          {task.id}
        </span>
        <Link
          to={action.to}
          className="inline-flex items-center gap-1 font-label-md text-label-md uppercase font-bold text-secondary-container hover:text-primary transition-colors"
        >
          <span>{action.label}</span>
          <Icon name={action.icon} className="text-sm" />
        </Link>
      </div>
    </article>
  );
}
