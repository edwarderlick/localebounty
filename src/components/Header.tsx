import { useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useDemo } from "../data/DemoContext";
import { currentActor } from "../lib/addresses";
import {
  demoHref,
  isDemoPath,
  isV2ProductPath,
  liveDecisionHref,
  liveLibraryHref,
  liveSubmitHref,
  v2BoardHref,
  v2CreateHref,
  v2DecisionHref,
  v2LibraryHref,
  v2SubmitHref,
  v2TaskHref,
} from "../lib/paths";
import { loadProductUiSession } from "../live/productUi/persist";
import { loadProductUiV2Session } from "../live/productUiV2/persist";
import { BrandLogo } from "./BrandLogo";
import { Icon } from "./Icon";
import { WalletControl } from "./WalletControl";

const LIVE_NAV = [
  { to: "/v1", label: "Task Board", match: (p: string) => p === "/v1" },
  { to: "/tasks/new", label: "Create Task", match: (p: string) => p === "/tasks/new" },
  { to: "detail", label: "Task Detail", match: (p: string) => /^\/tasks\/(?!new)[^/]+$/.test(p) },
  { to: "submit", label: "Submit Translation", match: (p: string) => /\/tasks\/(?!new)[^/]+\/submit$/.test(p) },
  { to: "decision", label: "Validation & Decision", match: (p: string) => /\/tasks\/(?!new)[^/]+\/decision$/.test(p) },
  { to: liveLibraryHref(), label: "String Library", match: (p: string) => p === "/library" },
];

const V2_NAV = [
  { to: v2BoardHref(), label: "Task Board", match: (p: string) => p === "/v2" },
  { to: v2CreateHref(), label: "Create Task", match: (p: string) => p === "/v2/tasks/new" },
  { to: "detail", label: "Task Detail", match: (p: string) => /^\/v2\/tasks\/(?!new)[^/]+$/.test(p) },
  { to: "submit", label: "Submit Translation", match: (p: string) => /\/v2\/tasks\/(?!new)[^/]+\/submit$/.test(p) },
  { to: "decision", label: "Validation & Decision", match: (p: string) => /\/v2\/tasks\/(?!new)[^/]+\/decision$/.test(p) },
  { to: v2LibraryHref(), label: "String Library", match: (p: string) => p === "/v2/library" },
];

const DEMO_NAV = [
  { to: demoHref("/"), label: "Task Board", match: (p: string) => p === "/demo" },
  { to: demoHref("/tasks/new"), label: "Create Task", match: (p: string) => p === "/demo/tasks/new" },
  { to: "detail", label: "Task Detail", match: (p: string) => /^\/demo\/tasks\/(?!new)[^/]+$/.test(p) && !p.endsWith("/submit") && !p.endsWith("/decision") },
  { to: "submit", label: "Submit Translation", match: (p: string) => p.endsWith("/submit") },
  { to: "decision", label: "Validation & Decision", match: (p: string) => p.endsWith("/decision") },
  { to: demoHref("/library"), label: "String Library", match: (p: string) => p === "/demo/library" },
];

function navClass(active: boolean) {
  return active
    ? "px-space-md py-space-xs rounded uppercase tracking-wider transition-all bg-primary-container text-on-primary font-bold shadow-[2px_2px_0px_#00170b]"
    : "px-space-md py-space-xs rounded font-label-md text-label-md uppercase tracking-wider text-on-surface-variant hover:bg-surface-container-highest hover:text-on-surface transition-all";
}

