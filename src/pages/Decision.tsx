import { useState } from "react";
import { Link } from "react-router-dom";
import { AppPreview } from "../components/AppPreview";
import { CopyButton } from "../components/CopyButton";
import { Icon } from "../components/Icon";
import { StatusPill } from "../components/StatusPill";
import { StatusTriad } from "../components/StatusTriad";
import { useDemo } from "../data/DemoContext";
import { libraryEntryForTask } from "../data/demoStore";
import { useTaskParam } from "./useTask";

export function Decision() {
  const { task } = useTaskParam();
  const { role, simulate, state } = useDemo();
  const [actionError, setActionError] = useState<string | null>(null);
  if (!task) {
    return (
      <div className="max-w-3xl mx-auto px-gutter py-space-2xl">
        <h1 className="font-headline-md text-headline-md">Task not found</h1>
        <Link to="/demo" className="inline-block mt-space-md font-label-md text-label-md uppercase text-secondary">
          Back to task board
        </Link>
      </div>
    );
  }

  const taskId = task.id;
  const lib = libraryEntryForTask(state.library, taskId);
  const canSimulate = role === "owner" && task.status === "submitted";
  const approvedHere = task.status === "approved" && Boolean(task.submission);
  const previewBody = approvedHere && task.submission ? task.submission.text : task.sourceText;

  function runSimulation(outcome: "approved" | "rejected") {
    const error = simulate(taskId, outcome);
    setActionError(error ?? null);
  }

  return (
    <div className="w-full px-gutter py-space-xl max-w-7xl mx-auto flex flex-col gap-space-xl">
      <div className="flex flex-wrap items-center gap-space-sm font-label-sm text-label-sm uppercase text-on-surface-variant">
        <Link to={`/demo/tasks/${task.id}`} className="inline-flex items-center gap-1 hover:text-primary">
          <Icon name="arrow_back" className="text-sm" />
          Task detail
        </Link>
        <span>/</span>
        <span className="text-primary">{task.id}</span>
      </div>

      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-space-md">
        <div className="max-w-3xl flex flex-col gap-space-sm">
          <div className="flex flex-wrap items-center gap-space-sm">
            <span className="inline-flex px-space-sm py-0.5 bg-tertiary-fixed text-on-tertiary-fixed font-label-sm text-label-sm uppercase rounded rotate-[-2deg] shadow-[2px_2px_0px_#00170b]">
              Demo simulation
            </span>
            <StatusPill status={task.status} />
          </div>
          <h1 className="font-headline-lg text-headline-lg-mobile md:text-headline-lg text-primary tracking-tight">
            Validation & decision
          </h1>
          <p className="font-body-lg text-body-lg text-on-surface-variant">
            This screen does not run GenLayer consensus, validators, or signatures. Use the explicit simulation
            control after a submission. Approval is not a live onchain result.
          </p>
        </div>
        <CopyButton value={task.id} label="Copy task id" />
      </div>

      <section className="bg-surface-container-lowest p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-md">
        <h2 className="font-headline-sm text-headline-sm uppercase text-primary">Submission</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-space-md">
          <div>
            <p className="font-label-sm text-label-sm uppercase text-on-surface-variant">Source (EN-US)</p>
            <p className="font-title-md text-title-md text-primary mt-space-xs">{task.sourceText}</p>
          </div>
          <div>
            <p className="font-label-sm text-label-sm uppercase text-on-surface-variant">Proposed target ({task.targetLanguage})</p>
            <p className="font-title-md text-title-md text-primary mt-space-xs">
              {task.submission?.text ?? "No demo submission yet."}
            </p>
            {task.submission ? <CopyButton value={task.submission.text} label="Copy translation" /> : null}
          </div>
        </div>
        {task.submission?.notes ? (
          <p className="font-body-md text-body-md text-on-surface-variant">Notes: {task.submission.notes}</p>
        ) : null}
        {task.decision ? (
          <div
            className={`p-space-md rounded ${
              task.decision.outcome === "approved" ? "bg-primary-fixed text-on-primary-fixed" : "bg-secondary-fixed text-on-secondary-fixed"
            }`}
          >
            <p className="font-title-lg text-title-lg uppercase">
              {task.decision.outcome === "approved" ? "Demo approved" : "Demo rejected"}
            </p>
            <p className="font-body-sm text-body-sm mt-space-xs">{task.decision.note}</p>
          </div>
        ) : null}
      </section>

      <section className="flex flex-col gap-space-md">
        <h2 className="font-headline-sm text-headline-sm uppercase text-primary">Tripartite status</h2>
        <StatusTriad task={task} />
      </section>

      <section className="bg-primary-container text-inverse-on-surface p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-md">
        <h2 className="font-headline-sm text-headline-sm uppercase">Simulate decision</h2>
        <p className="font-body-md text-body-md text-primary-fixed-dim max-w-3xl">
          This is a simulation, not GenLayer consensus. No validator scores, signatures, or payouts are produced.
          Approval adds a versioned string to the demo library and updates the in-app preview. Rejection leaves the
          library unchanged. No GEN is locked or paid.
        </p>
        {canSimulate ? (
          <div className="flex flex-wrap gap-space-sm">
            <button
              type="button"
              className="px-space-lg py-space-md bg-tertiary-fixed text-on-tertiary-fixed font-label-md text-label-md uppercase rounded shadow-[3px_3px_0px_#00170b]"
              onClick={() => runSimulation("approved")}
            >
              Simulate approval
            </button>
            <button
              type="button"
              className="px-space-lg py-space-md bg-secondary-container text-on-secondary-container font-label-md text-label-md uppercase rounded shadow-[3px_3px_0px_#00170b]"
              onClick={() => runSimulation("rejected")}
            >
              Simulate rejection
            </button>
          </div>
        ) : (
          <p className="font-body-sm text-body-sm text-tertiary-fixed">
            {task.status !== "submitted"
              ? "Simulation is available after a demo submission."
              : "Switch to the demo owner role to run the simulation control."}
          </p>
        )}
        {actionError ? (
          <p className="bg-error-container text-on-error-container p-space-md rounded font-body-sm text-body-sm">
            {actionError}
          </p>
        ) : null}
      </section>

      <AppPreview
        body={previewBody}
        locale={approvedHere ? task.targetLanguage : task.sourceLanguage}
        caption={
          approvedHere
            ? "Preview shows this task’s approved demo string. This is not a live onchain result."
            : task.status === "rejected"
              ? "Rejected submission is not shown as approved. Preview stays on the source string. Library unchanged."
              : "Preview is a CSS mock of in-app placement. It uses the source until this task is approved."
        }
      />

      {approvedHere && lib ? (
        <Link
          to="/demo/library"
          className="inline-flex items-center gap-space-sm font-label-md text-label-md uppercase text-secondary"
        >
          View this task in string library (demo v{lib.version} · {lib.locale})
          <Icon name="arrow_forward" />
        </Link>
      ) : (
        <Link to="/demo" className="inline-flex items-center gap-space-sm font-label-md text-label-md uppercase text-secondary">
          Back to task board
          <Icon name="arrow_forward" />
        </Link>
      )}
    </div>
  );
}
