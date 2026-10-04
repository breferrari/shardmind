/**
 * The command-line tools a shard declares in `external_tools`, checked
 * against their version ranges before install, adopt and update write
 * anything (#138). Spec: docs/IMPLEMENTATION.md §4.26; contract:
 * docs/SHARD-LAYOUT.md §External tools.
 *
 * Pure apart from the probe, which callers pass in (tests never spawn). A
 * dry run and `validate` never run a probe: no shard-supplied command runs
 * there.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import semver from 'semver';
import { ShardMindError, type ExternalTool, type ShardManifest } from '../runtime/types.js';
import { errnoCode, isEnoent } from '../runtime/errno.js';
import { TOOL_ARG_PATTERN, TOOL_NAME_PATTERN } from './manifest.js';

export type ProbeOutcome =
  | { kind: 'output'; stdout: string }
  | { kind: 'not-found' }
  /** A non-zero exit, a timeout, or a probe refused as unsafe. */
  | { kind: 'failed'; reason: string };

export type ToolProbe = (command: string, args: readonly string[]) => Promise<ProbeOutcome>;

type UnmetTool = { name: string; status: 'unmet'; reason: string; hint: string; optional: boolean };

export type ToolResult =
  | { name: string; status: 'met'; version: string }
  | { name: string; status: 'skipped' }
  | UnmetTool;

/** The install command for a version inside the declared range. */
function installHint(tool: ExternalTool): string {
  return `npm i -g ${tool.package}@"${tool.version}"`;
}

/** What one probe outcome means for one tool. */
function judge(name: string, tool: ExternalTool, outcome: ProbeOutcome): ToolResult {
  const unmet = (reason: string): ToolResult => ({ name, status: 'unmet', reason, hint: installHint(tool), optional: tool.optional });
  if (outcome.kind === 'not-found') return unmet('not found on PATH');
  if (outcome.kind === 'failed') return unmet(outcome.reason);
  const version = semver.coerce(outcome.stdout, { includePrerelease: true })?.version;
  if (version === undefined) return unmet('printed no version');
  if (!semver.satisfies(version, tool.version, { includePrerelease: true })) return unmet(`found ${version}, needs ${tool.version}`);
  return { name, status: 'met', version };
}

/** Every declared tool's result, in declaration order. The probes run at once. */
export async function checkExternalTools(
  manifest: ShardManifest,
  values: Record<string, unknown>,
  probe: ToolProbe,
): Promise<ToolResult[]> {
  return Promise.all(
    Object.entries(manifest.external_tools ?? {}).map(async ([name, tool]): Promise<ToolResult> => {
      // Only a value that is false skips the check: a missing or non-boolean
      // one (lint reports it) checks the tool rather than silently passing it.
      if (tool.when !== undefined && values[tool.when] === false) return { name, status: 'skipped' };
      return judge(name, tool, await probe(tool.command, tool.args));
    }),
  );
}

/**
 * The one call install, adopt and update make, once the values are final
 * and before anything is written. Throws `EXTERNAL_TOOL_UNMET` when a
 * required tool is unmet. Otherwise returns the summary's lines: the dry-run
 * note, or one line per unmet optional tool with its install hint (none when
 * every tool is met, skipped, or none is declared).
 */
export async function checkExternalToolsForRun(opts: {
  manifest: ShardManifest;
  values: Record<string, unknown>;
  dryRun: boolean;
  probe?: ToolProbe;
}): Promise<string[]> {
  if (Object.keys(opts.manifest.external_tools ?? {}).length === 0) return [];
  if (opts.dryRun) return ['external tools not checked (dry run)'];

  const results = await checkExternalTools(opts.manifest, opts.values, opts.probe ?? spawnProbe);
  const unmet = results.filter((r): r is UnmetTool => r.status === 'unmet');
  if (unmet.some((r) => !r.optional)) {
    throw new ShardMindError(
      `This shard needs command-line tools that are missing or out of range:\n${unmet
        .map((r) => `  ${r.name}: ${r.reason}${r.optional ? ' (optional)' : ''}`)
        .join('\n')}`,
      'EXTERNAL_TOOL_UNMET',
      `Install a version in range, then retry:\n${unmet.map((r) => `  ${r.hint}`).join('\n')}`,
    );
  }
  return unmet.map((r) => `${r.name}: ${r.reason}. Install: ${r.hint}`);
}

