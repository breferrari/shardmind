/**
 * A Ctrl+C at an exact point of a run (#249, #323): abort `abort` right
 * after the write of `absPath` lands, through the `fsp` seam the rollback
 * contract uses. Returns the spy (restore it) and whether the abort fired,
 * so a test never passes because the path never matched.
 */

import fsp from 'node:fs/promises';
import { vi } from 'vitest';

export function abortAfterWrite(absPath: string, abort: AbortController, onWrite?: (file: string) => void) {
  const realWrite = fsp.writeFile;
  const spy = vi.spyOn(fsp, 'writeFile').mockImplementation(async (file, data, opts) => {
    onWrite?.(String(file));
    await realWrite(file, data, opts);
    if (String(file) === absPath) abort.abort();
  });
  return { restore: () => spy.mockRestore(), fired: () => abort.signal.aborted };
}
