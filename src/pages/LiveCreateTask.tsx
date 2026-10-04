import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Icon } from "../components/Icon";
import { WriteAttemptHistory } from "../components/WriteAttemptHistory";
import { WalletCard } from "../live/WalletCard";
import { isUserRejection } from "../live/eip1193";
import { FEE_DEPOSIT_LABEL, formatError, formatGen } from "../live/format";
import { genToWei } from "../live/product/task";
import { PRODUCT_UI_CONTRACT } from "../live/productUi/constants";
import {
  createNavigateReady,
  estimateCreate,
  signCreateBlocker,
  submitCreateTx,
  trackCreateTx,
} from "../live/productUi/createFlow";
import { createFormErrors, expectedWalletSpendWei, formFingerprint, type CreateForm } from "../live/productUi/form";
import { createSignAllowed, needsCreateTxResume, neverResubmit } from "../live/productUi/guards";
import { applyTxSignCatch } from "../live/productUi/attemptHistory";
import {
  loadProductUiSession,
  resetProductUiTransientPhases,
  saveProductUiSession,
  startNewCreateAttempt,
  type ProductUiSession,
} from "../live/productUi/persist";
import { slugFromText, wordCount } from "../lib/status";
import { liveTaskHref } from "../lib/paths";
import { useWallet } from "../live/WalletContext";
import { LANGUAGES } from "../types";

