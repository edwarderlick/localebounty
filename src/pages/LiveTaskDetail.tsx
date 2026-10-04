import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { CopyButton } from "../components/CopyButton";
import { Icon } from "../components/Icon";
import { LiveTaskEscrowActions } from "../components/LiveTaskEscrowActions";
import { LanguagePair } from "../components/LanguagePair";
import { LiveStatusPill } from "../components/LiveStatusPill";
import { addressesEqual, formatError, formatGen, jsonSafe } from "../live/format";
import { createReadClient, readProductTask } from "../live/genlayer";
import { PAYOUT_SUBMITTED_IS_NOT_PAYMENT } from "../live/product/evidence";
import { parseProductTask, type ProductTask } from "../live/product/task";
import { PRODUCT_UI_CONTRACT } from "../live/productUi/constants";
import { loadProductUiSession, rememberOpenedTask, saveProductUiSession } from "../live/productUi/persist";
import { formatUnix, paymentDeliveryView } from "../live/productUi/status";
import { useWallet } from "../live/WalletContext";
import { liveDecisionHref, liveSubmitHref } from "../lib/paths";
import { shortenAddress } from "../lib/addresses";
import { wordCount } from "../lib/status";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "missing" }
  | { status: "ready"; task: ProductTask };

export function LiveTaskDetail() {
  const { id } = useParams();
  const wallet = useWallet();
  const [load, setLoad] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    if (!id) {
      setLoad({ status: "missing" });
      return;
    }
    let cancelled = false;
    setLoad({ status: "loading" });
    void (async () => {
      try {
        const raw = jsonSafe(await readProductTask(createReadClient(), PRODUCT_UI_CONTRACT, id));
        const task = parseProductTask(raw);
        if (cancelled) return;
        if (!task) {
          setLoad({ status: "missing" });
          return;
        }
        saveProductUiSession(rememberOpenedTask(loadProductUiSession(), task.task_id));
        setLoad({ status: "ready", task });
      } catch (err) {
        if (cancelled) return;
        setLoad({ status: "error", message: formatError(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (!id || load.status === "missing") {
    return (
      <div className="max-w-3xl mx-auto px-gutter py-space-2xl">
        <h1 className="font-headline-md text-headline-md">Task not found</h1>
        <p className="font-body-md text-body-md mt-space-sm">
          This id is not a live contract task. Demo store ids are not used on this route.
        </p>
        <Link to="/v1" className="inline-block mt-space-md font-label-md text-label-md uppercase text-secondary">
          Back to task board
        </Link>
      </div>
    );
  }

  if (load.status === "loading") {
    return (
      <div className="max-w-3xl mx-auto px-gutter py-space-2xl">
        <p className="font-body-lg text-body-lg text-on-surface-variant">Reading get_task…</p>
      </div>
    );
  }

  if (load.status === "error") {
    return (
      <div className="max-w-3xl mx-auto px-gutter py-space-2xl flex flex-col gap-space-sm">
        <h1 className="font-headline-md text-headline-md">get_task failed</h1>
        <p className="font-body-md text-body-md break-all">{load.message}</p>
        <Link to="/v1" className="font-label-md text-label-md uppercase text-secondary">
          Back to task board
        </Link>
      </div>
    );
  }

  const task = load.task;
  const payment = paymentDeliveryView(task);
  const isFunder = Boolean(wallet.address && addressesEqual(wallet.address, task.funder));
  const isTranslator = Boolean(wallet.address && addressesEqual(wallet.address, task.translator));
  let rewardLabel = task.rewardWei;
  try {
    rewardLabel = formatGen(BigInt(task.rewardWei));
  } catch {
    rewardLabel = `${task.rewardWei} wei`;
  }

  return (
    <div className="w-full px-gutter py-space-xl max-w-7xl mx-auto flex flex-col gap-space-xl">
      <div className="flex flex-wrap items-center gap-space-sm text-on-surface-variant font-label-sm text-label-sm uppercase">
        <Link to="/v1" className="inline-flex items-center gap-1 hover:text-primary">
          <Icon name="arrow_back" className="text-sm" />
          Task board
        </Link>
        <span>/</span>
        <span className="text-primary break-all">{task.task_id}</span>
      </div>

      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-space-md">
        <div className="flex flex-col gap-space-sm max-w-3xl">
          <div className="flex flex-wrap items-center gap-space-sm">
            <LiveStatusPill state={task.state} />
            <LanguagePair from={task.source_locale} to={task.target_locale} />
            <span className="inline-flex items-center gap-1 px-space-sm py-0.5 bg-tertiary-fixed text-on-tertiary-fixed font-label-sm text-label-sm uppercase rounded rotate-[-2deg] shadow-[2px_2px_0px_#00170b]">
              Live get_task
            </span>
          </div>
          <div className="flex items-center gap-space-sm">
            <h1 className="font-headline-lg text-headline-lg-mobile md:text-headline-lg text-primary tracking-tight">
              {task.string_key || "Task"}
            </h1>
            <CopyButton value={task.task_id} label="Copy id" />
          </div>
          <p className="font-body-lg text-body-lg text-on-surface-variant">{task.app_context || "No app context stored."}</p>
        </div>
        <div className="bg-surface-container-high p-space-md rounded shadow-[2px_2px_0px_#00170b]">
          <span className="font-label-sm text-label-sm uppercase text-on-surface-variant">Attached reward</span>
          <p className="font-headline-md text-headline-md text-primary">{rewardLabel}</p>
          <p className="font-body-sm text-body-sm text-on-surface-variant">{task.rewardWei} wei</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-space-xl">
        <div className="lg:col-span-7 flex flex-col gap-space-lg">
          <section className="bg-surface-container-lowest p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-md">
            <div className="flex items-center justify-between">
              <h2 className="font-headline-sm text-headline-sm uppercase text-primary">Source string</h2>
              <span className="font-label-sm text-label-sm uppercase text-on-surface-variant">
                {wordCount(task.source_text)} words · {task.source_text.length} characters
              </span>
            </div>
            <blockquote className="font-title-lg text-title-lg text-primary border-l-4 border-l-secondary-container pl-space-md italic">
              “{task.source_text}”
            </blockquote>
            <CopyButton value={task.source_text} label="Copy source" />
            <p className="font-body-md text-body-md text-on-surface-variant">
              <span className="font-label-sm text-label-sm uppercase">Intended meaning: </span>
              {task.intended_meaning}
            </p>
          </section>

          <section className="bg-surface-container-lowest p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-sm">
            <h2 className="font-headline-sm text-headline-sm uppercase text-primary">Semantic criteria</h2>
            <p className="font-body-md text-body-md text-primary whitespace-pre-wrap">{task.semantic_criteria}</p>
          </section>

          {task.translation ? (
            <section className="bg-surface-container-lowest p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-sm">
              <h2 className="font-headline-sm text-headline-sm uppercase text-primary">Stored translation</h2>
              <p className="font-title-md text-title-md text-primary whitespace-pre-wrap">{task.translation}</p>
            </section>
          ) : null}
        </div>

        <aside className="lg:col-span-5 flex flex-col gap-space-md">
          <section className="bg-primary-container text-inverse-on-surface p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-md">
            <span className="font-label-sm text-label-sm uppercase tracking-widest text-tertiary-fixed">
              Named translator
            </span>
            <p className="font-body-md text-body-md break-all">{task.translator}</p>
            <CopyButton value={task.translator} label="Copy address" />
            {isTranslator ? (
              <p className="font-body-sm text-body-sm text-tertiary-fixed">
                Connected wallet is the named translator for this task.
              </p>
            ) : (
              <p className="font-body-sm text-body-sm text-primary-fixed-dim">
                Only {shortenAddress(task.translator)} can submit. Demo roles are not used.
              </p>
            )}
            {task.state === "open" && task.translation === "" ? (
              <p className="font-body-sm text-body-sm text-tertiary-fixed">
                Translator fairness: while this task stays open with an empty translation, the funder may call
                cancel_task and reclaim the attached reward. The deployed contract does not lock work-in-progress. Submit
                before the funder cancels if you intend to claim this bounty.
              </p>
            ) : null}
            {isFunder ? (
              <p className="font-body-sm text-body-sm text-tertiary-fixed">Connected wallet is the funder.</p>
            ) : (
              <p className="font-body-sm text-body-sm text-primary-fixed-dim">Funder {shortenAddress(task.funder)}.</p>
            )}
            {task.state === "open" || task.state === "submitted" ? (
              <Link
                to={liveSubmitHref(task.task_id)}
                className="inline-flex items-center justify-between px-space-md py-space-sm bg-surface-container text-on-surface font-label-md text-label-md uppercase rounded"
              >
                Submit translation
                <Icon name="arrow_forward" />
              </Link>
            ) : (
              <span className="inline-flex items-center justify-between px-space-md py-space-sm bg-surface-container/10 font-label-md text-label-md uppercase rounded opacity-70">
                Submit translation unavailable
                <Icon name="lock" />
              </span>
            )}
            {task.state === "submitted" ||
            task.state === "approved" ||
            task.state === "rejected" ||
            task.state === "timed_out" ? (
              <Link
                to={liveDecisionHref(task.task_id)}
                className="inline-flex items-center justify-between px-space-md py-space-sm bg-surface-container text-on-surface font-label-md text-label-md uppercase rounded"
              >
                Validation & decision
                <Icon name="arrow_forward" />
              </Link>
            ) : (
              <span className="inline-flex items-center justify-between px-space-md py-space-sm bg-surface-container/10 font-label-md text-label-md uppercase rounded opacity-70">
                Validation & decision unavailable
                <Icon name="lock" />
              </span>
            )}
          </section>
          <section className="bg-surface-container-lowest p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-sm">
            <h2 className="font-headline-sm text-headline-sm uppercase text-primary">Windows</h2>
            <Step n="01" title="submit_by" done>
              {formatUnix(task.submit_by_unix)}
            </Step>
            <Step n="02" title="recover_after" done>
              {formatUnix(task.recover_after_unix)}
            </Step>
            <Step n="03" title="recovery_opens_at" done>
              {formatUnix(task.recovery_opens_at_unix)}
            </Step>
            <Step n="04" title="submitted_at / decided_at">
              submitted {formatUnix(task.submitted_at_unix)} · decided {formatUnix(task.decided_at_unix)}
            </Step>
          </section>
          <LiveTaskEscrowActions
            task={task}
            onTask={(next) => setLoad({ status: "ready", task: next })}
          />
          <section className="bg-surface-container-lowest p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-xs">
            <h2 className="font-headline-sm text-headline-sm uppercase text-primary">Escrow / payment fields</h2>
            <p className="font-body-sm text-body-sm">state: {task.state}</p>
            <p className="font-body-sm text-body-sm">decision: {task.decision}</p>
            <p className="font-body-sm text-body-sm">payment_status: {task.payment_status || "none"}</p>
            <p className="font-body-sm text-body-sm">payment_kind: {task.payment_kind || "none"}</p>
            <p className="font-body-sm text-body-sm">payout_submitted: {String(task.payout_submitted)}</p>
            <p className="font-body-sm text-body-sm text-on-surface-variant">{PAYOUT_SUBMITTED_IS_NOT_PAYMENT}</p>
          </section>
        </aside>
      </div>

      <section className="flex flex-col gap-space-md">
        <h2 className="font-headline-sm text-headline-sm uppercase text-primary">Settlement fields</h2>
        <p className="font-body-sm text-body-sm text-on-surface-variant max-w-3xl">
          Transaction status, execution result, and payment delivery stay separate. This page is a contract read.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-space-md">
          <Cell
            kicker="Field 01"
            title="Transaction status"
            value="Not on this read"
            hint="get_task is a view. Parent consensus status lives on the write receipt (Create, Submit, Evaluate, Cancel, Recover)."
          />
          <Cell
            kicker="Field 02"
            title="Execution result"
            value="Not on this read"
            hint="FINISHED_WITH_RETURN / FINISHED_WITH_ERROR is a parent receipt field. It is not get_task.state."
          />
          <Cell
            kicker="Field 03"
            title="Contract decision"
            value={`state ${task.state} · decision ${task.decision}`}
            hint="Stored by the contract. Separate from consensus, execution, EthSend, child credit, and EOA delta."
          />
          <Cell
            kicker="Field 04"
            title="Outgoing EthSend / child credit"
            value={payment.label}
            hint={`${payment.hint} payout_submitted is not child value_credited.`}
          />
          <Cell
            kicker="Field 05"
            title="EOA balance"
            value="Not proven on this read"
            hint="Wallet delta needs before/after snapshots from the signing browser. This view does not invent them."
          />
        </div>
      </section>
    </div>
  );
}

function Step({ n, title, done, children }: { n: string; title: string; done?: boolean; children: ReactNode }) {
  return (
    <div className="flex gap-space-sm">
      <span className={`font-label-sm text-label-sm ${done ? "text-secondary" : "text-on-surface-variant"}`}>{n}</span>
      <div>
        <p className="font-title-md text-title-md text-primary">{title}</p>
        <p className="font-body-sm text-body-sm text-on-surface-variant">{children}</p>
      </div>
    </div>
  );
}

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
