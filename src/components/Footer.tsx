import { Link, useLocation } from "react-router-dom";
import { useDemo } from "../data/DemoContext";
import { demoHref, isDemoPath, isV2ProductPath, v2BoardHref, v2CreateHref, v2LibraryHref, v2TaskHref } from "../lib/paths";
import { loadProductUiSession } from "../live/productUi/persist";
import { loadProductUiV2Session } from "../live/productUiV2/persist";

export function Footer() {
  const { state } = useDemo();
  const pathname = useLocation().pathname;
  const demo = isDemoPath(pathname);
  const v2 = isV2ProductPath(pathname);
  const demoTaskId = state.lastTaskId ?? state.tasks[0]?.id;
  const liveTaskId = loadProductUiSession().lastOpenedTaskId;
  const v2TaskId = loadProductUiV2Session().lastOpenedTaskId;

  return (
    <footer className="w-full bg-primary-container text-inverse-on-surface pt-space-2xl pb-space-lg overflow-hidden">
      <div className="w-full px-gutter">
        <div className="flex flex-wrap items-center justify-between gap-space-md pb-space-xl border-b border-primary-fixed-dim/20">
          <div className="flex items-center gap-space-sm">
            <span className="inline-block w-2.5 h-2.5 rounded-full bg-tertiary-fixed" />
            <span className="font-label-md text-label-md uppercase tracking-wider text-tertiary-fixed">
              {demo ? "Demo status" : "Live status"}
            </span>
            <span className="font-title-md text-title-md text-inverse-on-surface">
              {demo
                ? "Frontend wiring only — no GEN locked or paid."
                : "Board, create, submit, decision, and library read the deployed Studio-dev contract. Wallet signatures stay user-initiated."}
            </span>
          </div>
          <div className="inline-flex items-center gap-space-xs px-space-sm py-space-xs bg-surface-container-lowest/10 text-tertiary-fixed font-label-sm text-label-sm rounded uppercase tracking-wider">
            {demo ? "Simulated in-browser store" : "list_tasks / get_task / submit_translation / evaluate_task / list_library"}
          </div>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-space-xl py-space-2xl">
          <div className="flex flex-col gap-space-sm">
            <span className="font-label-md text-label-md uppercase tracking-widest text-primary-fixed-dim font-bold">
              App
            </span>
            <Link to={v2 ? v2BoardHref() : demo ? v2BoardHref() : "/v1"} className="font-body-md text-body-md text-inverse-on-surface/80 hover:text-tertiary-fixed">
              {v2 ? "V2 Task Board" : "Live Task Board"}
            </Link>
            <Link to={v2 ? v2CreateHref() : "/tasks/new"} className="font-body-md text-body-md text-inverse-on-surface/80 hover:text-tertiary-fixed">
              {v2 ? "V2 Create Task" : "Live Create Task"}
            </Link>
            <Link to={v2 ? v2LibraryHref() : "/library"} className="font-body-md text-body-md text-inverse-on-surface/80 hover:text-tertiary-fixed">
              {v2 ? "V2 String Library" : "Live string library"}
            </Link>
            {!v2 && !demo ? <Link to={v2BoardHref()} className="font-body-md text-body-md text-tertiary-fixed hover:underline">V2 product app</Link> : null}
            {v2 ? <Link to="/v1" className="font-body-md text-body-md text-inverse-on-surface/80 hover:text-tertiary-fixed">V1 historical app</Link> : null}
            <Link to={demoHref("/")} className="font-body-md text-body-md text-inverse-on-surface/80 hover:text-tertiary-fixed">
              Demo mode
            </Link>
            <Link to={demoHref("/library")} className="font-body-md text-body-md text-inverse-on-surface/80 hover:text-tertiary-fixed">
              Demo string library
            </Link>
            {demo && demoTaskId ? (
              <Link
                to={demoHref(`/tasks/${demoTaskId}`)}
                className="font-body-md text-body-md text-inverse-on-surface/80 hover:text-tertiary-fixed"
              >
                Last demo task
              </Link>
            ) : null}
            {!demo && !v2 && liveTaskId ? (
              <Link
                to={`/tasks/${liveTaskId}`}
                className="font-body-md text-body-md text-inverse-on-surface/80 hover:text-tertiary-fixed"
              >
                Last live task
              </Link>
            ) : null}
            {v2 && v2TaskId ? (
              <Link to={v2TaskHref(v2TaskId)} className="font-body-md text-body-md text-inverse-on-surface/80 hover:text-tertiary-fixed">
                Last V2 task
              </Link>
            ) : null}
          </div>
          <div className="flex flex-col gap-space-sm">
            <span className="font-label-md text-label-md uppercase tracking-widest text-primary-fixed-dim font-bold">
              Future work
            </span>
            <p className="font-body-md text-body-md text-inverse-on-surface/60">
              Staking, slashing, and appeal controls are future work. Live writes need a user-signed wallet.
            </p>
          </div>
          <div className="flex flex-col gap-space-sm">
            <span className="font-label-md text-label-md uppercase tracking-widest text-primary-fixed-dim font-bold">
              Honesty
            </span>
            <p className="font-body-md text-body-md text-inverse-on-surface/80">
              Demo localStorage and live contract tasks stay separate. payout_submitted is not paid.
            </p>
            <p className="font-body-md text-body-md text-inverse-on-surface/80">
              Historical live test routes and transaction evidence are listed in the README.
            </p>
          </div>
          <div className="flex flex-col gap-space-sm">
            <span className="font-label-md text-label-md uppercase tracking-widest text-primary-fixed-dim font-bold">
              Status fields
            </span>
            <p className="font-body-md text-body-md text-inverse-on-surface/80">
              Transaction status, execution result, and payment delivery stay separate.
            </p>
          </div>
        </div>
        <div className="py-space-xl select-none pointer-events-none">
          <div className="font-display-xl text-[64px] sm:text-[100px] md:text-[140px] lg:text-[180px] leading-none font-bold uppercase tracking-tighter text-surface-container-lowest/[0.07] whitespace-nowrap overflow-hidden">
            LOCALIZATION
          </div>
        </div>
        <div className="pt-space-lg border-t border-primary-fixed-dim/20 flex flex-col md:flex-row items-start md:items-center justify-between gap-space-md text-inverse-on-surface/60 font-body-sm text-body-sm">
          <p>{demo ? "LocaleBounty frontend demo. No GEN payments." : "LocaleBounty live UI on Studio-dev. Wallet signatures are user-initiated."}</p>
          <p className="font-label-sm text-label-sm uppercase tracking-wider">
            {demo ? "localStorage persistence · DEMO MODE" : v2 ? "contract 0x3B06…5F431 · chain 61997" : "contract 0x84dA…07D96 · chain 61997"}
          </p>
        </div>
      </div>
    </footer>
  );
}