export function Header() {
  const { role, setDemoRole, state } = useDemo();
  const location = useLocation();
  const demo = isDemoPath(location.pathname);
  const v2 = isV2ProductPath(location.pathname);
  const [open, setOpen] = useState(false);
  const actor = currentActor(role);
  const demoFallback = state.lastTaskId ?? state.tasks[0]?.id;
  const liveFallback = loadProductUiSession().lastOpenedTaskId;
  const v2Fallback = loadProductUiV2Session().lastOpenedTaskId;
  const hrefForDemo = (item: (typeof DEMO_NAV)[number]) => {
    if (item.to === "detail") return demoFallback ? demoHref(`/tasks/${demoFallback}`) : demoHref("/");
    if (item.to === "submit") return demoFallback ? demoHref(`/tasks/${demoFallback}/submit`) : demoHref("/");
    if (item.to === "decision") return demoFallback ? demoHref(`/tasks/${demoFallback}/decision`) : demoHref("/");
    return item.to;
  };
  const hrefForLive = (item: (typeof LIVE_NAV)[number]) => {
    if (item.to === "detail") return liveFallback ? `/tasks/${liveFallback}` : "/v1";
    if (item.to === "submit") return liveFallback ? liveSubmitHref(liveFallback) : "/v1";
    if (item.to === "decision") return liveFallback ? liveDecisionHref(liveFallback) : "/v1";
    return item.to;
  };
  const hrefForV2 = (item: (typeof V2_NAV)[number]) => {
    if (item.to === "detail") return v2Fallback ? v2TaskHref(v2Fallback) : v2BoardHref();
    if (item.to === "submit") return v2Fallback ? v2SubmitHref(v2Fallback) : v2BoardHref();
    if (item.to === "decision") return v2Fallback ? v2DecisionHref(v2Fallback) : v2BoardHref();
    return item.to;
  };

  return (
    <header className="fixed top-0 left-0 right-0 z-50 bg-surface/90 backdrop-blur-md shadow-[0_1px_8px_rgba(0,0,0,0.04)]">
      <div className="h-20 w-full px-gutter flex items-center justify-between gap-space-md">
        <div className="flex items-center gap-space-md flex-shrink-0">
          <NavLink
            to={demo ? demoHref("/") : v2 ? v2BoardHref() : "/v1"}
            className="flex items-center gap-space-sm"
            onClick={() => setOpen(false)}
          >
            <BrandLogo className="h-8 w-[150px]" />
          </NavLink>
          <div
            className={`hidden sm:inline-flex items-center gap-space-xs px-space-sm py-space-xs font-label-sm text-label-sm uppercase tracking-wider rounded shadow-[2px_2px_0px_#00170b] rotate-[-2deg] ${
              demo ? "bg-tertiary-fixed text-on-tertiary-fixed" : "bg-secondary-container text-on-secondary-container"
            }`}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-primary-container animate-pulse" />
            {demo ? "Demo mode" : v2 ? "Live V2 Studio-dev" : "Live Studio-dev"}
          </div>
        </div>

        <nav className="hidden xl:flex items-center gap-space-xs bg-surface-container-high p-space-xs rounded">
          {demo
            ? DEMO_NAV.map((item) => (
                <NavLink key={item.label} to={hrefForDemo(item)} className={navClass(item.match(location.pathname))}>
                  {item.label}
                </NavLink>
              ))
            : v2
              ? V2_NAV.map((item) => (
                  <NavLink key={item.label} to={hrefForV2(item)} className={navClass(item.match(location.pathname))}>
                    {item.label}
                  </NavLink>
                ))
              : LIVE_NAV.map((item) => (
                  <NavLink key={item.label} to={hrefForLive(item)} className={navClass(item.match(location.pathname))}>
                    {item.label}
                  </NavLink>
                ))}
        </nav>

        <div className="flex items-center gap-space-sm flex-shrink-0">
          {demo ? (
            <div className="hidden md:flex items-center gap-space-sm bg-surface-container px-space-md py-space-xs rounded">
              <div className="flex flex-col text-right">
                <span className="font-label-sm text-label-sm text-on-surface-variant font-bold leading-none">
                  {actor.short}
                </span>
                <span className="font-body-sm text-body-sm font-bold text-secondary leading-tight">
                  {role === "translator" ? "Elena · demo role" : "Owner · demo role"}
                </span>
              </div>
              <div className="h-6 w-px bg-outline-variant" />
              <div className="flex bg-surface-container-highest rounded p-0.5">
                <button
                  type="button"
                  onClick={() => setDemoRole("owner")}
                  className={`px-space-xs py-0.5 font-label-sm text-label-sm uppercase rounded ${
                    role === "owner" ? "bg-primary-container text-on-primary" : "text-on-surface-variant"
                  }`}
                >
                  Owner
                </button>
                <button
                  type="button"
                  onClick={() => setDemoRole("translator")}
                  className={`px-space-xs py-0.5 font-label-sm text-label-sm uppercase rounded ${
                    role === "translator" ? "bg-primary-container text-on-primary" : "text-on-surface-variant"
                  }`}
                >
                  Translator
                </button>
              </div>
            </div>
          ) : (
            <div className="hidden md:block">
              <WalletControl />
            </div>
          )}
          <NavLink
            to={demo ? v2BoardHref() : demoHref("/")}
            className="hidden lg:inline font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant hover:text-primary"
          >
            {demo ? "Live app" : "Demo"}
          </NavLink>
          <NavLink
            to={v2 ? "/v1" : v2BoardHref()}
            className="hidden xl:inline font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant hover:text-primary"
          >
            {v2 ? "V1 history" : "V2 app"}
          </NavLink>
          <NavLink
            to={demo ? demoHref("/tasks/new") : v2 ? v2CreateHref() : "/tasks/new"}
            className="hidden sm:inline-flex items-center gap-space-xs bg-secondary-container text-on-secondary-container font-headline-sm text-label-md uppercase px-space-md py-space-sm rounded shadow-[2px_2px_0px_#00170b] hover:bg-secondary hover:text-on-secondary active:translate-x-0.5 active:translate-y-0.5 transition-all"
          >
            <Icon name="add" className="text-sm" />
            <span>Create bounty</span>
          </NavLink>
          <button
            type="button"
            className="xl:hidden p-space-xs bg-surface-container-high rounded"
            onClick={() => setOpen((v) => !v)}
            aria-label="Open navigation"
          >
            <Icon name={open ? "close" : "menu"} />
          </button>
        </div>
      </div>

      {open ? (
        <div className="xl:hidden border-t border-outline-variant bg-surface px-gutter py-space-md flex flex-col gap-space-sm">
          {demo ? (
            <div className="flex md:hidden items-center justify-between bg-surface-container p-space-sm rounded">
              <span className="font-label-sm text-label-sm uppercase">
                {actor.short} · {role === "translator" ? "Elena · demo role" : "Owner · demo role"}
              </span>
              <div className="flex bg-surface-container-highest rounded p-0.5">
                <button
                  type="button"
                  onClick={() => setDemoRole("owner")}
                  className={`px-space-xs py-0.5 font-label-sm text-label-sm uppercase rounded ${
                    role === "owner" ? "bg-primary-container text-on-primary" : ""
                  }`}
                >
                  Owner
                </button>
                <button
                  type="button"
                  onClick={() => setDemoRole("translator")}
                  className={`px-space-xs py-0.5 font-label-sm text-label-sm uppercase rounded ${
                    role === "translator" ? "bg-primary-container text-on-primary" : ""
                  }`}
                >
                  Translator
                </button>
              </div>
            </div>
          ) : (
            <div className="md:hidden">
              <WalletControl />
            </div>
          )}
          {(demo ? DEMO_NAV : v2 ? V2_NAV : LIVE_NAV).map((item) => (
            <NavLink
              key={item.label}
              to={
                demo
                  ? hrefForDemo(item as (typeof DEMO_NAV)[number])
                  : v2
                    ? hrefForV2(item as (typeof V2_NAV)[number])
                    : hrefForLive(item as (typeof LIVE_NAV)[number])
              }
              onClick={() => setOpen(false)}
              className={navClass(item.match(location.pathname))}
            >
              {item.label}
            </NavLink>
          ))}
          <NavLink
            to={demo ? v2BoardHref() : demoHref("/")}
            onClick={() => setOpen(false)}
            className="px-space-md py-space-xs font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant"
          >
            {demo ? "Live app" : "Demo mode"}
          </NavLink>
          <NavLink
            to={v2 ? "/v1" : v2BoardHref()}
            onClick={() => setOpen(false)}
            className="px-space-md py-space-xs font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant"
          >
            {v2 ? "V1 history" : "V2 app"}
          </NavLink>
        </div>
      ) : null}
    </header>
  );
}
