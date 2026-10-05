/**
 * What this machine's pseudoterminal can do, probed once per run by the
 * vitest global setup and provided to the workers (#174). Layer 2 gates on
 * these, never on `process.platform`:
 *
 * - `works`: a child started in a PTY delivers its output and its exit.
 * - `verbatim`: the bytes it writes arrive unchanged. A POSIX PTY passes
 *   them through; Windows ConPTY renders the child's output and re-emits it
 *   inside its own framing (see conpty-framing.ts).
 * - `signals`: the backend delivers a named signal (`pty.kill('SIGINT')`).
 *   node-pty's ConPTY backend accepts none; there a Ctrl+C is the \x03 byte.
 */

import * as nodePty from 'node-pty';

export interface PtyCapabilities {
  works: boolean;
  verbatim: boolean;
  signals: boolean;
}

export const PTY_CAPABILITIES_KEY = 'ptyCapabilities';

declare module 'vitest' {
  export interface ProvidedContext {
    ptyCapabilities: PtyCapabilities;
  }
}

const NONE: PtyCapabilities = { works: false, verbatim: false, signals: false };

/** Run a child that writes `ok`, then waits; read its output, try a named signal, end it. */
export async function probePtyCapabilities(timeoutMs = 15_000): Promise<PtyCapabilities> {
  let pty: nodePty.IPty;
  try {
    pty = nodePty.spawn(process.execPath, ['-e', 'process.stdout.write("ok"); setTimeout(() => {}, 30000)'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
    });
  } catch {
    return NONE;
  }
  return new Promise<PtyCapabilities>((resolve) => {
    let out = '';
    let settled = false;
    const finish = (caps: PtyCapabilities): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(caps);
    };
    const timer = setTimeout(() => {
      try {
        pty.kill();
      } catch {
        // gone
      }
      finish(NONE);
    }, timeoutMs);
    let probed = false;
    pty.onData((chunk) => {
      out += chunk;
      if (probed || !out.includes('ok')) return;
      probed = true;
      // The child is running and the terminal is ready: try a named signal.
      let signals = true;
      try {
        pty.kill('SIGTERM');
      } catch {
        signals = false;
        pty.kill();
      }
      const verbatim = out === 'ok';
      pty.onExit(() => finish({ works: true, verbatim, signals }));
    });
  });
}
