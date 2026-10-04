import { Component, type ErrorInfo, type ReactNode } from "react";
import { loadB2Session } from "./persist";

type Props = { children: ReactNode };
type State = { error: Error | null };

export class LiveProductB2ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, _info: ErrorInfo) {
    console.error("Live Product Test Phase B2 render error", error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const session = loadB2Session();
    const ids = [
      ["create", session.create.txId],
      ["submit", session.submit.txId],
      ["evaluate", session.evaluate.txId],
      ["recover", session.recover.txId],
    ].filter((row): row is [string, string] => Boolean(row[1]));
    return (
      <div className="w-full px-gutter py-space-xl max-w-7xl mx-auto flex flex-col gap-space-lg">
        <span className="inline-flex self-start items-center gap-1 px-space-sm py-0.5 bg-secondary-container text-on-secondary-container font-label-sm text-label-sm uppercase tracking-wider rounded shadow-[2px_2px_0px_#00170b]">
          Live Product Test · Phase B2
        </span>
        <h1 className="font-display-lg text-headline-lg text-primary uppercase tracking-tight">Page recovered</h1>
        <p className="font-body-md text-body-md text-on-surface-variant max-w-3xl">
          A render error was caught so this route did not go blank. Stored transaction IDs were not cleared and will not
          be resubmitted.
        </p>
        <pre className="whitespace-pre-wrap bg-error-container text-on-error-container p-space-md rounded font-body-sm text-body-sm">
          {this.state.error.message}
        </pre>
        {ids.length ? (
          <ul className="font-mono text-sm break-all flex flex-col gap-space-xs">
            {ids.map(([label, txId]) => (
              <li key={label}>
                {label}: {txId}
              </li>
            ))}
          </ul>
        ) : (
          <p className="font-body-sm text-body-sm text-on-surface-variant">No stored Phase B2 transaction IDs in this browser yet.</p>
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
