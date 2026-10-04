import type { AppProps } from 'pastel';
import CrashBoundary from '../components/CrashBoundary.js';
import { jsonCommandOf } from '../core/json-output.js';
import { resolveEngineVersion } from './hooks/cli-version.js';

/**
 * Pastel's custom app: wraps every command in CrashBoundary, so a throw while
 * a command renders is reported like any other bug in shardmind (#225), or
 * under `--json` as the command's failure document.
 */
export default function App({ Component, commandProps }: AppProps) {
  const json = commandProps.options['json'] === true ? jsonCommandOf(process.argv.slice(2)) : undefined;
  return (
    <CrashBoundary getVersion={resolveEngineVersion} json={json}>
      <Component {...commandProps} />
    </CrashBoundary>
  );
}
