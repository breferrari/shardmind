import { Component, useEffect, type ReactNode } from 'react';
import { useApp } from 'ink';
import ErrorView from './ErrorView.js';

interface Props {
  /** shardmind's version, read only if something crashes. */
  getVersion: () => string | undefined;
  children: ReactNode;
}

interface State {
  failed: boolean;
  error: unknown;
}

/**
 * Wraps every command (`commands/_app.tsx`, #225). A throw while a command
 * renders would otherwise reach Ink's own error overview, with no report
 * link, and exit 0. Here it shows through ErrorView and exits 1. A `--json`
 * run never renders (#302): a crash in it answers through cli.ts.
 */
export default class CrashBoundary extends Component<Props, State> {
  override state: State = { failed: false, error: undefined };

  static getDerivedStateFromError(error: unknown): State {
    return { failed: true, error };
  }

  override componentDidCatch(): void {
    process.exitCode = 1;
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <>
        <ErrorView error={this.state.error} version={this.props.getVersion()} />
        <ExitWhenShown />
      </>
    );
  }
}

/** The command's tree is gone, so nothing else ends the app. */
function ExitWhenShown() {
  const { exit } = useApp();
  useEffect(() => {
    exit();
  }, [exit]);
  return null;
}
