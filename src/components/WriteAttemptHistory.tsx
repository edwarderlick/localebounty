import type { AttemptHistoryEntry } from "../live/productUi/attemptHistory";

export function WriteAttemptHistory({
  entries,
  currentTxId,
}: {
  entries?: AttemptHistoryEntry[];
  currentTxId?: string;
}) {
  if (!entries?.length) return null;
  return (
    <div className="flex flex-col gap-space-xs">
      <p className="font-label-sm text-label-sm uppercase tracking-widest text-on-surface-variant">
        Prior write hashes
      </p>
      <ul className="flex flex-col gap-space-xs">
        {entries.map((entry) => (
          <li
            key={entry.txId}
            className="bg-surface-container-low p-space-sm rounded font-body-sm text-body-sm break-all"
          >
            <span className="font-label-sm text-label-sm uppercase">{entry.action ?? "write"}</span> {entry.txId}
            {" · "}
            {entry.statusName ?? "unread"}
            {entry.executionName ? ` · ${entry.executionName}` : ""}
            {" · isSuccessful "}
            {String(Boolean(entry.parentSuccessful))}
            {currentTxId && entry.txId.toLowerCase() === currentTxId.toLowerCase()
              ? " · current"
              : " · stored history, never retried"}
          </li>
        ))}
      </ul>
    </div>
  );
}
