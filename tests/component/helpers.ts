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
  let lastObservedFrame = '';
  // Yield once so Ink's stdin listener and render scheduler can process
  // any inputs queued just before waitFor was called.
  await tick(30);
  while (Date.now() - start < timeoutMs) {
    lastObservedFrame = lastFrame() ?? '';
    if (predicate(lastObservedFrame)) {
      // Post-predicate settle: the frame matches, but any effects
      // scheduled for after this render (useInput registration for a
      // just-mounted input, etc.) may not have fired yet. One more
      // tick lets them run before the caller writes to stdin.
      await tick(30);
      return lastObservedFrame;
    }
    await tick(50);
  }
  throw new Error(
    `waitFor timed out after ${timeoutMs}ms. Last frame:\n${lastObservedFrame}`,
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
  for (const ch of text) {
    stdin.write(ch);
    await tick(perCharDelayMs);
  }
}
