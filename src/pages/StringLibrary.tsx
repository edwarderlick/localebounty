import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AppPreview } from "../components/AppPreview";
import { CopyButton } from "../components/CopyButton";
import { Icon } from "../components/Icon";
import { useDemo } from "../data/DemoContext";
import { formatActor } from "../lib/addresses";
import { LANGUAGES, MODULES, type LibraryEntry } from "../types";

export function StringLibrary() {
  const { state } = useDemo();
  const [query, setQuery] = useState("");
  const [locale, setLocale] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(state.library[0]?.id ?? null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return state.library.filter((entry) => {
      if (locale !== "all" && entry.locale !== locale) return false;
      if (!q) return true;
      return (
        entry.key.toLowerCase().includes(q) ||
        entry.sourceText.toLowerCase().includes(q) ||
        entry.translatedText.toLowerCase().includes(q) ||
        entry.locale.toLowerCase().includes(q)
      );
    });
  }, [state.library, query, locale]);

  const selected = filtered.find((e) => e.id === selectedId) ?? filtered[0] ?? null;

  return (
    <div className="w-full px-gutter py-space-xl max-w-7xl mx-auto flex flex-col gap-space-xl">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-space-md">
        <div className="max-w-3xl">
          <div className="flex flex-wrap items-center gap-space-sm mb-space-sm">
            <span className="inline-flex px-space-sm py-0.5 bg-tertiary-fixed text-on-tertiary-fixed font-label-sm text-label-sm uppercase rounded rotate-[-2deg] shadow-[2px_2px_0px_#00170b]">
              Demo library
            </span>
            <span className="font-label-sm text-label-sm uppercase text-on-surface-variant">
              Approved demo strings only
            </span>
          </div>
          <h1 className="font-headline-lg text-headline-lg-mobile md:text-headline-lg text-primary tracking-tight">
            Official string library
          </h1>
          <p className="font-body-lg text-body-lg text-on-surface-variant mt-space-xs">
            {state.library.length} versioned demo {state.library.length === 1 ? "entry" : "entries"} in this browser.
            Not a production corpus. No bounty payouts.
          </p>
        </div>
        <div className="flex flex-wrap gap-space-sm">
          <button
            type="button"
            disabled
            className="px-space-md py-space-sm bg-surface-container-high font-label-md text-label-md uppercase rounded opacity-60"
          >
            Sync with GitHub (future work)
          </button>
          <button
            type="button"
            disabled
            className="px-space-md py-space-sm bg-surface-container-high font-label-md text-label-md uppercase rounded opacity-60"
          >
            Export bundle (future work)
          </button>
        </div>
      </div>

      <div className="flex flex-col lg:flex-row gap-space-sm">
        <label className="flex-1 flex items-center gap-space-sm bg-surface-container-lowest px-space-md py-space-sm rounded shadow-[2px_2px_0px_#00170b]">
          <Icon name="search" />
          <input
            className="w-full bg-transparent outline-none font-body-md text-body-md"
            placeholder="Search key, source, or translation…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <select
          className="bg-surface-container-lowest px-space-md py-space-sm rounded shadow-[2px_2px_0px_#00170b] font-label-md text-label-md uppercase"
          value={locale}
          onChange={(e) => setLocale(e.target.value)}
        >
          <option value="all">All locales</option>
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
            </option>
          ))}
        </select>
      </div>

      <p className="font-body-sm text-body-sm text-on-surface-variant">
        Displaying {filtered.length} of {state.library.length} approved demo keys. Modules in this UI: {MODULES.join(", ")}.
      </p>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-space-xl items-start">
        <div className="lg:col-span-7 flex flex-col gap-space-md">
          {filtered.length === 0 ? (
            <p className="font-body-lg text-body-lg text-on-surface-variant">
              No approved demo strings match. Simulate an approval on a submitted task to add one.
            </p>
          ) : (
            filtered.map((entry, i) => (
              <LibraryRow
                key={entry.id}
                index={i + 1}
                entry={entry}
                active={selected?.id === entry.id}
                onSelect={() => setSelectedId(entry.id)}
              />
            ))
          )}
        </div>
        <aside className="lg:col-span-5 flex flex-col gap-space-md sticky top-24">
          {selected ? (
            <>
              <section className="bg-surface-container-lowest p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-sm">
                <div className="flex items-center justify-between">
                  <h2 className="font-headline-sm text-headline-sm uppercase text-primary">Selected key</h2>
                  <span className="font-label-sm text-label-sm uppercase bg-primary-fixed text-on-primary-fixed px-space-xs py-0.5 rounded">
                    v{selected.version} demo
                  </span>
                </div>
                <p className="font-title-md text-title-md text-primary break-all">{selected.key}</p>
                <CopyButton value={selected.key} label="Copy key" />
                <p className="font-body-md text-body-md">EN: {selected.sourceText}</p>
                <p className="font-body-md text-body-md">
                  {selected.locale}: {selected.translatedText}
                </p>
                <CopyButton value={selected.translatedText} label="Copy translation" />
                <p className="font-body-sm text-body-sm text-on-surface-variant">
                  Named translator {formatActor(selected.translatorAddress, selected.translatorLabel)}. Approval is a
                  demo simulation — not an onchain result. Payment status: Not available in demo.
                </p>
                <Link
                  to={`/demo/tasks/${selected.taskId}`}
                  className="font-label-md text-label-md uppercase text-secondary"
                >
                  Open source task
                </Link>
              </section>
              <AppPreview
                body={selected.translatedText}
                locale={selected.locale}
                caption="CSS mock. Injects the latest approved demo version for this key."
              />
            </>
          ) : (
            <p className="font-body-md text-body-md text-on-surface-variant">Select a demo string to preview.</p>
          )}
        </aside>
      </div>
    </div>
  );
}

function LibraryRow({
  entry,
  index,
  active,
  onSelect,
}: {
  entry: LibraryEntry;
  index: number;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`text-left bg-surface-container-lowest p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-sm ${
        active ? "ring-2 ring-primary" : ""
      }`}
    >
      <div className="flex items-center justify-between gap-space-sm">
        <span className="font-label-sm text-label-sm uppercase text-on-surface-variant">{String(index).padStart(2, "0")}</span>
        <span className="font-label-sm text-label-sm uppercase bg-primary-fixed text-on-primary-fixed px-space-xs py-0.5 rounded">
          v{entry.version} · {entry.locale}
        </span>
      </div>
      <p className="font-title-lg text-title-lg text-primary break-all">{entry.key}</p>
      <p className="font-body-sm text-body-sm text-on-surface-variant">EN · {entry.sourceText}</p>
      <p className="font-body-md text-body-md text-primary">{entry.translatedText}</p>
    </button>
  );
}
