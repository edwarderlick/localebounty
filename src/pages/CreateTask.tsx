import { FormEvent, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Icon } from "../components/Icon";
import { useDemo } from "../data/DemoContext";
import { DEMO_TRANSLATOR } from "../lib/addresses";
import { wordCount } from "../lib/status";
import { LANGUAGES } from "../types";

export function CreateTask() {
  const { addTask, role } = useDemo();
  const navigate = useNavigate();
  const [sourceText, setSourceText] = useState("");
  const [context, setContext] = useState("");
  const [meaning, setMeaning] = useState("");
  const [targetLanguage, setTargetLanguage] = useState("ES-ES");
  const [requirements, setRequirements] = useState<string[]>([""]);
  const [draftReq, setDraftReq] = useState("");
  const [translatorAddress, setTranslatorAddress] = useState(DEMO_TRANSLATOR.address);
  const [reward, setReward] = useState("150");
  const [errors, setErrors] = useState<string[]>([]);

  const chars = sourceText.length;
  const words = wordCount(sourceText);
  const rewardNum = Number(reward);
  const ownerOnly = role !== "owner";

  const previewLang = useMemo(
    () => LANGUAGES.find((l) => l.code === targetLanguage),
    [targetLanguage],
  );

  function addRequirement() {
    const value = draftReq.trim();
    if (!value) return;
    setRequirements((list) => [...list.filter(Boolean), value]);
    setDraftReq("");
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (ownerOnly) return;
    const filled = [...requirements, draftReq].map((r) => r.trim()).filter(Boolean);
    const result = addTask({
      sourceText,
      context,
      meaning,
      targetLanguage,
      requirements: filled,
      translatorAddress,
      intendedRewardGen: rewardNum,
    });
    if (result.errors.length || !result.task) {
      setErrors(result.errors);
      return;
    }
    navigate(`/demo/tasks/${result.task.id}`);
  }

  return (
    <div className="w-full px-gutter py-space-xl max-w-7xl mx-auto">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-space-md mb-space-2xl">
        <div className="flex flex-col gap-space-xs max-w-3xl">
          <div className="flex items-center gap-space-sm mb-space-xs">
            <span className="font-label-sm text-label-sm uppercase tracking-widest text-secondary font-bold">
              Demo form — no escrow
            </span>
            <span className="inline-flex items-center gap-1 px-space-sm py-0.5 bg-tertiary-fixed text-on-tertiary-fixed font-label-sm text-label-sm uppercase tracking-wider rounded shadow-[2px_2px_0px_#00170b] rotate-[-2deg]">
              <span className="w-1.5 h-1.5 rounded-full bg-primary-container" />
              Intended reward only
            </span>
          </div>
          <h1 className="font-display-lg text-display-lg-mobile md:text-display-lg text-primary tracking-tight leading-none uppercase">
            Create translation bounty
          </h1>
          <p className="font-body-lg text-body-lg text-on-surface-variant max-w-2xl mt-space-xs">
            Store a named-translator task in this browser. Nothing is locked onchain. Switch to the demo owner role
            to submit this form.
          </p>
        </div>
        <div className="flex items-center gap-space-sm bg-surface-container-high px-space-md py-space-sm rounded shadow-[2px_2px_0px_#00170b] flex-shrink-0">
          <Icon name="info" className="text-secondary-container" />
          <div className="flex flex-col text-left">
            <span className="font-label-sm text-label-sm text-on-surface-variant uppercase font-bold">Wallet</span>
            <span className="font-title-md text-title-md text-primary font-bold">Not connected (demo)</span>
          </div>
        </div>
      </div>

      {ownerOnly ? (
        <div className="mb-space-lg bg-secondary-fixed text-on-secondary-fixed p-space-md rounded shadow-[2px_2px_0px_#00170b]">
          You are viewing as the demo translator. Switch to the demo owner role to create a task.
        </div>
      ) : null}

      <form onSubmit={onSubmit} className="grid grid-cols-1 lg:grid-cols-12 gap-space-xl items-start">
        <div className="lg:col-span-7 flex flex-col gap-space-lg">
          <section className="bg-surface-container-lowest p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-md">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-space-xs">
                <span className="w-6 h-6 rounded bg-primary text-on-primary font-label-sm text-label-sm flex items-center justify-center font-bold">
                  01
                </span>
                <label className="font-headline-sm text-headline-sm text-primary uppercase" htmlFor="source-text">
                  Source text & context
                </label>
              </div>
              <span className="font-label-sm text-label-sm uppercase tracking-wider text-secondary font-bold bg-secondary-fixed px-space-sm py-0.5 rounded">
                {chars} chars · {words} words
              </span>
            </div>
            <div className="flex flex-col gap-space-xs">
              <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">
                Source string (UTF-8)
              </span>
              <div className="bg-surface-container-low rounded p-space-sm">
                <textarea
                  id="source-text"
                  rows={3}
                  disabled={ownerOnly}
                  className="w-full bg-transparent font-title-lg text-title-lg text-primary resize-none outline-none leading-relaxed"
                  placeholder="Enter string requiring translation…"
                  value={sourceText}
                  onChange={(e) => setSourceText(e.target.value)}
                />
              </div>
            </div>
            <div className="flex flex-col gap-space-xs">
              <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">
                Context / app placement
              </span>
              <div className="bg-surface-container-low rounded px-space-md py-space-sm">
                <input
                  className="w-full bg-transparent font-body-md text-body-md outline-none"
                  placeholder="e.g. Navigation drawer primary CTA…"
                  disabled={ownerOnly}
                  value={context}
                  onChange={(e) => setContext(e.target.value)}
                />
              </div>
            </div>
          </section>

          <section className="bg-surface-container-lowest p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-md">
            <div className="flex items-center gap-space-xs">
              <span className="w-6 h-6 rounded bg-primary text-on-primary font-label-sm text-label-sm flex items-center justify-center font-bold">
                02
              </span>
              <h2 className="font-headline-sm text-headline-sm text-primary uppercase">Language pair</h2>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-11 items-center gap-space-sm">
              <div className="sm:col-span-5 bg-surface-container-high rounded p-space-md">
                <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">
                  Source (locked)
                </span>
                <div className="flex items-center gap-space-sm mt-space-xs">
                  <span className="font-headline-sm text-headline-sm text-primary font-bold">EN-US</span>
                  <span className="font-body-md text-body-md text-on-surface-variant">English (United States)</span>
                </div>
              </div>
              <div className="sm:col-span-1 flex justify-center">
                <div className="w-8 h-8 rounded-full bg-secondary-container text-on-secondary-container flex items-center justify-center shadow-[2px_2px_0px_#00170b]">
                  <Icon name="arrow_forward" className="text-sm" />
                </div>
              </div>
              <div className="sm:col-span-5 bg-surface-container-low rounded p-space-md shadow-[2px_2px_0px_#00170b]">
                <span className="font-label-sm text-label-sm uppercase tracking-wider text-secondary font-bold">
                  Target locale
                </span>
                <select
                  className="mt-space-xs w-full bg-transparent font-headline-sm text-headline-sm text-primary outline-none"
                  disabled={ownerOnly}
                  value={targetLanguage}
                  onChange={(e) => setTargetLanguage(e.target.value)}
                >
                  {LANGUAGES.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.code} — {l.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </section>

          <section className="bg-surface-container-lowest p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-md">
            <div className="flex items-center gap-space-xs">
              <span className="w-6 h-6 rounded bg-primary text-on-primary font-label-sm text-label-sm flex items-center justify-center font-bold">
                03
              </span>
              <label className="font-headline-sm text-headline-sm text-primary uppercase" htmlFor="semantic-guidance">
                Intended meaning
              </label>
            </div>
            <div className="bg-surface-container-low rounded p-space-md">
              <textarea
                id="semantic-guidance"
                rows={2}
                disabled={ownerOnly}
                className="w-full bg-transparent font-body-md text-body-md text-primary resize-none outline-none"
                placeholder="Explain nuances the translator must preserve…"
                value={meaning}
                onChange={(e) => setMeaning(e.target.value)}
              />
            </div>
          </section>

          <section className="bg-surface-container-lowest p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-md">
            <div className="flex items-center gap-space-xs">
              <span className="w-6 h-6 rounded bg-primary text-on-primary font-label-sm text-label-sm flex items-center justify-center font-bold">
                04
              </span>
              <h2 className="font-headline-sm text-headline-sm text-primary uppercase">Requirements</h2>
            </div>
            <div className="flex flex-col gap-space-sm">
              {requirements.filter(Boolean).map((req, i) => (
                <div key={`${req}-${i}`} className="flex items-center justify-between bg-surface-container-low p-space-sm rounded gap-space-sm">
                  <div className="flex items-center gap-space-sm">
                    <span className="w-4 h-4 bg-primary text-on-primary rounded flex items-center justify-center text-[10px] font-bold">
                      {i + 1}
                    </span>
                    <span className="font-body-md text-body-md text-primary">{req}</span>
                  </div>
                  <button
                    type="button"
                    className="font-label-sm text-label-sm uppercase"
                    disabled={ownerOnly}
                    onClick={() => setRequirements((list) => list.filter((_, idx) => idx !== i))}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
            <div className="flex gap-space-xs pt-space-xs">
              <input
                className="flex-1 bg-surface-container-low px-space-md py-space-xs rounded font-body-sm text-body-sm outline-none"
                placeholder="+ Add a requirement…"
                disabled={ownerOnly}
                value={draftReq}
                onChange={(e) => setDraftReq(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addRequirement();
                  }
                }}
              />
              <button
                type="button"
                className="px-space-md py-space-xs bg-surface-container-highest text-primary font-label-md text-label-md uppercase rounded"
                disabled={ownerOnly}
                onClick={addRequirement}
              >
                Add
              </button>
            </div>
          </section>

          <section className="bg-surface-container-lowest p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-md">
            <div className="flex items-center gap-space-xs">
              <span className="w-6 h-6 rounded bg-primary text-on-primary font-label-sm text-label-sm flex items-center justify-center font-bold">
                05
              </span>
              <label className="font-headline-sm text-headline-sm text-primary uppercase" htmlFor="translator-wallet">
                Named translator address
              </label>
            </div>
            <div className="flex items-center justify-between bg-surface-container-low rounded p-space-sm gap-space-sm">
              <input
                id="translator-wallet"
                className="font-label-md text-label-md text-primary bg-transparent outline-none w-full"
                placeholder="0x… or elena.eth"
                disabled={ownerOnly}
                value={translatorAddress}
                onChange={(e) => setTranslatorAddress(e.target.value)}
              />
              <button
                type="button"
                className="flex-shrink-0 bg-tertiary-fixed text-on-tertiary-fixed px-space-sm py-0.5 rounded font-label-sm text-label-sm font-bold shadow-[1px_1px_0px_#00170b]"
                disabled={ownerOnly}
                onClick={() => setTranslatorAddress(DEMO_TRANSLATOR.address)}
              >
                Use demo translator
              </button>
            </div>
            <p className="font-body-sm text-body-sm text-on-surface-variant">
              This demo can only name Elena ({DEMO_TRANSLATOR.short} or elena.eth). That is the Translator role in
              the header — not a connected wallet. Other 0x addresses cannot be submitted here, so every created task
              can be completed by switching Owner / Translator.
            </p>
          </section>

          <section className="bg-surface-container-lowest p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-md">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-space-xs">
                <span className="w-6 h-6 rounded bg-primary text-on-primary font-label-sm text-label-sm flex items-center justify-center font-bold">
                  06
                </span>
                <label className="font-headline-sm text-headline-sm text-primary uppercase" htmlFor="reward-input">
                  Intended GEN reward
                </label>
              </div>
              <span className="font-label-sm text-label-sm uppercase text-on-surface-variant font-bold">
                No wallet balance in demo
              </span>
            </div>
            <div className="relative bg-surface-container-low rounded p-space-sm flex items-center">
              <input
                id="reward-input"
                type="number"
                min={1}
                step={1}
                disabled={ownerOnly}
                className="w-full bg-transparent font-headline-lg text-headline-lg text-primary outline-none font-bold"
                value={reward}
                onChange={(e) => setReward(e.target.value)}
              />
              <span className="font-headline-sm text-headline-sm text-secondary uppercase font-bold pr-space-sm">GEN</span>
            </div>
            <p className="font-body-sm text-body-sm text-on-surface-variant">
              Display-only intended amount. There is no USD conversion, protocol fee, or escrow lock in this demo.
            </p>
          </section>

          {errors.length ? (
            <ul className="bg-error-container text-on-error-container p-space-md rounded font-body-sm text-body-sm list-disc pl-space-lg">
              {errors.map((err) => (
                <li key={err}>{err}</li>
              ))}
            </ul>
          ) : null}
        </div>

        <aside className="lg:col-span-5 sticky top-24 flex flex-col gap-space-md">
          <div className="bg-primary-container text-on-primary rounded p-space-xl shadow-[6px_6px_0px_#00170b] relative overflow-hidden">
            <div className="absolute top-0 right-0 flex">
              <div className="w-4 h-4 bg-tertiary-fixed" />
              <div className="w-4 h-4 bg-secondary-container" />
              <div className="w-4 h-4 bg-surface-container-lowest" />
            </div>
            <div className="flex items-start justify-between gap-space-sm pb-space-lg mb-space-lg border-b border-primary-fixed-dim/20">
              <div className="flex flex-col">
                <span className="font-label-sm text-label-sm uppercase tracking-widest text-tertiary-fixed font-bold">
                  Demo summary
                </span>
                <h2 className="font-headline-md text-headline-md tracking-tight uppercase text-surface-container-lowest">
                  Intended reward
                </h2>
              </div>
              <span className="px-space-sm py-1 bg-secondary-container text-on-secondary-container font-label-sm text-label-sm uppercase tracking-wider rounded font-bold shadow-[2px_2px_0px_#00170b] rotate-[3deg]">
                Not locked
              </span>
            </div>
            <div className="flex flex-col gap-space-md font-body-md text-body-md">
              <Row label="Intended translator reward" hint="Saved locally only" value={`${Number.isFinite(rewardNum) ? rewardNum : "—"} GEN`} />
              <Row label="Protocol fee" hint="Not calculated in demo" value="Not available in demo" />
              <Row label="GEN / USD" hint="No live quote" value="Not available in demo" />
              <Row label="Target locale" hint="Named translator exclusivity" value={previewLang ? previewLang.code : "—"} />
            </div>
            <p className="mt-space-lg font-body-sm text-body-sm text-primary-fixed-dim">
              Creating this task does not deposit, lock, or transfer GEN. Transaction status remains “Not available
              in demo”.
            </p>
            <button
              className="mt-space-lg w-full py-space-md px-space-lg bg-secondary-container text-on-secondary-container font-headline-sm text-title-lg uppercase rounded shadow-[4px_4px_0px_#00170b] hover:bg-secondary hover:text-on-secondary disabled:opacity-50 flex items-center justify-center gap-space-sm"
              type="submit"
              disabled={ownerOnly}
            >
              <Icon name="save" />
              Save demo task
            </button>
          </div>
        </aside>
      </form>
    </div>
  );
}

function Row({ label, hint, value }: { label: string; hint: string; value: string }) {
  return (
    <div className="flex items-center justify-between pb-space-sm border-b border-primary-fixed-dim/15 gap-space-sm">
      <div className="flex flex-col">
        <span className="font-title-md text-title-md text-surface-container-lowest font-bold">{label}</span>
        <span className="font-body-sm text-body-sm text-primary-fixed-dim">{hint}</span>
      </div>
      <span className="font-title-lg text-title-lg text-surface-container-lowest font-bold text-right">{value}</span>
    </div>
  );
}
