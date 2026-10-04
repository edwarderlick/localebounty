import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { TaskCard } from "../components/TaskCard";
import { Icon } from "../components/Icon";
import { useDemo } from "../data/DemoContext";
import { addressesEqual, currentActor } from "../lib/addresses";
import { STATUS_FILTERS } from "../lib/status";
import { LANGUAGES, type TaskStatus } from "../types";

export function TaskBoard() {
  const { tasks, role, state } = useDemo();
  const actor = currentActor(role);
  const [scope, setScope] = useState<"all" | "mine">("all");
  const [status, setStatus] = useState<"all" | TaskStatus>("all");
  const [language, setLanguage] = useState("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"reward" | "recent">("reward");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tasks
      .filter((t) => {
        if (scope === "mine") {
          const mine =
            addressesEqual(t.ownerAddress, actor.address) || addressesEqual(t.translatorAddress, actor.address);
          if (!mine) return false;
        }
        if (status !== "all" && t.status !== status) return false;
        if (language !== "all" && t.targetLanguage !== language) return false;
        if (!q) return true;
        return (
          t.sourceText.toLowerCase().includes(q) ||
          t.id.toLowerCase().includes(q) ||
          t.title.toLowerCase().includes(q) ||
          t.translatorLabel.toLowerCase().includes(q) ||
          t.targetLanguage.toLowerCase().includes(q)
        );
      })
      .slice()
      .sort((a, b) =>
        sort === "reward"
          ? b.intendedRewardGen - a.intendedRewardGen
          : b.updatedAt.localeCompare(a.updatedAt),
      );
  }, [tasks, scope, status, language, query, sort, actor.address]);

  const approvedCount = state.library.length;
  const tab =
    "px-space-md py-space-xs rounded font-label-md text-label-md uppercase tracking-wider transition-all";
  const tabOn = `${tab} bg-primary-container text-on-primary font-bold shadow-[2px_2px_0px_#00170b]`;
  const tabOff = `${tab} text-on-surface-variant hover:text-on-surface`;

  return (
    <div className="flex flex-col w-full">
      <section className="relative w-full bg-primary-container text-inverse-on-surface overflow-hidden px-gutter pt-space-xl pb-space-2xl">
        <div className="absolute top-0 right-0 pointer-events-none opacity-25 select-none hidden lg:flex flex-col items-end">
          <div className="flex">
            <div className="w-12 h-12 bg-tertiary-fixed" />
            <div className="w-12 h-12 bg-secondary-container" />
            <div className="w-12 h-12 bg-transparent" />
          </div>
          <div className="flex">
            <div className="w-12 h-12 bg-transparent" />
            <div className="w-12 h-12 bg-tertiary-fixed" />
            <div className="w-12 h-12 bg-surface-container-highest" />
          </div>
          <div className="flex">
            <div className="w-12 h-12 bg-secondary-container" />
            <div className="w-12 h-12 bg-surface-container-highest" />
            <div className="w-12 h-12 bg-tertiary-fixed" />
          </div>
        </div>
        <div className="max-w-7xl mx-auto flex flex-col gap-space-xl relative z-10">
          <div className="flex flex-wrap items-center gap-space-sm">
            <span className="inline-block px-space-sm py-0.5 bg-tertiary-fixed text-on-tertiary-fixed font-label-sm text-label-sm uppercase tracking-wider rounded rotate-[-2deg] shadow-[2px_2px_0px_#00170b]">
              Demo mode
            </span>
            <span className="inline-block px-space-sm py-0.5 bg-surface-container-high text-on-surface font-label-sm text-label-sm uppercase tracking-wider rounded rotate-[1deg] shadow-[2px_2px_0px_#00170b]">
              No GEN locked or paid
            </span>
            <span className="inline-flex items-center gap-1 px-space-sm py-0.5 bg-secondary-fixed text-on-secondary-fixed font-label-sm text-label-sm uppercase tracking-wider rounded">
              <span className="w-1.5 h-1.5 rounded-full bg-secondary-container" />
              Local sample data
            </span>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-space-xl items-end">
            <div className="lg:col-span-8 flex flex-col gap-space-md">
              <h1 className="font-display-lg text-display-lg-mobile md:text-display-lg font-bold tracking-tight text-inverse-on-surface leading-[1.05]">
                Translation bounties for short app strings —{" "}
                <span className="bg-tertiary-fixed text-on-tertiary-fixed px-space-sm py-0.5 inline-block -rotate-1 rounded shadow-[2px_2px_0px_#00170b]">
                  DEMO
                </span>
              </h1>
              <p className="font-body-lg text-body-lg text-inverse-on-surface/80 max-w-2xl">
                Create a named-translator task, submit a draft, and simulate approval or rejection in the browser.
                This is not a live GenLayer network and does not move GEN.
              </p>
            </div>
            <div className="lg:col-span-4 flex flex-col sm:flex-row lg:flex-col gap-space-sm">
              <Link
                to="/demo/tasks/new"
                className="w-full inline-flex items-center justify-between px-space-lg py-space-md bg-secondary-container text-on-secondary-container font-headline-sm text-headline-sm uppercase rounded shadow-[3px_3px_0px_#00170b] hover:bg-secondary hover:text-on-secondary active:translate-x-0.5 active:translate-y-0.5 transition-all"
              >
                <span>+ Create new task</span>
                <Icon name="arrow_forward" />
              </Link>
              <Link
                to="/demo/library"
                className="w-full inline-flex items-center justify-between px-space-lg py-space-md bg-surface-container text-on-surface font-title-lg text-title-lg rounded shadow-[3px_3px_0px_#00170b] hover:bg-surface-container-highest transition-all"
              >
                <span>Explore string library</span>
                <Icon name="dataset" />
              </Link>
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-space-md pt-space-lg border-t border-primary-fixed-dim/20">
            <Kpi value={String(tasks.length)} label="Demo tasks" />
            <Kpi value={String(approvedCount)} label="Demo library strings" accent="text-tertiary-fixed" />
            <Kpi value={String(tasks.filter((t) => t.status === "submitted").length)} label="Awaiting simulation" accent="text-secondary-fixed" />
            <Kpi value="0 GEN" label="Locked or paid" />
          </div>
        </div>
      </section>

      <section className="w-full bg-surface-container-low px-gutter py-space-lg shadow-sm">
        <div className="max-w-7xl mx-auto flex flex-col gap-space-md">
          <div className="flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-space-md">
            <div className="flex items-center gap-space-xs bg-surface-container-highest p-1 rounded max-w-fit">
              <button type="button" className={scope === "all" ? tabOn : tabOff} onClick={() => setScope("all")}>
                All tasks ({tasks.length})
              </button>
              <button type="button" className={scope === "mine" ? tabOn : tabOff} onClick={() => setScope("mine")}>
                My tasks
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-space-sm">
              {STATUS_FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setStatus(f.id as "all" | TaskStatus)}
                  className={`px-space-sm py-1 rounded font-label-sm text-label-sm uppercase tracking-wider ${
                    status === f.id
                      ? "bg-primary text-on-primary"
                      : "bg-surface-container-high text-on-surface-variant hover:bg-surface-container-highest"
                  }`}
                >
                  {f.label}
                </button>
              ))}
              <div className="relative">
                <select
                  className="appearance-none bg-surface-container-lowest text-on-surface font-label-md text-label-md uppercase tracking-wider px-space-md py-space-xs pr-8 rounded shadow-[1px_1px_0px_#00170b] focus:outline-none cursor-pointer"
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                >
                  <option value="all">All languages (EN → any)</option>
                  {LANGUAGES.map((l) => (
                    <option key={l.code} value={l.code}>
                      EN → {l.label}
                    </option>
                  ))}
                </select>
                <Icon name="expand_more" className="absolute right-2 top-1/2 -translate-y-1/2 text-sm pointer-events-none text-on-surface-variant" />
              </div>
            </div>
          </div>
          <label className="flex items-center gap-space-sm bg-surface-container-lowest px-space-md py-space-sm rounded shadow-[1px_1px_0px_#00170b]">
            <Icon name="search" className="text-on-surface-variant" />
            <input
              className="w-full bg-transparent outline-none font-body-md text-body-md"
              placeholder="Search source, title, id, translator…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
        </div>
      </section>

      <section className="w-full px-gutter py-space-xl bg-surface">
        <div className="max-w-7xl mx-auto flex flex-col gap-space-xl">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-space-sm">
              <span className="w-3 h-3 bg-secondary-container rounded-none" />
              <h2 className="font-headline-sm text-headline-sm uppercase tracking-tight text-primary">Demo bounty feed</h2>
              <span className="font-label-sm text-label-sm bg-surface-container-high px-space-xs py-0.5 rounded text-on-surface-variant font-bold">
                {filtered.length} shown
              </span>
            </div>
            <button
              type="button"
              className="hidden sm:flex items-center gap-space-xs text-on-surface-variant font-body-sm text-body-sm"
              onClick={() => setSort((s) => (s === "reward" ? "recent" : "reward"))}
            >
              <span>Sort by:</span>
              <span className="font-bold text-primary underline">
                {sort === "reward" ? "Highest reward first" : "Most recently updated"}
              </span>
            </button>
          </div>
          {filtered.length === 0 ? (
            <p className="font-body-lg text-body-lg text-on-surface-variant">No demo tasks match these filters.</p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-space-lg items-stretch">
              {filtered.map((task) => (
                <TaskCard key={task.id} task={task} />
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function Kpi({ value, label, accent }: { value: string; label: string; accent?: string }) {
  return (
    <div className="flex flex-col p-space-md bg-surface-container-lowest/5 rounded">
      <span className={`font-display-lg text-display-lg-mobile md:text-headline-lg font-bold leading-none ${accent ?? "text-inverse-on-surface"}`}>
        {value}
      </span>
      <span className="font-label-md text-label-md uppercase tracking-wider text-inverse-on-surface/70 mt-space-xs">
        {label}
      </span>
    </div>
  );
}
