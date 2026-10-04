import { Component, type ErrorInfo, type ReactNode } from "react";
import { loadSession } from "./persist";

type Props = { children: ReactNode };
type State = { error: Error | null };

function storedTxLines(): { label: string; txId: string }[] {
  const session = loadSession();
  const rows: { label: string; txId?: string }[] = [
    { label: "release deploy", txId: session.release.deploy.txId },
    { label: "release lock", txId: session.release.lock.txId },
    { label: "release payout", txId: session.release.payout.txId },
    { label: "refund deploy", txId: session.refund.deploy.txId },
    { label: "refund lock", txId: session.refund.lock.txId },
    { label: "refund payout", txId: session.refund.payout.txId },
  ];
  return rows.filter((row): row is { label: string; txId: string } => Boolean(row.txId));
}

export class LiveErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, _info: ErrorInfo) {
    console.error("Live Settlement Test render error", error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const ids = storedTxLines();
    return (
      <div className="w-full px-gutter py-space-xl max-w-7xl mx-auto flex flex-col gap-space-lg">
        <span className="inline-flex self-start items-center gap-1 px-space-sm py-0.5 bg-secondary-container text-on-secondary-container font-label-sm text-label-sm uppercase tracking-wider rounded shadow-[2px_2px_0px_#00170b]">
          Live Settlement Test
        </span>
        <h1 className="font-display-lg text-headline-lg text-primary uppercase tracking-tight">Page recovered</h1>
        <p className="font-body-md text-body-md text-on-surface-variant max-w-3xl">
          A render error was caught so this route did not go blank. Stored transaction IDs were not cleared and will
          not be resubmitted.
        </p>
        <pre className="whitespace-pre-wrap bg-error-container text-on-error-container p-space-md rounded font-body-sm text-body-sm">
          {this.state.error.message}
        </pre>
        {ids.length ? (
          <ul className="font-mono text-sm break-all flex flex-col gap-space-xs">
            {ids.map(({ label, txId }) => (
              <li key={label}>
                {label}: {txId}
              </li>
            ))}
          </ul>
        ) : (
          <p className="font-body-sm text-body-sm text-on-surface-variant">No stored transaction IDs in this browser yet.</p>
        )}
        <button
          type="button"
          className="self-start font-label-md text-label-md uppercase px-space-md py-space-sm bg-secondary-container text-on-secondary-container rounded shadow-[2px_2px_0px_#00170b]"
          onClick={() => this.setState({ error: null })}
        >
          Show the test again
        </button>
      </div>
    );
  }
}
