/**
 * Layer 2's gates, read inside a test worker from the capabilities the global
 * setup probed (pty-capability.ts, #174). Kept apart from the probe, which the
 * global setup imports outside any worker.
 */

import { inject, it } from 'vitest';
import { PTY_CAPABILITIES_KEY, type PtyCapabilities } from './pty-capability.js';

/** The capabilities the global setup probed. Only inside a test worker. */
export function ptyCaps(): PtyCapabilities {
  return inject(PTY_CAPABILITIES_KEY);
}

/**
 * Expected failures under ConPTY (#282): the Open in editor flows (#50) draw
 * their last frame but do not exit there. `it.fails` turns red the moment
 * #282 is fixed, so the marker cannot outlive the bug; the exit wait is
 * shortened meanwhile. Delete both when #282 lands. (The diff-prompt flows
 * hung too on Ink 7 and exit since Ink 8, #286; why is #282's to prove.)
 */
export function itUntil282(): typeof it | typeof it.fails {
  return ptyCaps().verbatim ? it : it.fails;
}
export function exitWaitUntil282(): number {
  return ptyCaps().verbatim ? 60_000 : 20_000;
}

/** No PTY to run in: every Layer 2 scenario skips. */
export function noPty(): boolean {
  return !ptyCaps().works;
}
