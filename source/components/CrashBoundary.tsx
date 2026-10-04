import { Component, useEffect, type ReactNode } from 'react';
import { useApp } from 'ink';
import ErrorView from './ErrorView.js';

interface Props {
  version: string | undefined;
  children: ReactNode;
}

interface State {
  failed: boolean;
  error: unknown;
}

/**
 * Wraps every command (`commands/_app.tsx`, #225). A throw while a command
 * renders would otherwise reach Ink's own error overview, with no report
 * link, and exit 0; here it shows through ErrorView and exits 1.
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
        <ErrorView error={this.state.error} version={this.props.version} />
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
