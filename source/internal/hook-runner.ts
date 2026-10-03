/**
 * Internal hook-runner — the subprocess entry point for executing a shard's
 * post-install / post-update TypeScript hook.
 *
 * Shipped as `dist/internal/hook-runner.js`. Not part of the public API
 * surface (`dist/runtime/index.js`), not re-exported, not documented for
 * shard authors. The only consumer is `source/core/hook.ts`, which spawns:
 *
 *   node --import <abs tsx loader> dist/internal/hook-runner.js \
 *        <hookPath> <ctxFilePath>
 *
 * Flow:
 *   1. Read the two argv positions (hook path + ctx temp-file path).
 *   2. Parse the JSON-serialized `HookContext` from the ctx file.
 *   3. Dynamically `import()` the hook module. `--import tsx/...loader.mjs`
 *      registers tsx's ESM loader on the parent node process, so a TS file
 *      resolves and compiles transparently from here.
 *   4. Invoke the default export with the parsed ctx and await completion.
 *   5. Exit 0 on success, 1 on any throw. The thrown error's message + stack
 *      go to stderr so the parent can surface them in the install summary.
 *
 * Deliberately tiny — this file is on the cold-start path of every hook
 * invocation. It must NOT import Ink, React, Pastel, or anything that pulls
 * in the CLI bundle; it runs in its own node process.
 *
 * Windows paths: the hook path arrives as an absolute OS path. Dynamic
 * `import()` of an absolute path on Windows requires a `file://` URL
 * (not a bare `C:\\…` string), which `pathToFileURL` handles.
 *
 * See docs/ARCHITECTURE.md §9.3 for the hook contract and
 * docs/IMPLEMENTATION.md §4.14a for the execution algorithm.
 */

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { HookContext } from '../runtime/types.js';

/**
 * Make writes to stdout and stderr synchronous when they are pipes (#106).
 * On POSIX, Node queues pipe writes, and `process.exit` drops what is still
 * queued: a hook that printed more than a pipe buffer (64 KiB on Linux)
 * and then threw, or called `process.exit` itself, lost the rest, and under
 * load even a short line could go. Node already makes pipes blocking on
 * Windows; this does the same here, through the stream handle's
 * `setBlocking` (an internal API, reached by runtime checks). Where it is
 * missing, writes stay as they were. The parent always reads both pipes,
 * so a blocking write never waits on it for long.
 */
function makeStdioBlocking(): void {
  for (const stream of [process.stdout, process.stderr]) {
    const handle: unknown = Reflect.get(stream, '_handle');
    if (typeof handle !== 'object' || handle === null) continue;
    const setBlocking: unknown = Reflect.get(handle, 'setBlocking');
    if (typeof setBlocking === 'function') setBlocking.call(handle, true);
  }
}

makeStdioBlocking();

async function main(): Promise<void> {
  const [, , hookPath, ctxPath] = process.argv;
  if (!hookPath || !ctxPath) {
    process.stderr.write(
      'shardmind hook-runner: missing argv — expected <hookPath> <ctxPath>.\n',
    );
    process.exit(1);
  }

  let ctx: HookContext;
  try {
    const raw = await readFile(ctxPath, 'utf-8');
    ctx = JSON.parse(raw) as HookContext;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`shardmind hook-runner: cannot read ctx (${message})\n`);
    process.exit(1);
  }

  // `pathToFileURL` wraps Windows absolute paths as `file:///C:/...` so
  // dynamic import resolves them. POSIX paths pass through unchanged.
  const mod = await import(pathToFileURL(hookPath).href);
  const fn = (mod as { default?: unknown }).default;
  if (typeof fn !== 'function') {
    process.stderr.write(
      `shardmind hook-runner: ${hookPath} must export a default async function (ctx: HookContext) => Promise<void>.\n`,
    );
    process.exit(1);
  }

  await (fn as (c: HookContext) => Promise<void> | void)(ctx);
}

/** What a thrown value says, even one `String()` cannot convert. */
function describe(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  try {
    return String(err);
  } catch {
    return 'a value that cannot be converted to a string';
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${describe(err)}\n`);
  process.exit(1);
});
