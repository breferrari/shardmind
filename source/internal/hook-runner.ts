/**
 * Internal hook-runner — the subprocess entry point for executing a shard's
 * TypeScript hook (bootstrap, personalize or post-update).
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
 *   2. Parse the JSON-serialized slot context from the ctx file.
 *   3. Map `shardmind/runtime` to the running engine's runtime (#373, best
 *      effort per #377), then dynamically `import()` the hook module.
 *      `--import tsx/...loader.mjs` registers tsx's ESM loader on the parent
 *      node process, so a TS file resolves and compiles transparently from
 *      here.
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

import { existsSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import Module, { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { SlottedHookContext } from '../runtime/types.js';

/**
 * Make writes to stdout and stderr synchronous when they are pipes (#106).
 * On POSIX, Node queues pipe writes, and `process.exit` drops what is still
 * queued: a hook that printed more than a pipe buffer (64 KiB on Linux)
 * and then threw, or called `process.exit` itself, lost the rest, and under
 * load even a short line could go. Node already makes pipes blocking on
 * Windows; this does the same here, through the stream handle's
 * `setBlocking` (an internal API, reached by runtime checks, which returns
 * 0 on success). Returns whether both streams are now blocking; when not,
 * the throw path falls back to `exitAfterFlush`. The parent always reads
 * both pipes, so a blocking write never waits on it for long. Best effort:
 * a Node grandchild sharing the pipe can make it non-blocking again.
 */
function makeStdioBlocking(): boolean {
  let blocking = true;
  for (const stream of [process.stdout, process.stderr]) {
    const handle: unknown = Reflect.get(stream, '_handle');
    const setBlocking: unknown =
      typeof handle === 'object' && handle !== null ? Reflect.get(handle, 'setBlocking') : undefined;
    let ok = false;
    if (typeof setBlocking === 'function') {
      try {
        ok = setBlocking.call(handle, true) === 0;
      } catch {
        ok = false;
      }
    }
    // No handle means a file stream, whose writes are already synchronous.
    blocking &&= ok || handle === undefined || handle === null;
  }
  return blocking;
}

const stdioBlocking = makeStdioBlocking();

/**
 * The runner's own failure, as the engine reads it (#348, IMPLEMENTATION
 * §4.16): written to `<ctxPath>.failure` before exiting, so the engine knows
 * why without parsing stderr. The exit code stays 1. Best effort: a failure
 * to write it leaves the engine's fallback (`exit`).
 */
type RunnerFailure = 'context' | 'import' | 'no-default-export' | 'threw';
let stage: RunnerFailure = 'context';

function reportFailure(ctxPath: string | undefined, failure: RunnerFailure): void {
  if (!ctxPath) return;
  try {
    writeFileSync(`${ctxPath}.failure`, failure, { encoding: 'utf-8', mode: 0o600 });
  } catch {
    // The engine falls back to `exit`.
  }
}

/** The specifier mapped to the running engine's runtime (#373). Exact match only. */
const RUNTIME_SPECIFIER = 'shardmind/runtime';

/**
 * The running engine's runtime entry, beside this runner: `../runtime/index.js`
 * in dist, `../runtime/index.ts` when the runner itself runs from source (a dev
 * or vitest run, which tsx transpiles). Null when neither exists.
 */
