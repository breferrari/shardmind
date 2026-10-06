/**
 * `shardmind validate` (#34): check a shard directory, or a shard reference
 * downloaded the way install downloads it, with `lintShard`. Never runs
 * shard code. Spec: docs/ARCHITECTURE.md §10.5b.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { downloadShard, DownloadCancelledError } from './download.js';
import { resolve as resolveRef } from './registry.js';
import { loadValuesYaml } from './values-io.js';
import { errorFindings, lintShard, type LintFinding } from './lint-shard.js';
import { emitJson, jsonFailure, jsonSuccess } from './json-output.js';
import { ShardMindError } from '../runtime/types.js';

export interface ValidateReport {
  /** What was checked: the absolute directory, or the reference as given. */
  target: string;
  findings: LintFinding[];
  errors: number;
  warnings: number;
}

/**
 * Lint `target`: a directory when one exists at that path, else a shard
 * reference resolved and downloaded as install does (size and entry limits
 * included). A downloaded copy is removed on every exit, error included.
 * Throws a ShardMindError when the target cannot be read or fetched, or the
 * values file cannot be loaded.
 */
export async function validateShard(
  target: string,
  opts: {
    valuesFile?: string;
    engineVersion?: string;
    /** Receives the download's cleanup before the fetch, so a Ctrl+C can remove it (#57). */
    onTempDir?: (cleanup: () => Promise<void>) => void;
  },
): Promise<ValidateReport> {
  // Loaded without a schema filter: lintShard reports a key the schema does
  // not declare instead of dropping it.
  const values = opts.valuesFile
    ? await loadValuesYaml(opts.valuesFile, {
        label: '--values file',
        errors: { readFailed: 'VALUES_FILE_READ_FAILED', invalid: 'VALUES_FILE_INVALID' },
      })
    : undefined;
  const lintOpts = { ...(values ? { values } : {}), ...(opts.engineVersion ? { engineVersion: opts.engineVersion } : {}) };

  const dir = path.resolve(target);
  const kind = await fsp.stat(dir).then((s) => (s.isDirectory() ? 'dir' : 'file'), () => 'none');
  if (kind === 'dir') return report(dir, (await lintShard(dir, lintOpts)).findings);
  // A path that is a file, or that is spelled as a path and missing, is the
  // author's typo, not a shard reference to look up.
  if (kind === 'file' || looksLikePath(target)) {
    throw new ShardMindError(
      kind === 'file' ? `Not a shard directory: ${target}` : `No such shard directory: ${target}`,
      'VALIDATE_TARGET_INVALID',
      'Pass a shard directory (the folder holding .shardmind/shard.yaml) or a shard reference such as github:owner/repo.',
    );
  }

  const resolved = await resolveRef(target, { command: 'validate' });
  // A shard whose manifest or schema cannot be loaded fails in the download
  // itself (DOWNLOAD_MISSING_*), as for install: reported as ok: false.
  const shard = await downloadShard(resolved.tarballUrl, opts.onTempDir);
  try {
    return report(target, (await lintShard(shard.tempDir, lintOpts)).findings);
  } finally {
    await shard.cleanup().catch(() => {});
  }
}

function report(target: string, findings: LintFinding[]): ValidateReport {
  const errors = errorFindings(findings).length;
  return { target, findings, errors, warnings: findings.length - errors };
}

/** `.`, `..`, an absolute path or anything with a path separator; a shard reference has none of these. */
function looksLikePath(target: string): boolean {
  return /^\.{1,2}($|[\\/])/.test(target) || path.isAbsolute(target) || /[\\]/.test(target) || (target.includes('/') && !target.includes(':') && target.split('/').length > 2);
}

/**
 * `validate --json`, run before Pastel loads so Ink never mounts and the
 * document carries no terminal control codes, even in a terminal (#198).
 * `argv` is what follows `validate`. Returns the exit code: 1 when the shard
 * has an error or the target could not be checked.
 */
export async function runValidateJson(
  argv: readonly string[],
  engineVersion: string | undefined,
  write: (chunk: string) => void = (chunk) => void process.stdout.write(chunk),
): Promise<number> {
  let cleanup: (() => Promise<void>) | undefined;
  // Ctrl+C mid-download: remove the temp dir before exiting 130 (#57).
  const onSigint = (): void => {
    void (cleanup?.() ?? Promise.resolve()).finally(() => process.exit(130));
  };
  process.once('SIGINT', onSigint);
  try {
    const { target, valuesFile } = parseValidateArgv(argv);
    const result = await validateShard(target, {
      ...(valuesFile ? { valuesFile } : {}),
      ...(engineVersion ? { engineVersion } : {}),
      onTempDir: (c) => {
        cleanup = c;
      },
    });
    emitJson(jsonSuccess('validate', result), write);
    return result.errors > 0 ? 1 : 0;
  } catch (err) {
    // A Ctrl+C stopped the download: the SIGINT handler exits 130, and the
    // caller gets no document for a run it cancelled.
    if (err instanceof DownloadCancelledError) return 130;
    emitJson(jsonFailure('validate', err), write);
    return 1;
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}

/**
 * The target (default `.`) and `--values <file>` / `--values=<file>`. Other
 * flags are ignored; after `--` every argument is positional. A `--values`
 * with no file is refused, as Pastel refuses it.
 */
export function parseValidateArgv(argv: readonly string[]): { target: string; valuesFile?: string } {
  let target: string | undefined;
  let valuesFile: string | undefined;
  let optionsDone = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (optionsDone) {
      target ??= arg;
    } else if (arg === '--') {
      optionsDone = true;
    } else if (arg === '--values') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        throw new ShardMindError('--values needs a file', 'VALIDATE_TARGET_INVALID', 'Pass --values <file.yaml>.');
      }
      valuesFile = next;
      i += 1;
    } else if (arg.startsWith('--values=')) {
      valuesFile = arg.slice('--values='.length);
    } else if (!arg.startsWith('-') && target === undefined) {
      target = arg;
    }
  }
  return { target: target ?? '.', ...(valuesFile ? { valuesFile } : {}) };
}
