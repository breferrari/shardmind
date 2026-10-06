import type { AppProps } from '../cli-kit/index.js';
import CrashBoundary from '../components/CrashBoundary.js';
import { resolveEngineVersion } from './hooks/cli-version.js';

/**
 * Pastel's custom app: wraps every command in CrashBoundary, so a throw while
 * a command renders is reported like any other bug in shardmind (#225). A
 * `--json` run never renders: cli.ts answers it headless (#302).
 */
export default function App({ Component, commandProps }: AppProps) {
  return (
    <CrashBoundary getVersion={resolveEngineVersion}>
      <Component {...commandProps} />
    </CrashBoundary>
  );
}
