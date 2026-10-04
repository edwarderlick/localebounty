import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Icon } from "../components/Icon";
import { V2TaskCard } from "../components/V2TaskCard";
import { formatError } from "../live/format";
import { LIST_PAGE_LIMIT, PRODUCT_UI_V2_CONTRACT } from "../live/productUiV2/constants";
import { readV2TaskCount, readV2TaskPage } from "../live/productUiV2/list";
import { V2_STATUS_FILTERS, v2TaskState } from "../live/productUiV2/status";
import { mergeV2TaskSummaries, newestPageWindow, type V2TaskSummary } from "../live/productUiV2/summary";
import { useWallet } from "../live/WalletContext";
import { LANGUAGES } from "../types";
import { belongsToWallet } from "../live/productUi/summary";
import { v2CreateHref } from "../lib/paths";

type LoadState = { status: "loading" } | { status: "error"; message: string } | { status: "ready" };

export function V2TaskBoard() {
  const wallet = useWallet();
  const [scope, setScope] = useState<"all" | "mine">("all");
  const [status, setStatus] = useState<"all" | string>("all");
  const [language, setLanguage] = useState("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"reward" | "recent">("recent");
  const [count, setCount] = useState<number | null>(null);
  const [items, setItems] = useState<V2TaskSummary[]>([]);
  const [pagesFromEnd, setPagesFromEnd] = useState(0);
  const [load, setLoad] = useState<LoadState>({ status: "loading" });

  const refresh = useCallback(async (fromEnd: number, mode: "replace" | "append") => {
    setLoad({ status: "loading" });
    try {
      const total = await readV2TaskCount();
      const window = newestPageWindow(total, LIST_PAGE_LIMIT, fromEnd);
      const pageItems = window.length === 0 ? [] : await readV2TaskPage(window.offset, window.length);
      setCount(total);
      setItems((prev) => (mode === "append" ? mergeV2TaskSummaries(prev, pageItems) : pageItems));
      setLoad({ status: "ready" });
    } catch (err) {
      setLoad({ status: "error", message: formatError(err) });
    }
  }, []);

  useEffect(() => {
    void refresh(0, "replace");
  }, [refresh]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items
      .filter((t) => {
        if (scope === "mine") {
          if (!wallet.address || !belongsToWallet(t, wallet.address)) return false;
        }
        if (status !== "all" && v2TaskState(t.state) !== status) return false;
        if (language !== "all" && t.target_locale !== language) return false;
        if (!q) return true;
        return (
          t.task_id.toLowerCase().includes(q) ||
          t.string_key.toLowerCase().includes(q) ||
          t.translator.toLowerCase().includes(q) ||
          t.funder.toLowerCase().includes(q) ||
          t.target_locale.toLowerCase().includes(q) ||
          t.source_locale.toLowerCase().includes(q)
        );
      })
      .slice()
      .sort((a, b) => {
        if (sort === "reward") {
          try {
            const diff = BigInt(b.rewardWei) - BigInt(a.rewardWei);
            if (diff > 0n) return 1;
            if (diff < 0n) return -1;
            return 0;
          } catch {
            return 0;
          }
        }
        return b.created_at_unix - a.created_at_unix;
      });
  }, [items, scope, status, language, query, sort, wallet.address]);

  const tab = "px-space-md py-space-xs rounded font-label-md text-label-md uppercase tracking-wider transition-all";
  const tabOn = `${tab} bg-primary-container text-on-primary font-bold shadow-[2px_2px_0px_#00170b]`;
  const tabOff = `${tab} text-on-surface-variant hover:text-on-surface`;
  const olderWindow = count != null ? newestPageWindow(count, LIST_PAGE_LIMIT, pagesFromEnd) : null;
  const olderRemaining = olderWindow?.offset ?? 0;

  return (
    <div className="flex flex-col w-full">
      <section className="relative w-full bg-primary-container text-inverse-on-surface overflow-hidden px-gutter pt-space-xl pb-space-2xl">
        <div className="max-w-7xl mx-auto flex flex-col gap-space-xl relative z-10">
          <div className="flex flex-wrap items-center gap-space-sm">
            <span className="inline-block px-space-sm py-0.5 bg-tertiary-fixed text-on-tertiary-fixed font-label-sm text-label-sm uppercase tracking-wider rounded rotate-[-2deg] shadow-[2px_2px_0px_#00170b]">
              Isolated V2
            </span>
            <span className="inline-block px-space-sm py-0.5 bg-surface-container-high text-on-surface font-label-sm text-label-sm uppercase tracking-wider rounded rotate-[1deg] shadow-[2px_2px_0px_#00170b]">
              Chain 61997
            </span>
            <span className="inline-flex items-center gap-1 px-space-sm py-0.5 bg-secondary-fixed text-on-secondary-fixed font-label-sm text-label-sm uppercase tracking-wider rounded">
              <span className="w-1.5 h-1.5 rounded-full bg-secondary-container" />
              Contract {PRODUCT_UI_V2_CONTRACT.slice(0, 6)}…{PRODUCT_UI_V2_CONTRACT.slice(-4)}
            </span>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-space-xl items-end">
            <div className="lg:col-span-8 flex flex-col gap-space-md">
              <h1 className="font-display-lg text-display-lg-mobile md:text-display-lg font-bold tracking-tight text-inverse-on-surface leading-[1.05]">
                V2 translation bounties —{" "}
                <span className="bg-tertiary-fixed text-on-tertiary-fixed px-space-sm py-0.5 inline-block -rotate-1 rounded shadow-[2px_2px_0px_#00170b]">
                  ACCEPT LIFECYCLE
                </span>
              </h1>
              <p className="font-body-lg text-body-lg text-inverse-on-surface/80 max-w-2xl">
                This board reads the deployed LocaleBounty V2 contract via bounded{" "}
                <span className="font-mono">task_count</span> / <span className="font-mono">list_tasks</span>. Open,
                accepted, submitted, and terminal states are shown as stored. Compact rows omit long source text. Public
                V1 history is at <span className="font-mono">/v1</span>.
              </p>
            </div>
            <div className="lg:col-span-4 flex flex-col sm:flex-row lg:flex-col gap-space-sm">
              <Link
                to={v2CreateHref()}
                className="w-full inline-flex items-center justify-between px-space-lg py-space-md bg-secondary-container text-on-secondary-container font-headline-sm text-headline-sm uppercase rounded shadow-[3px_3px_0px_#00170b] hover:bg-secondary hover:text-on-secondary active:translate-x-0.5 active:translate-y-0.5 transition-all"
              >
                <span>+ Create V2 task</span>
                <Icon name="arrow_forward" />
              </Link>
              <Link
                to="/v1"
                className="w-full inline-flex items-center justify-between px-space-lg py-space-md bg-surface-container text-on-surface font-title-lg text-title-lg rounded shadow-[3px_3px_0px_#00170b] hover:bg-surface-container-highest transition-all"
              >
                <span>Open V1 live board</span>
                <Icon name="swap_horiz" />
              </Link>
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-space-md pt-space-lg border-t border-primary-fixed-dim/20">
            <Kpi value={count == null ? "—" : String(count)} label="task_count" />
            <Kpi
              value={load.status === "ready" ? String(items.length) : "—"}
              label={`Loaded unique rows (page max ${LIST_PAGE_LIMIT})`}
              accent="text-tertiary-fixed"
            />
            <Kpi
              value={wallet.address ? "Connected" : "Not connected"}
              label="Wallet for My tasks"
              accent="text-secondary-fixed"
            />
            <Kpi value="Unproven" label="Board does not claim payouts" />
          </div>
        </div>
      </section>

      <section className="w-full bg-surface-container-low px-gutter py-space-lg shadow-sm">
        <div className="max-w-7xl mx-auto flex flex-col gap-space-md">
          <div className="flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-space-md">
            <div className="flex items-center gap-space-xs bg-surface-container-highest p-1 rounded max-w-fit">
              <button type="button" className={scope === "all" ? tabOn : tabOff} onClick={() => setScope("all")}>
                All tasks {count != null ? `(${count})` : ""}
              </button>
              <button type="button" className={scope === "mine" ? tabOn : tabOff} onClick={() => setScope("mine")}>
                My tasks
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-space-sm">
              {V2_STATUS_FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setStatus(f.id)}
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
                  <option value="all">All target locales</option>
                  {LANGUAGES.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.code}
                    </option>
                  ))}
                </select>
                <Icon
                  name="expand_more"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-sm pointer-events-none text-on-surface-variant"
                />
              </div>
            </div>
          </div>
          <label className="flex items-center gap-space-sm bg-surface-container-lowest px-space-md py-space-sm rounded shadow-[1px_1px_0px_#00170b]">
            <Icon name="search" className="text-on-surface-variant" />
            <input
              className="w-full bg-transparent outline-none font-body-md text-body-md"
              placeholder="Search task id, string key, funder, translator…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          {scope === "mine" && !wallet.address ? (
            <p className="font-body-md text-body-md text-on-surface-variant">
              Connect a wallet to filter My tasks by funder or named translator. Demo Owner/Elena is not used here.
            </p>
          ) : null}
        </div>
      </section>

      <section className="w-full px-gutter py-space-xl bg-surface">
        <div className="max-w-7xl mx-auto flex flex-col gap-space-xl">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-space-sm">
              <span className="w-3 h-3 bg-secondary-container rounded-none" />
              <h2 className="font-headline-sm text-headline-sm uppercase tracking-tight text-primary">
                V2 on-chain bounty feed
              </h2>
              <span className="font-label-sm text-label-sm bg-surface-container-high px-space-xs py-0.5 rounded text-on-surface-variant font-bold">
                {load.status === "ready" ? `${filtered.length} shown` : load.status}
              </span>
            </div>
            <button
              type="button"
              className="flex items-center gap-space-xs text-on-surface-variant font-body-sm text-body-sm"
              onClick={() => setSort((s) => (s === "reward" ? "recent" : "reward"))}
            >
              <span>Sort this page by:</span>
              <span className="font-bold text-primary underline">
                {sort === "reward" ? "Highest reward first" : "Newest created first"}
              </span>
            </button>
          </div>
          {load.status === "loading" ? (
            <p className="font-body-lg text-body-lg text-on-surface-variant">Reading task_count and list_tasks…</p>
          ) : load.status === "error" ? (
            <div className="bg-error-container text-on-error-container p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-sm">
              <p className="font-title-lg text-title-lg">Studio-dev RPC error</p>
              <p className="font-body-md text-body-md break-all">{load.message}</p>
              <button
                type="button"
                className="self-start px-space-md py-space-xs bg-primary text-on-primary font-label-md text-label-md uppercase rounded"
                onClick={() => void refresh(pagesFromEnd, pagesFromEnd > 0 ? "append" : "replace")}
              >
                Retry
              </button>
            </div>
          ) : count === 0 ? (
            <p className="font-body-lg text-body-lg text-on-surface-variant">
              task_count is 0. No tasks are stored on this V2 contract yet.
            </p>
          ) : filtered.length === 0 ? (
            <p className="font-body-lg text-body-lg text-on-surface-variant">
              No tasks on this page match these filters. Compact list_tasks rows have no source text.
            </p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-space-lg items-stretch">
              {filtered.map((task) => (
                <V2TaskCard key={task.task_id} task={task} />
              ))}
            </div>
          )}
          {load.status === "ready" && olderRemaining > 0 ? (
            <button
              type="button"
              className="self-start px-space-lg py-space-sm bg-surface-container-high font-label-md text-label-md uppercase rounded shadow-[2px_2px_0px_#00170b]"
              onClick={() => {
                const next = pagesFromEnd + 1;
                setPagesFromEnd(next);
                void refresh(next, "append");
              }}
            >
              Load older tasks ({olderRemaining} earlier ids)
            </button>
          ) : load.status === "ready" && count != null && items.length > 0 ? (
            <p className="font-body-sm text-body-sm text-on-surface-variant">
              Loaded {items.length} unique of task_count {count}. Pages are disjoint; no older ids remain.
            </p>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function Kpi({ value, label, accent }: { value: string; label: string; accent?: string }) {
  return (
    <div className="flex flex-col p-space-md bg-surface-container-lowest/5 rounded">
      <span
        className={`font-display-lg text-display-lg-mobile md:text-headline-lg font-bold leading-none ${accent ?? "text-inverse-on-surface"}`}
      >
        {value}
      </span>
      <span className="font-label-md text-label-md uppercase tracking-wider text-inverse-on-surface/70 mt-space-xs">
        {label}
      </span>
    </div>
  );
}
