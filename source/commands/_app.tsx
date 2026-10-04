import type { AppProps } from 'pastel';
import CrashBoundary from '../components/CrashBoundary.js';
import { resolveEngineVersion } from './hooks/cli-version.js';

/**
 * Pastel's custom app: wraps every command in CrashBoundary, so a throw while
 * a command renders is reported like any other bug in shardmind (#225).
 */
export default function App({ Component, commandProps }: AppProps) {
  return (
    <CrashBoundary version={resolveEngineVersion()}>
      <Component {...commandProps} />
    </CrashBoundary>
  );
}
