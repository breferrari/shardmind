import { Component, useEffect, type ReactNode } from 'react';
import { useApp } from 'ink';
import ErrorView from './ErrorView.js';
import { emitJson, jsonFailure, type JsonCommand } from '../core/json-output.js';

interface Props {
  /** shardmind's version, read only if something crashes. */
  getVersion: () => string | undefined;
  /** Set under `--json`: the crash is written as that command's failure document. */
  json?: JsonCommand | undefined;
  children: ReactNode;
}

interface State {
  failed: boolean;
  error: unknown;
}

/**
 * Wraps every command (`commands/_app.tsx`, #225). A throw while a command
 * renders would otherwise reach Ink's own error overview, with no report
 * link, and exit 0. Here it shows through ErrorView, or under `--json` as one
 * failure document carrying the stack, and exits 1.
 */
export default class CrashBoundary extends Component<Props, State> {
  override state: State = { failed: false, error: undefined };

  static getDerivedStateFromError(error: unknown): State {
    return { failed: true, error };
  }

  override componentDidCatch(error: unknown): void {
    process.exitCode = 1;
    if (this.props.json) emitJson(jsonFailure(this.props.json, error));
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <>
        {this.props.json ? null : <ErrorView error={this.state.error} version={this.props.getVersion()} />}
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