export function LiveCreateTask() {
  const wallet = useWallet();
  const navigate = useNavigate();
  const [session, setSession] = useState<ProductUiSession>(() => resetProductUiTransientPhases(loadProductUiSession()));
  const [form, setForm] = useState<CreateForm>(() => loadProductUiSession().form);
  const [errors, setErrors] = useState<string[]>([]);
  const resumeOnce = useRef(false);

  const persist = useCallback((next: ProductUiSession) => {
    saveProductUiSession(next);
    setSession(next);
    return next;
  }, []);

  useEffect(() => {
    persist(resetProductUiTransientPhases(loadProductUiSession()));
  }, [persist]);

  useEffect(() => {
    if (resumeOnce.current) return;
    resumeOnce.current = true;
    const stored = loadProductUiSession();
    if (stored.create.txId && needsCreateTxResume(stored)) {
      void trackCreateTx(stored, stored.create.txId, persist).then((next) => {
        const ready = createNavigateReady(next);
        if (ready.ok && next.navigatedTaskId !== ready.taskId) {
          persist({ ...next, navigatedTaskId: ready.taskId, lastOpenedTaskId: ready.taskId });
          navigate(liveTaskHref(ready.taskId));
        }
      });
    } else if (stored.create.txId && stored.create.statusName === "FINALIZED" && stored.create.parentSuccessful) {
      void trackCreateTx(stored, stored.create.txId, persist);
    }
  }, [navigate, persist]);

  const locked = Boolean(session.create.txId);
  const rewardWei = locked
    ? session.boundRewardWei
      ? BigInt(session.boundRewardWei)
      : genToWei(form.rewardGen)
    : genToWei(form.rewardGen);
  const feeDepositWei = session.create.quotedFeeWei ? BigInt(session.create.quotedFeeWei) : null;
  const spendWei = rewardWei != null && feeDepositWei != null ? expectedWalletSpendWei(rewardWei, feeDepositWei) : null;
  const formErrs = createFormErrors(form, wallet.address);
  const signGuard = createSignAllowed(
    session,
    { funder: wallet.address, chainId: wallet.chainId, connected: wallet.connected },
    form,
  );
  const fingerprintChanged = Boolean(session.formFingerprint && session.formFingerprint !== formFingerprint(form) && !locked);

  const previewLang = useMemo(
    () => LANGUAGES.find((l) => l.code === form.targetLocale),
    [form.targetLocale],
  );

  function patchForm(partial: Partial<CreateForm>) {
    if (locked) return;
    setForm((current) => ({ ...current, ...partial }));
  }

  async function onEstimate() {
    setErrors(formErrs);
    if (formErrs.length) return;
    try {
      const identity = await wallet.verifyBeforeWrite();
      const next = await estimateCreate({
        session: { ...loadProductUiSession(), form },
        form,
        identity,
      });
      persist(next);
    } catch (err) {
      persist({
        ...loadProductUiSession(),
        create: {
          ...loadProductUiSession().create,
          phase: "idle",
          error: isUserRejection(err) ? "Wallet rejected the fee estimate." : formatError(err),
        },
      });
    }
  }

  async function onSign() {
    if (neverResubmit(session.create) === "resume") {
      if (session.create.txId) {
        const next = await trackCreateTx(loadProductUiSession(), session.create.txId, persist);
        const ready = createNavigateReady(next);
        if (ready.ok && next.navigatedTaskId !== ready.taskId) {
          persist({ ...next, navigatedTaskId: ready.taskId, lastOpenedTaskId: ready.taskId });
          navigate(liveTaskHref(ready.taskId));
        }
      }
      return;
    }
    setErrors(formErrs);
    if (formErrs.length) return;
    try {
      const identity = await wallet.verifyBeforeWrite();
      const latest = { ...loadProductUiSession(), form };
      const blocker = signCreateBlocker({ session: latest, form, identity });
      if (!blocker.ok) {
        persist(blocker.session);
        return;
      }
      if (!wallet.provider) throw new Error("Connect a wallet before signing.");
      persist({ ...latest, create: { ...latest.create, phase: "signing", error: undefined } });
      const submitted = await submitCreateTx({
        session: latest,
        form,
        identity,
        provider: wallet.provider,
        estimate: blocker.estimate,
        value: blocker.value,
      });
      persist(submitted.session);
      const tracked = await trackCreateTx(submitted.session, submitted.txId, persist);
      const ready = createNavigateReady(tracked);
      if (ready.ok) {
        persist({ ...tracked, navigatedTaskId: ready.taskId, lastOpenedTaskId: ready.taskId });
        navigate(liveTaskHref(ready.taskId));
      }
    } catch (err) {
      const live = loadProductUiSession();
      persist({
        ...live,
        create: applyTxSignCatch(live.create, err),
      });
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (session.create.phase === "quoted" && signGuard.ok) void onSign();
    else void onEstimate();
  }

  const chars = form.sourceText.length;
  const words = wordCount(form.sourceText);
  const readyNav = createNavigateReady(session);

  return (
    <div className="w-full px-gutter py-space-xl max-w-7xl mx-auto">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-space-md mb-space-2xl">
        <div className="flex flex-col gap-space-xs max-w-3xl">
          <div className="flex items-center gap-space-sm mb-space-xs">
            <span className="font-label-sm text-label-sm uppercase tracking-widest text-secondary font-bold">
              Live create_task
            </span>
            <span className="inline-flex items-center gap-1 px-space-sm py-0.5 bg-tertiary-fixed text-on-tertiary-fixed font-label-sm text-label-sm uppercase tracking-wider rounded shadow-[2px_2px_0px_#00170b] rotate-[-2deg]">
              <span className="w-1.5 h-1.5 rounded-full bg-primary-container" />
              Studio-dev 61997
            </span>
          </div>
          <h1 className="font-display-lg text-display-lg-mobile md:text-display-lg text-primary tracking-tight leading-none uppercase">
            Create translation bounty
          </h1>
          <p className="font-body-lg text-body-lg text-on-surface-variant max-w-2xl mt-space-xs">
            Attaches a GEN reward to {PRODUCT_UI_CONTRACT.slice(0, 8)}…{PRODUCT_UI_CONTRACT.slice(-4)} and names any
            valid translator EOA. Estimate binds a fresh client_nonce and Studio-dev deadlines. Signing is not done
            until you confirm in the wallet. While the task stays open with no stored translation, this funder may
            still cancel_task and reclaim the attached reward.
          </p>
        </div>
      </div>

      <div className="mb-space-lg">
        <WalletCard />
      </div>

      {session.create.txId ? (
        <div className="mb-space-lg bg-surface-container-high p-space-md rounded shadow-[2px_2px_0px_#00170b] flex flex-col gap-space-xs">
          <p className="font-title-md text-title-md text-primary">Create transaction stored</p>
          <p className="font-body-sm text-body-sm break-all">tx {session.create.txId}</p>
          <p className="font-body-sm text-body-sm">
            Consensus {session.create.statusName ?? "unknown"} · Execution {session.create.executionName ?? "unknown"} ·
            isSuccessful {String(Boolean(session.create.parentSuccessful))}
          </p>
          {readyNav.ok ? (
            <Link to={liveTaskHref(readyNav.taskId)} className="font-label-md text-label-md uppercase text-secondary">
              Open task {readyNav.taskId.slice(0, 12)}…
            </Link>
          ) : (
            <p className="font-body-sm text-body-sm text-on-surface-variant">{readyNav.reason}</p>
          )}
          {session.create.statusName === "FINALIZED" ? (
            <button
              type="button"
              className="self-start font-label-sm text-label-sm uppercase text-primary underline"
              onClick={() => {
                const next = startNewCreateAttempt(loadProductUiSession());
                persist(next);
                setForm(next.form);
              }}
            >
              Start another create
            </button>
          ) : (
            <p className="font-body-sm text-body-sm">Tracking this hash after reload. It will not be resubmitted.</p>
          )}
        </div>
      ) : null}
      {session.createAttemptHistory?.length ? (
        <div className="mb-space-lg">
          <WriteAttemptHistory entries={session.createAttemptHistory} currentTxId={session.create.txId} />
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
                  disabled={locked}
                  className="w-full bg-transparent font-title-lg text-title-lg text-primary resize-none outline-none leading-relaxed"
                  placeholder="Enter string requiring translation…"
                  value={form.sourceText}
                  onChange={(e) => {
                    const sourceText = e.target.value;
                    const stringKey = form.stringKey || slugFromText(sourceText);
                    patchForm({ sourceText, stringKey });
                  }}
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
                  disabled={locked}
                  value={form.appContext}
                  onChange={(e) => patchForm({ appContext: e.target.value })}
                />
              </div>
            </div>
            <div className="flex flex-col gap-space-xs">
              <span className="font-label-sm text-label-sm uppercase tracking-wider text-on-surface-variant">
                String key
              </span>
              <input
                className="w-full bg-surface-container-low px-space-md py-space-sm rounded font-body-md text-body-md outline-none"
                disabled={locked}
                value={form.stringKey}
                onChange={(e) => patchForm({ stringKey: e.target.value })}
              />
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
                  Source locale
                </span>
                <input
                  className="mt-space-xs w-full bg-transparent font-headline-sm text-headline-sm text-primary outline-none"
                  disabled={locked}
                  value={form.sourceLocale}
                  onChange={(e) => patchForm({ sourceLocale: e.target.value })}
                />
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
                  disabled={locked}
                  value={form.targetLocale}
                  onChange={(e) => patchForm({ targetLocale: e.target.value })}
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
                disabled={locked}
                className="w-full bg-transparent font-body-md text-body-md text-primary resize-none outline-none"
                placeholder="Explain nuances the translator must preserve…"
                value={form.intendedMeaning}
                onChange={(e) => patchForm({ intendedMeaning: e.target.value })}
              />
            </div>
          </section>

          <section className="bg-surface-container-lowest p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-md">
            <div className="flex items-center gap-space-xs">
              <span className="w-6 h-6 rounded bg-primary text-on-primary font-label-sm text-label-sm flex items-center justify-center font-bold">
                04
              </span>
              <label className="font-headline-sm text-headline-sm text-primary uppercase" htmlFor="criteria">
                Semantic criteria
              </label>
            </div>
            <textarea
              id="criteria"
              rows={3}
              disabled={locked}
              className="w-full bg-surface-container-low p-space-md rounded font-body-md text-body-md outline-none"
              placeholder="Requirements the translator and later evaluation must honor…"
              value={form.semanticCriteria}
              onChange={(e) => patchForm({ semanticCriteria: e.target.value })}
            />
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
            <input
              id="translator-wallet"
              className="font-label-md text-label-md text-primary bg-surface-container-low rounded p-space-sm outline-none w-full"
              placeholder="0x…"
              disabled={locked}
              value={form.translator}
              onChange={(e) => patchForm({ translator: e.target.value.trim() })}
            />
            <p className="font-body-sm text-body-sm text-on-surface-variant">
              Any valid 20-byte EOA except the connected funder. Demo Elena is not required and is not authorization.
            </p>
          </section>

          <section className="bg-surface-container-lowest p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-md">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-space-xs">
                <span className="w-6 h-6 rounded bg-primary text-on-primary font-label-sm text-label-sm flex items-center justify-center font-bold">
                  06
                </span>
                <label className="font-headline-sm text-headline-sm text-primary uppercase" htmlFor="reward-input">
                  Attached GEN reward
                </label>
              </div>
              <span className="font-label-sm text-label-sm uppercase text-on-surface-variant font-bold">
                Exact 18 decimals
              </span>
            </div>
            <div className="relative bg-surface-container-low rounded p-space-sm flex items-center">
              <input
                id="reward-input"
                inputMode="decimal"
                disabled={locked}
                className="w-full bg-transparent font-headline-lg text-headline-lg text-primary outline-none font-bold"
                value={form.rewardGen}
                onChange={(e) => patchForm({ rewardGen: e.target.value })}
                placeholder="0.5"
              />
              <span className="font-headline-sm text-headline-sm text-secondary uppercase font-bold pr-space-sm">GEN</span>
            </div>
            <p className="font-body-sm text-body-sm text-on-surface-variant">
              This value is the payable create amount. It is separate from the protocol fee deposit.
            </p>
          </section>

          {errors.length ? (
            <ul className="bg-error-container text-on-error-container p-space-md rounded font-body-sm text-body-sm list-disc pl-space-lg">
              {errors.map((err) => (
                <li key={err}>{err}</li>
              ))}
            </ul>
          ) : null}
          {session.create.error ? (
            <p className="bg-error-container text-on-error-container p-space-md rounded font-body-sm text-body-sm">
              {session.create.error}
            </p>
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
                  Wallet spend
                </span>
                <h2 className="font-headline-md text-headline-md tracking-tight uppercase text-surface-container-lowest">
                  Reward + fee deposit
                </h2>
              </div>
              <span className="px-space-sm py-1 bg-secondary-container text-on-secondary-container font-label-sm text-label-sm uppercase tracking-wider rounded font-bold shadow-[2px_2px_0px_#00170b] rotate-[3deg]">
                {session.create.phase === "quoted" ? "Quoted" : locked ? "Tracking" : "Estimate first"}
              </span>
            </div>
            <div className="flex flex-col gap-space-md font-body-md text-body-md">
              <Row
                label="Attached reward"
                hint="create_task value"
                value={rewardWei != null ? formatGen(rewardWei) : "—"}
              />
              <Row
                label={FEE_DEPOSIT_LABEL}
                hint="Required upfront; unused deposit is returned"
                value={feeDepositWei != null ? formatGen(feeDepositWei) : "Not quoted"}
              />
              <Row
                label="Expected wallet spend"
                hint="Reward + fee deposit before unused return"
                value={spendWei != null ? formatGen(spendWei) : "Quote to see total"}
              />
              <Row label="Target locale" hint="Named translator exclusivity" value={previewLang ? previewLang.code : form.targetLocale || "—"} />
              <Row
                label="client_nonce"
                hint="Fresh per unsubmitted create"
                value={session.clientNonce ? `${session.clientNonce.slice(0, 8)}…` : "Bound on Estimate"}
              />
            </div>
            {fingerprintChanged ? (
              <p className="mt-space-md font-body-sm text-body-sm text-tertiary-fixed">
                Form changed since the last quote. Estimate again before signing.
              </p>
            ) : null}
            <p className="mt-space-lg font-body-sm text-body-sm text-primary-fixed-dim">
              Recheck account, chain, form values, and quote before the wallet prompt. Navigate to Task Detail only
              after FINALIZED, successful execution, and an exact get_task match.
            </p>
            <button
              className="mt-space-sm w-full py-space-md px-space-lg bg-surface-container text-on-surface font-headline-sm text-title-lg uppercase rounded shadow-[4px_4px_0px_#00170b] disabled:opacity-50 flex items-center justify-center gap-space-sm"
              type="button"
              disabled={locked || session.create.phase === "quoting"}
              onClick={() => void onEstimate()}
            >
              <Icon name="calculate" />
              {session.create.phase === "quoting" ? "Estimating…" : "Estimate fee"}
            </button>
            <button
              className="mt-space-sm w-full py-space-md px-space-lg bg-secondary-container text-on-secondary-container font-headline-sm text-title-lg uppercase rounded shadow-[4px_4px_0px_#00170b] hover:bg-secondary hover:text-on-secondary disabled:opacity-50 flex items-center justify-center gap-space-sm"
              type="submit"
              disabled={locked ? neverResubmit(session.create) !== "resume" : !signGuard.ok || session.create.phase === "signing"}
            >
              <Icon name="draw" />
              {locked ? "Resume tracking" : session.create.phase === "signing" ? "Waiting for wallet…" : "Sign create_task"}
            </button>
            {!signGuard.ok && !locked ? (
              <p className="mt-space-sm font-body-sm text-body-sm text-primary-fixed-dim">{signGuard.reason}</p>
            ) : null}
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
      <span className="font-title-lg text-title-lg text-surface-container-lowest font-bold text-right break-all">{value}</span>
    </div>
  );
}
