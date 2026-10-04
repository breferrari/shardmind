/**
 * Hold a CLI subprocess at one vault write, so a test can deliver a real
 * SIGINT while the executor is writing (#186).
 *
 * Test-only and outside the CLI: the test starts the child with
 * `node --import tsx --import <data: preload> dist/cli.js …`, and the preload
 * calls `holdWrite` inside the child. It installs #267's fault injector over
 * the shared `fsp` with a `beforeWrite` plan in that injector's vocabulary.
 * No production code reads anything: the parameters travel in the preload's
 * own code, not in an environment variable.
 *
 * The hold releases on SIGINT. The Ctrl+C rollback waits for the run in
 * flight to settle (#249), so a write held forever would deadlock it; once
 * released, the write under way finishes, the executor sees the abort before
 * its next write, and the rollback runs.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { injectFaults } from '../../helpers/fault-fs.js';

export interface HoldWriteOptions {
  /** Hold before the `nth` write (1-based) whose destination is inside `under`. */
  nth: number;
  /** The vault. */
  under: string;
  /** Written when the hold begins, so the test knows the write is under way. */
  marker: string;
}

/** Runs inside the child, from the preload. */
export function holdWrite(opts: HoldWriteOptions): void {
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  // Registered before the CLI loads, so it runs before the CLI's own listener.
  process.on('SIGINT', () => release());
  injectFaults({
    beforeWrite: {
      nth: opts.nth,
      // The CLI writes through its real working directory: on macOS the temp
      // folder is a symlink (/var → /private/var), so match on the real path.
      under: fs.realpathSync.native(opts.under),
      hook: () => {
        fs.writeFileSync(opts.marker, '');
        return released;
      },
    },
  });
}

/** The node flags that start a child holding at `opts`. Pass as `spawnCli`'s `nodeArgs`. */
export function holdWriteNodeArgs(opts: HoldWriteOptions): string[] {
  const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href;
  const self = new URL(import.meta.url).href;
  const code = `import { holdWrite } from ${JSON.stringify(self)}; holdWrite(${JSON.stringify(opts)});`;
  return ['--import', tsx, '--import', `data:text/javascript,${encodeURIComponent(code)}`];
}

/**
 * Resolves once the hold has begun: the child is mid-write. A run that never
 * reaches the held write rejects here; `signalAt.when` swallows that, the run
 * finishes unsignalled, and the test's own `held` check reports it.
 */
export async function waitForHold(marker: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await fs.promises.access(marker).then(() => true, () => false))) {
    if (Date.now() > deadline) throw new Error(`the CLI never reached the held write (${marker})`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
