export async function tick(ms = 30): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Poll lastFrame() until `predicate` returns true or `timeoutMs` elapses.
 * Ink renders asynchronously after stdin writes and state updates, so a
 * fixed sleep is flaky — waitFor is the robust pattern.
 */
export async function waitFor(
  lastFrame: () => string | undefined,
  predicate: (frame: string) => boolean,
  timeoutMs = 2000,
): Promise<string> {
  const start = Date.now();
  // Yield once so Ink's stdin listener and render scheduler can process
  // any inputs queued just before waitFor was called.
  await tick(30);
  while (Date.now() - start < timeoutMs) {
    const frame = lastFrame() ?? '';
    if (predicate(frame)) return frame;
    await tick(50);
  }
  throw new Error(
    `waitFor timed out after ${timeoutMs}ms. Last frame:\n${JSON.stringify(lastFrame())}`,
  );
}

export const ENTER = '\r';
export const ESC = '\x1B';
export const SPACE = ' ';
export const ARROW_DOWN = '\x1B[B';
export const ARROW_UP = '\x1B[A';

interface Writable {
  write: (data: string) => void;
}

/**
 * Type a string one character at a time with a tick between each write.
 *
 * Why not write the whole string at once: @inkjs/ui TextInput's submit
 * callback captures `state.value` in a useCallback closure. Multiple
 * writes in the same microtask get batched into a single render, which
 * can leave the submit closure stale relative to the rendered value.
 * Per-character writes with a tick in between ensure React commits
 * each insert before the next keystroke arrives.
 */
export async function typeText(
  stdin: Writable,
  text: string,
  perCharDelayMs = 30,
): Promise<void> {
  // Settle first: under Ink 7 / React 19, a TextInput that just
  // mounted as part of a step transition may not have attached its
  // useInput handler by the time waitFor sees its text appear. A
  // small initial tick avoids losing the first keystroke.
  await tick(perCharDelayMs);
  for (const ch of text) {
    stdin.write(ch);
    await tick(perCharDelayMs);
  }
}
