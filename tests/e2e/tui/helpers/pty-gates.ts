/**
 * Layer 2's gates, read inside a test worker from the capabilities the global
 * setup probed (pty-capability.ts, #174). Kept apart from the probe, which the
 * global setup imports outside any worker.
 */

import { inject } from 'vitest';
import { PTY_CAPABILITIES_KEY, type PtyCapabilities } from './pty-capability.js';

/** The capabilities the global setup probed. Only inside a test worker. */
export function ptyCaps(): PtyCapabilities {
  return inject(PTY_CAPABILITIES_KEY);
}

/** No PTY to run in: every Layer 2 scenario skips. */
export function noPty(): boolean {
  return !ptyCaps().works;
}
