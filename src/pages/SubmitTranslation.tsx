import { FormEvent, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { CopyButton } from "../components/CopyButton";
import { Icon } from "../components/Icon";
import { StatusPill } from "../components/StatusPill";
import { useDemo } from "../data/DemoContext";
import { shortenAddress } from "../lib/addresses";
import { useTaskParam } from "./useTask";

export function SubmitTranslation() {
  const { task } = useTaskParam();
  const { canSubmitTask, namedTranslator, submit } = useDemo();
  const navigate = useNavigate();
  const [text, setText] = useState(task?.submission?.text ?? "");
  const [notes, setNotes] = useState(task?.submission?.notes ?? "");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setText(task?.submission?.text ?? "");
    setNotes(task?.submission?.notes ?? "");
    setError(null);
  }, [task?.id, task?.submission?.text, task?.submission?.notes]);

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

  const writable = canSubmitTask(task);
  const chars = text.length;

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!task || !writable) return;
    if (!text.trim()) {
      setError("Translation text is required.");
      return;
    }
    const err = submit(task.id, text, notes);
    if (err) {
      setError(err);
      return;
    }
    navigate(`/tasks/${task.id}/decision`);
  }

  return (
    <div className="w-full px-gutter py-space-xl max-w-7xl mx-auto flex flex-col gap-space-xl">
      <div className="flex flex-wrap items-center justify-between gap-space-md">
        <Link to={`/demo/tasks/${task.id}`} className="inline-flex items-center gap-1 font-label-sm text-label-sm uppercase text-on-surface-variant hover:text-primary">
          <Icon name="arrow_back" className="text-sm" />
          Back to task detail
        </Link>
        <div className="flex items-center gap-space-sm">
          <StatusPill status={task.status} />
          <span className="font-label-sm text-label-sm uppercase bg-tertiary-fixed text-on-tertiary-fixed px-space-sm py-0.5 rounded shadow-[2px_2px_0px_#00170b] rotate-[-2deg]">
            Demo mode
          </span>
        </div>
      </div>

      <div className="flex flex-col md:flex-row md:items-end justify-between gap-space-md">
        <div>
          <h1 className="font-display-lg text-display-lg-mobile md:text-headline-lg text-primary uppercase tracking-tight">
            Submit translation
          </h1>
          <p className="font-body-lg text-body-lg text-on-surface-variant mt-space-xs">
            {task.id} · Intended reward {task.intendedRewardGen} GEN (not paid)
          </p>
        </div>
        <CopyButton value={task.id} label="Copy task id" />
      </div>

      {!writable ? (
        <div className="bg-surface-container-high p-space-md rounded shadow-[2px_2px_0px_#00170b]">
          <p className="font-title-md text-title-md text-primary">Read-only view</p>
          <p className="font-body-md text-body-md text-on-surface-variant mt-space-xs">
            {namedTranslator(task)
              ? "This demo task is not open for a new submission."
              : `Only the named translator ${shortenAddress(task.translatorAddress)} can submit. Switch to the demo translator role if you are Elena on this task.`}
          </p>
        </div>
      ) : null}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-space-xl">
        <div className="lg:col-span-5 flex flex-col gap-space-md">
          <section className="bg-surface-container-lowest p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-md">
            <h2 className="font-headline-sm text-headline-sm uppercase text-primary">Source & directives</h2>
            <p className="font-label-sm text-label-sm uppercase text-on-surface-variant">Target: {task.targetLanguage}</p>
            <blockquote className="font-title-lg text-title-lg text-primary border-l-4 border-l-secondary-container pl-space-md italic">
              “{task.sourceText}”
            </blockquote>
            <p className="font-body-md text-body-md text-on-surface-variant">{task.context}</p>
            <ul className="flex flex-col gap-space-sm">
              {task.requirements.map((req) => (
                <li key={req} className="bg-surface-container-low p-space-sm rounded font-body-sm text-body-sm">
                  {req}
                </li>
              ))}
            </ul>
          </section>
        </div>

        <form onSubmit={onSubmit} className="lg:col-span-7 flex flex-col gap-space-md">
          <section className="bg-surface-container-lowest p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-md">
            <div className="flex items-center justify-between">
              <h2 className="font-headline-sm text-headline-sm uppercase text-primary">Target string</h2>
              <span className="font-label-sm text-label-sm uppercase text-on-surface-variant">{chars} chars</span>
            </div>
            <textarea
              rows={4}
              readOnly={!writable}
              className="w-full bg-surface-container-low p-space-md font-title-lg text-title-lg text-primary outline-none rounded resize-y"
              placeholder="Write the translation…"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <CopyButton value={text} label="Copy translation" />
            <label className="flex flex-col gap-space-xs">
              <span className="font-label-sm text-label-sm uppercase text-on-surface-variant">Translator notes (optional)</span>
              <textarea
                rows={3}
                readOnly={!writable}
                className="w-full bg-surface-container-low p-space-md font-body-md text-body-md outline-none rounded"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </label>
          </section>

          <section className="bg-primary-container text-inverse-on-surface p-space-lg rounded shadow-[4px_4px_0px_#00170b]">
            <p className="font-title-md text-title-md">No proof gas, broadcast, or validator stream</p>
            <p className="font-body-sm text-body-sm text-primary-fixed-dim mt-space-xs">
              Submit stores the string in localStorage. It does not call a contract or GenLayer validators.
            </p>
          </section>

          {error ? (
            <p className="bg-error-container text-on-error-container p-space-md rounded font-body-sm text-body-sm">{error}</p>
          ) : null}

          <div className="flex flex-wrap gap-space-sm">
            <Link
              to={`/demo/tasks/${task.id}`}
              className="px-space-lg py-space-md bg-surface-container-high font-label-md text-label-md uppercase rounded"
            >
              Cancel
            </Link>
            <button
              type="submit"
              disabled={!writable}
              className="px-space-lg py-space-md bg-secondary-container text-on-secondary-container font-headline-sm text-title-lg uppercase rounded shadow-[4px_4px_0px_#00170b] disabled:opacity-50"
            >
              Save demo submission
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
