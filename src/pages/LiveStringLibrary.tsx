import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AppPreview } from "../components/AppPreview";
import { CopyButton } from "../components/CopyButton";
import { Icon } from "../components/Icon";
import { formatError } from "../live/format";
import type { LibraryEntry } from "../live/productB1/library";
import { PRODUCT_UI_CONTRACT } from "../live/productUi/constants";
import {
  discoverLibraryPage,
  encodeLibraryPair,
  encodeLibraryVersionKey,
  loadMoreVersionsForPair,
  loadNextVersionPageForIncompleteGroups,
  type LibraryDiscovery,
  type LiveLibraryGroup,
} from "../live/productUi/libraryDiscover";
import { formatUnix } from "../live/productUi/status";
import { demoHref, liveTaskHref } from "../lib/paths";

export function LiveStringLibrary() {
  const [query, setQuery] = useState("");
  const [locale, setLocale] = useState("all");
  const [discovery, setDiscovery] = useState<LibraryDiscovery | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingPair, setLoadingPair] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void discoverLibraryPage(0)
      .then((next) => {
        if (cancelled) return;
        setDiscovery(next);
        setError(null);
        const first = next.groups[0]?.versions[next.groups[0].versions.length - 1];
        setSelectedKey(first ? encodeLibraryVersionKey(first.string_key, first.locale, first.version) : null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(formatError(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const visibleGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (discovery?.groups ?? [])
      .map((group) => {
        const versions = group.versions.filter((entry) => {
          if (locale !== "all" && entry.locale !== locale) return false;
          if (!q) return true;
          return (
            entry.string_key.toLowerCase().includes(q) ||
            entry.source_text.toLowerCase().includes(q) ||
            entry.translation.toLowerCase().includes(q) ||
            entry.locale.toLowerCase().includes(q) ||
            entry.task_id.toLowerCase().includes(q)
          );
        });
        return { group, versions };
      })
      .filter(({ group, versions }) => versions.length > 0 || (!group.versionsComplete && locale === "all" && !q));
  }, [discovery, query, locale]);

  const versions = useMemo(
    () => visibleGroups.flatMap(({ versions: rows }) => rows),
    [visibleGroups],
  );

  const locales = useMemo(() => {
    const set = new Set((discovery?.groups ?? []).map((g) => g.locale));
    return [...set].sort();
  }, [discovery]);

  const selected =
    versions.find((e) => encodeLibraryVersionKey(e.string_key, e.locale, e.version) === selectedKey) ??
    versions[0] ??
    null;
  const selectedGroup = selected
    ? discovery?.groups.find((g) => g.string_key === selected.string_key && g.locale === selected.locale)
    : null;

  async function onLoadMoreTaskPages() {
    if (!discovery?.moreAvailable) return;
    setLoadingMore(true);
    try {
      const next = await discoverLibraryPage(discovery.pagesFromEnd + 1, discovery);
      setDiscovery(next);
      setError(null);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoadingMore(false);
    }
  }

  async function onLoadMoreForPair(group: LiveLibraryGroup) {
    if (!discovery || group.versionsComplete) return;
    const id = encodeLibraryPair(group.string_key, group.locale);
    setLoadingPair(id);
    try {
      const next = await loadMoreVersionsForPair(discovery, group.string_key, group.locale);
      setDiscovery(next);
      setError(groupError(next, group.string_key, group.locale));
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoadingPair(null);
    }
  }

  async function onLoadNextIncompletePages() {
    if (!discovery) return;
    setLoadingMore(true);
    try {
      const next = await loadNextVersionPageForIncompleteGroups(discovery);
      setDiscovery(next);
      setError(null);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="w-full px-gutter py-space-xl max-w-7xl mx-auto flex flex-col gap-space-xl">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-space-md">
        <div className="max-w-3xl">
          <div className="flex flex-wrap items-center gap-space-sm mb-space-sm">
            <span className="inline-flex px-space-sm py-0.5 bg-tertiary-fixed text-on-tertiary-fixed font-label-sm text-label-sm uppercase rounded rotate-[-2deg] shadow-[2px_2px_0px_#00170b]">
              Live library
            </span>
            <span className="font-label-sm text-label-sm uppercase text-on-surface-variant">
              list_library from approved tasks
            </span>
          </div>
          <h1 className="font-headline-lg text-headline-lg-mobile md:text-headline-lg text-primary tracking-tight">
            Official string library
          </h1>
          <p className="font-body-lg text-body-lg text-on-surface-variant mt-space-xs">
            Versions published on {PRODUCT_UI_CONTRACT.slice(0, 8)}…{PRODUCT_UI_CONTRACT.slice(-4)}. Approval-only.
            Rejected translations are not listed. Each key loads at most 50 versions until you request more.
          </p>
        </div>
        <Link
          to={demoHref("/library")}
          className="px-space-md py-space-sm bg-surface-container-high font-label-md text-label-md uppercase rounded"
        >
          Demo library
        </Link>
      </div>

      {discovery ? <p className="font-body-sm text-body-sm text-on-surface-variant">{discovery.scopeNote}</p> : null}
      {loading ? <p className="font-body-md text-body-md text-on-surface-variant">Scanning approved list_tasks…</p> : null}
      {error ? (
        <p className="bg-error-container text-on-error-container p-space-md rounded font-body-sm text-body-sm">{error}</p>
      ) : null}

      <div className="flex flex-col lg:flex-row gap-space-sm">
        <label className="flex-1 flex items-center gap-space-sm bg-surface-container-lowest px-space-md py-space-sm rounded shadow-[2px_2px_0px_#00170b]">
          <Icon name="search" />
          <input
            className="w-full bg-transparent outline-none font-body-md text-body-md"
            placeholder="Search key, source, translation, or task id…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <select
          className="bg-surface-container-lowest px-space-md py-space-sm rounded shadow-[2px_2px_0px_#00170b] font-label-md text-label-md uppercase"
          value={locale}
          onChange={(e) => setLocale(e.target.value)}
        >
          <option value="all">All scanned locales</option>
          {locales.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </select>
      </div>

      <p className="font-body-sm text-body-sm text-on-surface-variant">
        Displaying {versions.length} loaded version{versions.length === 1 ? "" : "s"} from {discovery?.groups.length ?? 0}{" "}
        string_key + locale pair{discovery?.groups.length === 1 ? "" : "s"}. Unique approved tasks scanned:{" "}
        {discovery?.uniqueApprovedTaskCount ?? 0}.
      </p>
      {discovery?.incompleteVersionGroups ? (
        <p className="font-body-sm text-body-sm text-secondary">
          Incomplete list_library results: {discovery.incompleteVersionGroups} pair
          {discovery.incompleteVersionGroups === 1 ? "" : "s"} still have unread versions. Use Load more versions on that
          key.
        </p>
      ) : null}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-space-xl items-start">
        <div className="lg:col-span-7 flex flex-col gap-space-md">
          {!loading && visibleGroups.length === 0 ? (
            <p className="font-body-lg text-body-lg text-on-surface-variant">
              No approved library versions on the scanned pages. Load more if older approved tasks exist.
            </p>
          ) : (
            visibleGroups.map(({ group, versions: rows }) => {
              const pairId = encodeLibraryPair(group.string_key, group.locale);
              const pairBusy = loadingPair === pairId;
              return (
                <div key={pairId} className="flex flex-col gap-space-sm">
                  {rows.map((entry, i) => (
                    <LibraryRow
                      key={encodeLibraryVersionKey(entry.string_key, entry.locale, entry.version)}
                      index={i + 1}
                      entry={entry}
                      incomplete={!group.versionsComplete}
                      loadedOfTotal={`${group.versions.length}/${group.versionCount || "?"}`}
                      active={
                        selected?.string_key === entry.string_key &&
                        selected.locale === entry.locale &&
                        selected.version === entry.version
                      }
                      onSelect={() =>
                        setSelectedKey(encodeLibraryVersionKey(entry.string_key, entry.locale, entry.version))
                      }
                    />
                  ))}
                  {!group.versionsComplete ? (
                    <button
                      type="button"
                      disabled={pairBusy || loadingMore}
                      className="px-space-lg py-space-md bg-tertiary-fixed text-on-tertiary-fixed font-label-md text-label-md uppercase rounded shadow-[3px_3px_0px_#00170b] disabled:opacity-50"
                      onClick={() => void onLoadMoreForPair(group)}
                    >
                      {pairBusy
                        ? "Loading more versions…"
                        : `Load more versions for this key (${group.versions.length}/${group.versionCount || "?"})`}
                    </button>
                  ) : null}
                  {group.versionReadError ? (
                    <p className="font-body-sm text-body-sm text-secondary">
                      Kept {group.versions.length} loaded version{group.versions.length === 1 ? "" : "s"}.{" "}
                      {group.versionReadError}
                    </p>
                  ) : null}
                </div>
              );
            })
          )}
          {discovery?.incompleteVersionGroups ? (
            <button
              type="button"
              disabled={loadingMore || Boolean(loadingPair)}
              className="px-space-lg py-space-md bg-surface-container-high font-label-md text-label-md uppercase rounded shadow-[2px_2px_0px_#00170b] disabled:opacity-50"
              onClick={() => void onLoadNextIncompletePages()}
            >
              {loadingMore
                ? "Loading next version pages…"
                : `Load next version page for ${discovery.incompleteVersionGroups} incomplete key${
                    discovery.incompleteVersionGroups === 1 ? "" : "s"
                  }`}
            </button>
          ) : null}
          {discovery?.moreAvailable ? (
            <button
              type="button"
              disabled={loadingMore || Boolean(loadingPair)}
              className="px-space-lg py-space-md bg-secondary-container text-on-secondary-container font-label-md text-label-md uppercase rounded shadow-[3px_3px_0px_#00170b] disabled:opacity-50"
              onClick={() => void onLoadMoreTaskPages()}
            >
              {loadingMore ? "Loading older page…" : "Load more approved task pages"}
            </button>
          ) : discovery ? (
            <p className="font-body-sm text-body-sm text-on-surface-variant">No older list_tasks pages remain.</p>
          ) : null}
        </div>
        <aside className="lg:col-span-5 flex flex-col gap-space-md sticky top-24">
          {selected ? (
            <>
              <section className="bg-surface-container-lowest p-space-lg rounded shadow-[4px_4px_0px_#00170b] flex flex-col gap-space-sm">
                <div className="flex items-center justify-between">
                  <h2 className="font-headline-sm text-headline-sm uppercase text-primary">Selected key</h2>
                  <span className="font-label-sm text-label-sm uppercase bg-primary-fixed text-on-primary-fixed px-space-xs py-0.5 rounded">
                    v{selected.version} live
                  </span>
                </div>
                <p className="font-title-md text-title-md text-primary break-all">{selected.string_key}</p>
                <CopyButton value={selected.string_key} label="Copy key" />
                <p className="font-body-md text-body-md">Source: {selected.source_text}</p>
                <p className="font-body-md text-body-md">
                  {selected.locale}: {selected.translation}
                </p>
                <CopyButton value={selected.translation} label="Copy translation" />
                <p className="font-body-sm text-body-sm text-on-surface-variant">
                  Approved {formatUnix(selected.approved_at_unix)}. This is a list_library version, not a rejected
                  translation.
                </p>
                {selectedGroup && !selectedGroup.versionsComplete ? (
                  <button
                    type="button"
                    disabled={loadingPair === encodeLibraryPair(selectedGroup.string_key, selectedGroup.locale)}
                    className="px-space-md py-space-sm bg-tertiary-fixed text-on-tertiary-fixed font-label-md text-label-md uppercase rounded disabled:opacity-50"
                    onClick={() => void onLoadMoreForPair(selectedGroup)}
                  >
                    Load more versions for this key ({selectedGroup.versions.length}/{selectedGroup.versionCount || "?"})
                  </button>
                ) : null}
                <Link to={liveTaskHref(selected.task_id)} className="font-label-md text-label-md uppercase text-secondary">
                  Open source task
                </Link>
              </section>
              <AppPreview
                body={selected.translation}
                locale={selected.locale}
                caption="CSS mock. Injects this approved library version."
              />
            </>
          ) : (
            <p className="font-body-md text-body-md text-on-surface-variant">Select a loaded version to preview.</p>
          )}
        </aside>
      </div>
    </div>
  );
}

function groupError(discovery: LibraryDiscovery, stringKey: string, locale: string): string | null {
  const group = discovery.groups.find((g) => g.string_key === stringKey && g.locale === locale);
  return group?.versionReadError ?? null;
}

function LibraryRow({
  entry,
  index,
  active,
  incomplete,
  loadedOfTotal,
  onSelect,
}: {
  entry: LibraryEntry;
  index: number;
  active: boolean;
  incomplete?: boolean;
  loadedOfTotal?: string;
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
          {loadedOfTotal ? ` · ${loadedOfTotal}` : ""}
          {incomplete ? " · incomplete" : ""}
        </span>
      </div>
      <p className="font-title-lg text-title-lg text-primary break-all">{entry.string_key}</p>
      <p className="font-body-sm text-body-sm text-on-surface-variant">{entry.source_text}</p>
      <p className="font-body-md text-body-md text-primary">{entry.translation}</p>
    </button>
  );
}