function engineRuntimePath(): string | null {
  for (const rel of ['../runtime/index.js', '../runtime/index.ts']) {
    const candidate = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolve `shardmind/runtime` to the running engine's runtime for the hook
 * (#373), also over a copy the shard vendors: the engine wrote the state the
 * hook reads, so its runtime is the one guaranteed to read it. The runtime's
 * own imports (zod, yaml) then resolve from the engine's install. Two loaders
 * need it:
 *   - ESM: a `module.register` resolve hook, an inline `data:` module so it
 *     needs no bundle of its own. Registered after tsx's, so it runs first.
 *   - CommonJS: tsx loads a `.ts` hook as CommonJS when the shard has no
 *     `"type": "module"`, and its imports become `require()` calls, which
 *     resolve hooks never see. `Module._resolveFilename` is wrapped instead,
 *     the same seam tsx uses, calling through for every other request.
 *
 * Best effort, per loader (#377): the context is already read, so a mapping
 * that throws must not end the run as a `context` failure. Each loader is
 * mapped on its own; a failure writes one stderr line naming the loader, and
 * the hook is still imported. Through an unmapped loader the import resolves
 * as Node resolves it: a copy the shard vendors, else an `import` failure.
 */
function resolveRuntimeToEngine(): void {
  const runtimePath = engineRuntimePath();
  if (runtimePath === null) {
    warnUnmapped('ESM and CommonJS', "the engine's runtime is not beside the runner");
    return;
  }

  const resolveHook = [
    'let target;',
    'export function initialize(data) { target = data.url; }',
    'export async function resolve(specifier, context, nextResolve) {',
    `  if (specifier === ${JSON.stringify(RUNTIME_SPECIFIER)}) return { url: target, shortCircuit: true };`,
    '  return nextResolve(specifier, context);',
    '}',
  ].join('\n');
  mapLoaderOrWarn('ESM', () => {
    register(`data:text/javascript,${encodeURIComponent(resolveHook)}`, {
      data: { url: pathToFileURL(runtimePath).href },
    });
  });

  mapLoaderOrWarn('CommonJS', () => {
    const original: unknown = Reflect.get(Module, '_resolveFilename');
    if (typeof original !== 'function') throw new Error('Module._resolveFilename is not a function');
    const mapping = function (this: unknown, request: unknown, ...rest: unknown[]): unknown {
      if (request === RUNTIME_SPECIFIER) return runtimePath;
      return original.call(this, request, ...rest);
    };
    if (!Reflect.set(Module, '_resolveFilename', mapping)) throw new Error('Module._resolveFilename is read-only');
    // A setter can accept the value and keep another, or keep a wrapper that
    // calls through. Ask the seam itself: mapped means it answers with the runtime.
    if (resolvesToRuntime(Reflect.get(Module, '_resolveFilename'), runtimePath)) return;
    throw new Error('Module._resolveFilename did not keep the mapping');
  });
}

/** Whether a `_resolveFilename` answers `shardmind/runtime` with the engine's runtime. */
function resolvesToRuntime(resolveFilename: unknown, runtimePath: string): boolean {
  if (typeof resolveFilename !== 'function') return false;
  try {
    return resolveFilename.call(Module, RUNTIME_SPECIFIER, undefined, false) === runtimePath;
  } catch {
    return false;
  }
}

/** Map one loader; a throw becomes one stderr line naming it, and the run goes on (#377). */
function mapLoaderOrWarn(loader: 'ESM' | 'CommonJS', mapLoader: () => void): void {
  try {
    mapLoader();
  } catch (err) {
    warnUnmapped(loader, oneLine(err));
  }
}

/** The one stderr line for loaders left unmapped (#377). */
function warnUnmapped(loaders: string, why: string): void {
  process.stderr.write(`shardmind hook-runner: could not map ${RUNTIME_SPECIFIER} to the engine (${loaders}): ${why}\n`);
}

/**
 * A thrown value on one line: its name, then its message if it has one, with
 * line breaks folded to single spaces. Never throws, and never carries a stack.
 * The fold splits on line breaks, so it stays linear on any input.
 */
function oneLine(err: unknown): string {
  let text: string;
  try {
    if (err instanceof Error) {
      const name = typeof err.name === 'string' && err.name !== '' ? err.name : 'Error';
      const message = typeof err.message === 'string' ? err.message : '';
      text = message === '' ? name : `${name}: ${message}`;
    } else {
      text = String(err);
    }
  } catch {
    return 'a thrown value that cannot be converted to a string';
  }
  return text
    .split(/\r\n|\r|\n/)
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join(' ');
}

async function main(): Promise<void> {
  const [, , hookPath, ctxPath] = process.argv;
  if (!hookPath || !ctxPath) {
    process.stderr.write(
      'shardmind hook-runner: missing argv — expected <hookPath> <ctxPath>.\n',
    );
    process.exit(1);
  }

  let ctx: SlottedHookContext;
  try {
    const raw = await readFile(ctxPath, 'utf-8');
    ctx = JSON.parse(raw) as SlottedHookContext;
  } catch (err) {
    process.stderr.write(`shardmind hook-runner: cannot read ctx (${describe(err)})\n`);
    reportFailure(ctxPath, 'context');
    process.exit(1);
  }

  // The context is read: from here a throw is never a `context` failure
  // (#377). Mapping the runtime prepares the hook's import, so it is `import`.
  stage = 'import';
  resolveRuntimeToEngine();

  // `pathToFileURL` wraps Windows absolute paths as `file:///C:/...` so
  // dynamic import resolves them. POSIX paths pass through unchanged.
  const mod = await import(pathToFileURL(hookPath).href);
  const fn = (mod as { default?: unknown }).default;
  if (typeof fn !== 'function') {
    process.stderr.write(
      `shardmind hook-runner: ${hookPath} must export a default async function (ctx) => Promise<void>.\n`,
    );
    reportFailure(ctxPath, 'no-default-export');
    process.exit(1);
  }

  stage = 'threw';
  await (fn as (c: SlottedHookContext) => Promise<void> | void)(ctx);
}

/** What a thrown value says, whatever it is: no part of turning it into text may throw. */
function describe(err: unknown): string {
  try {
    if (err instanceof Error) {
      const stack: unknown = err.stack;
      if (typeof stack === 'string' && stack !== '') return stack;
      return String(err.message);
    }
    return String(err);
  } catch {
    return 'a thrown value that cannot be converted to a string';
  }
}

/** How long the fallback waits for output to reach the parent before exiting anyway. */
const FLUSH_TIMEOUT_MS = 2_000;

/**
 * The fallback when stdio could not be made blocking: exit once zero-length
 * writes on both streams have flushed, which runs after every earlier
 * write. `exitCode` is set first so that a loop that empties early still
 * reports the failure; the ref'd timer keeps a hook's open handles from
 * holding the exit past `FLUSH_TIMEOUT_MS`.
 */
function exitAfterFlush(code: number): void {
  process.exitCode = code;
  let pending = 2;
  const done = (): void => {
    pending -= 1;
    if (pending === 0) process.exit(code);
  };
  process.stdout.write('', done);
  process.stderr.write('', done);
  setTimeout(() => process.exit(code), FLUSH_TIMEOUT_MS);
}

main().catch((err: unknown) => {
  process.stderr.write(`${describe(err)}\n`);
  // An import that failed, or the hook's function that threw.
  reportFailure(process.argv[3], stage);
  if (stdioBlocking) process.exit(1);
  else exitAfterFlush(1);
});