// ---------------------------------------------------------------------------
// The production probe
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 5_000;
const STDOUT_CAP = 64 * 1024;
// Characters cmd.exe gives meaning to. A resolved path holding one is not
// run: it would reach cmd.exe's parser on Windows, and nothing legitimate
// needs it on PATH.
const UNSAFE_PATH = /[%"^&|<>!]/;

/** An environment variable by name, matched without case on Windows. */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (env[name] !== undefined) return env[name];
  if (process.platform !== 'win32') return undefined;
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

function isRunnableFile(file: string): boolean {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return false;
    return process.platform === 'win32' || (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** The absolute path `name` runs from on `PATH` (through `PATHEXT` on Windows). */
export function resolveExecutable(name: string, env: NodeJS.ProcessEnv): string | undefined {
  // Absolute entries only: a relative one (`.`, an empty segment) resolves
  // against the working directory, which is the vault, so a file the shard
  // shipped there could run as the tool.
  const dirs = (envValue(env, 'PATH') ?? '').split(path.delimiter).filter((dir) => path.isAbsolute(dir));
  const extensions =
    process.platform === 'win32'
      ? ['', ...(envValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)]
      : [''];
  for (const dir of dirs) {
    for (const extension of extensions) {
      // On Windows a bare name with no extension is not runnable by itself.
      if (process.platform === 'win32' && extension === '' && path.extname(name) === '') continue;
      const candidate = path.join(dir, name + extension);
      if (isRunnableFile(candidate)) return candidate;
    }
  }
  return undefined;
}

export function makeProbe(opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): ToolProbe {
  const env = opts.env ?? process.env;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async (command, args) => {
    // The manifest schema already refuses these; checked again here, since
    // this is the line a shard's text must never cross.
    if (!TOOL_NAME_PATTERN.test(command)) return { kind: 'failed', reason: 'unsafe command name' };
    if (args.some((arg) => !TOOL_ARG_PATTERN.test(arg))) return { kind: 'failed', reason: 'unsafe argument' };

    const resolved = resolveExecutable(command, env);
    if (resolved === undefined) return { kind: 'not-found' };
    if (UNSAFE_PATH.test(resolved)) return { kind: 'failed', reason: `unsafe path ${resolved}` };

    // A .cmd/.bat file (an npm global on Windows) cannot be spawned directly:
    // since the CVE-2024-27980 fix Node refuses with EINVAL. It runs through
    // cmd.exe with only the resolved path and the pattern-checked args, so no
    // shard text reaches cmd.exe's parser. Do not replace this with a direct
    // spawn or with `shell: true`.
    const batch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved);
    const file = batch
      ? envValue(env, 'ComSpec') ?? path.join(envValue(env, 'SystemRoot') ?? 'C:\\Windows', 'System32', 'cmd.exe')
      : resolved;
    const argv = batch ? ['/d', '/s', '/c', `""${resolved}" ${args.join(' ')}"`] : [...args];

    return new Promise<ProbeOutcome>((resolve) => {
      let settled = false;
      const settle = (outcome: ProbeOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(outcome);
      };
      const child = spawn(file, argv, {
        env,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        windowsVerbatimArguments: batch,
      });
      let stdout = '';
      // Decoded by the stream, so a character split across chunks stays whole.
      child.stdout.setEncoding('utf-8');
      child.stdout.on('data', (chunk: string) => {
        if (stdout.length < STDOUT_CAP) stdout += chunk.slice(0, STDOUT_CAP - stdout.length);
      });
      const timer = setTimeout(() => {
        child.kill();
        // A child of cmd.exe can outlive it and hold the pipe: stop reading.
        child.stdout.destroy();
        settle({ kind: 'failed', reason: `timed out after ${timeoutMs / 1000}s` });
      }, timeoutMs);
      child.on('error', (error: Error) => {
        settle(isEnoent(error) ? { kind: 'not-found' } : { kind: 'failed', reason: `could not start (${errnoCode(error) ?? error.message})` });
      });
      child.on('close', (code) => {
        settle(code === 0 ? { kind: 'output', stdout } : { kind: 'failed', reason: `exited ${code}` });
      });
    });
  };
}

export const spawnProbe: ToolProbe = makeProbe();
