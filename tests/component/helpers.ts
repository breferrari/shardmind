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
