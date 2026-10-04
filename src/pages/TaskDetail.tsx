import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { AppPreview } from "../components/AppPreview";
import { CopyButton } from "../components/CopyButton";
import { Icon } from "../components/Icon";
import { LanguagePair } from "../components/LanguagePair";
import { StatusPill } from "../components/StatusPill";
import { StatusTriad } from "../components/StatusTriad";
import { useDemo } from "../data/DemoContext";
import { libraryEntryForTask } from "../data/demoStore";
import { formatActor, shortenAddress } from "../lib/addresses";
import { wordCount } from "../lib/status";
import { useTaskParam } from "./useTask";

export function TaskDetail() {
  const { task } = useTaskParam();
  const { canSubmitTask, namedTranslator, state } = useDemo();
  if (!task) return <Missing />;

  const lib = libraryEntryForTask(state.library, task.id);
  const approvedHere = task.status === "approved" && Boolean(task.submission);
  const previewText = approvedHere && task.submission ? task.submission.text : task.sourceText;
  const previewCaption = approvedHere && lib
    ? `Demo library v${lib.version} for this task (${lib.key} · ${lib.locale}). Not a live onchain result.`
    : "Showing the source string. Only this task’s own demo approval updates the preview.";

  return (
    <div className="w-full px-gutter py-space-xl max-w-7xl mx-auto flex flex-col gap-space-xl">
      <div className="flex flex-wrap items-center gap-space-sm text-on-surface-variant font-label-sm text-label-sm uppercase">
        <Link to="/demo" className="inline-flex items-center gap-1 hover:text-primary">
          <Icon name="arrow_back" className="text-sm" />
          Task board
        </Link>
        <span>/</span>
        <span className="text-primary">{task.id}</span>
      </div>

      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-space-md">
        <div className="flex flex-col gap-space-sm max-w-3xl">
          <div className="flex flex-wrap items-center gap-space-sm">
            <StatusPill status={task.status} />
            <LanguagePair from={task.sourceLanguage} to={task.targetLanguage} />
            <span className="inline-flex items-center gap-1 px-space-sm py-0.5 bg-tertiary-fixed text-on-tertiary-fixed font-label-sm text-label-sm uppercase rounded rotate-[-2deg] shadow-[2px_2px_0px_#00170b]">
              Demo sample
            </span>
          </div>
          <div className="flex items-center gap-space-sm">
            <h1 className="font-headline-lg text-headline-lg-mobile md:text-headline-lg text-primary tracking-tight">
              {task.title}
            </h1>
            <CopyButton value={task.id} label="Copy id" />
          </div>
          <p className="font-body-lg text-body-lg text-on-surface-variant">{task.context}</p>
        </div>
        <div className="bg-surface-container-high p-space-md rounded shadow-[2px_2px_0px_#00170b]">
          <span className="font-label-sm text-label-sm uppercase text-on-surface-variant">Intended reward (demo)</span>
          <p className="font-headline-md text-headline-md text-primary">{task.intendedRewardGen} GEN</p>
          <p className="font-body-sm text-body-sm text-on-surface-variant">No GEN is locked or paid.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-space-xl">
        <div className="lg:col-span-7 flex flex-col gap-space-lg">
          <section className="bg-surface-container-lowest p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-md">
            <div className="flex items-center justify-between">
              <h2 className="font-headline-sm text-headline-sm uppercase text-primary">Source string</h2>
              <span className="font-label-sm text-label-sm uppercase text-on-surface-variant">
                {wordCount(task.sourceText)} words · {task.sourceText.length} characters
              </span>
            </div>
            <blockquote className="font-title-lg text-title-lg text-primary border-l-4 border-l-secondary-container pl-space-md italic">
              “{task.sourceText}”
            </blockquote>
            <CopyButton value={task.sourceText} label="Copy source" />
            <p className="font-body-md text-body-md text-on-surface-variant">
              <span className="font-label-sm text-label-sm uppercase">Intended meaning: </span>
              {task.meaning}
            </p>
          </section>

          <section className="bg-surface-container-lowest p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-sm">
            <h2 className="font-headline-sm text-headline-sm uppercase text-primary">Requirements</h2>
            {task.requirements.map((req, i) => (
              <div key={req} className="flex items-start gap-space-sm bg-surface-container-low p-space-sm rounded">
                <span className="w-5 h-5 bg-primary text-on-primary rounded flex items-center justify-center text-[10px] font-bold">
                  {i + 1}
                </span>
                <p className="font-body-md text-body-md text-primary">{req}</p>
              </div>
            ))}
          </section>

          <AppPreview
            body={previewText}
            locale={lib ? task.targetLanguage : task.sourceLanguage}
            caption={previewCaption}
          />
        </div>

        <aside className="lg:col-span-5 flex flex-col gap-space-md">
          <section className="bg-primary-container text-inverse-on-surface p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-md">
            <span className="font-label-sm text-label-sm uppercase tracking-widest text-tertiary-fixed">
              Named translator
            </span>
            <p className="font-headline-sm text-headline-sm">{task.translatorLabel}</p>
            <p className="font-body-md text-body-md break-all">{task.translatorAddress}</p>
            <CopyButton value={task.translatorAddress} label="Copy address" />
            {namedTranslator(task) ? (
              <p className="font-body-sm text-body-sm text-tertiary-fixed">
                You are viewing as the named demo translator for this task.
              </p>
            ) : (
              <p className="font-body-sm text-body-sm text-primary-fixed-dim">
                Read-only for this role. Only {shortenAddress(task.translatorAddress)} can submit.
              </p>
            )}
            {canSubmitTask(task) ? (
              <Link
                to={`/demo/tasks/${task.id}/submit`}
                className="inline-flex items-center justify-between px-space-md py-space-sm bg-secondary-container text-on-secondary-container font-label-md text-label-md uppercase rounded shadow-[2px_2px_0px_#00170b]"
              >
                Submit translation
                <Icon name="arrow_forward" />
              </Link>
            ) : (
              <Link
                to={`/demo/tasks/${task.id}/submit`}
                className="inline-flex items-center justify-between px-space-md py-space-sm bg-surface-container/10 font-label-md text-label-md uppercase rounded"
              >
                Open submit view (read-only)
                <Icon name="visibility" />
              </Link>
            )}
            <Link
              to={`/demo/tasks/${task.id}/decision`}
              className="inline-flex items-center justify-between px-space-md py-space-sm bg-surface-container text-on-surface font-label-md text-label-md uppercase rounded"
            >
              Validation & decision
              <Icon name="gavel" />
            </Link>
          </section>
          <section className="bg-surface-container-lowest p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-sm">
            <h2 className="font-headline-sm text-headline-sm uppercase text-primary">Lifecycle (demo)</h2>
            <Step n="01" title="Created" done>
              Stored in this browser. Owner {formatActor(task.ownerAddress)}.
            </Step>
            <Step n="02" title="Translation" done={task.status !== "open"}>
              Named translator drafts a string. No commit-reveal in demo.
            </Step>
            <Step n="03" title="Simulated decision" done={task.status === "approved" || task.status === "rejected"}>
              Explicit demo control — not GenLayer consensus.
            </Step>
            <Step n="04" title="Library" done={task.status === "approved"}>
              Approval adds a versioned demo string. Rejection leaves the library unchanged.
            </Step>
          </section>
        </aside>
      </div>

      <section className="flex flex-col gap-space-md">
        <h2 className="font-headline-sm text-headline-sm uppercase text-primary">Settlement fields</h2>
        <p className="font-body-sm text-body-sm text-on-surface-variant max-w-3xl">
          Transaction status, execution result, and payment status are separate. This frontend has no real
          transaction.
        </p>
        <StatusTriad task={task} />
      </section>
    </div>
  );
}

function Step({ n, title, done, children }: { n: string; title: string; done?: boolean; children: ReactNode }) {
  return (
    <div className="flex gap-space-sm">
      <span className={`font-label-sm text-label-sm ${done ? "text-secondary" : "text-on-surface-variant"}`}>
        {n}
      </span>
      <div>
        <p className="font-title-md text-title-md text-primary">{title}</p>
        <p className="font-body-sm text-body-sm text-on-surface-variant">{children}</p>
      </div>
    </div>
  );
}

function Missing() {
  return (
    <div className="max-w-3xl mx-auto px-gutter py-space-2xl">
      <h1 className="font-headline-md text-headline-md">Task not found</h1>
      <p className="font-body-md text-body-md mt-space-sm">This id is not in the demo store.</p>
      <Link to="/demo" className="inline-block mt-space-md font-label-md text-label-md uppercase text-secondary">
        Back to task board
      </Link>
    </div>
  );
}
