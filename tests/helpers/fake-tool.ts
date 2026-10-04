/**
 * A fake command-line tool on a PATH a test controls (#138): a `.cmd` shim
 * on Windows, the way npm installs a global tool, and an executable script
 * elsewhere.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const isWindows = process.platform === 'win32';

/** Write a tool named `name` into `dir` with this body for each OS. Returns its path. */
export async function writeFakeTool(dir: string, name: string, script: { win: string; posix: string }): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  if (isWindows) {
    const file = path.join(dir, `${name}.cmd`);
    await fs.writeFile(file, `@echo off\r\n${script.win}\r\n`);
    return file;
  }
  const file = path.join(dir, name);
  await fs.writeFile(file, `#!/bin/sh\n${script.posix}\n`, { mode: 0o755 });
  return file;
}

/**
 * The parent environment with its search path replaced by `dirs` plus the
 * system folders a shell and cmd.exe need. Windows spells the key `Path`,
 * and an env copied from `process.env` keeps that spelling: both spellings
 * are set, so a child sees one search path whichever it reads.
 */
export function envWithSearchPath(dirs: readonly string[]): Record<string, string> {
  const base = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[0].toUpperCase() !== 'PATH' && entry[1] !== undefined),
  );
  const system = isWindows ? [path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32')] : ['/bin', '/usr/bin'];
  const searchPath = [...dirs, ...system].join(path.delimiter);
  return { ...base, PATH: searchPath, Path: searchPath };
}
