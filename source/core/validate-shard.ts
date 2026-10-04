/**
 * `shardmind validate` (#34): check a shard directory, or a shard reference
 * downloaded the way install downloads it, with `lintShard`. Never runs
 * shard code. Spec: docs/ARCHITECTURE.md §10.5b.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { downloadShard } from './download.js';
import { resolve as resolveRef } from './registry.js';
import { loadValuesYaml } from './values-io.js';
import { lintShard, type LintFinding } from './lint-shard.js';
import { emitJson, jsonFailure, jsonSuccess } from './json-output.js';

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
  opts: { valuesFile?: string; engineVersion?: string },
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
  if (await isDirectory(dir)) return report(dir, (await lintShard(dir, lintOpts)).findings);

  const resolved = await resolveRef(target);
  const shard = await downloadShard(resolved.tarballUrl);
  try {
    return report(target, (await lintShard(shard.tempDir, lintOpts)).findings);
  } finally {
    await shard.cleanup().catch(() => {});
  }
}

function report(target: string, findings: LintFinding[]): ValidateReport {
  const errors = findings.filter((f) => f.severity === 'error').length;
  return { target, findings, errors, warnings: findings.length - errors };
}

async function isDirectory(abs: string): Promise<boolean> {
  return fsp.stat(abs).then((s) => s.isDirectory(), () => false);
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
  const { target, valuesFile } = parseValidateArgv(argv);
  try {
    const result = await validateShard(target, { ...(valuesFile ? { valuesFile } : {}), ...(engineVersion ? { engineVersion } : {}) });
    emitJson(jsonSuccess('validate', result), write);
    return result.errors > 0 ? 1 : 0;
  } catch (err) {
    emitJson(jsonFailure('validate', err), write);
    return 1;
  }
}

/** The target (default `.`) and `--values <file>` / `--values=<file>`; other flags are ignored. */
export function parseValidateArgv(argv: readonly string[]): { target: string; valuesFile?: string } {
  let target: string | undefined;
  let valuesFile: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--values') {
      valuesFile = argv[++i];
    } else if (arg.startsWith('--values=')) {
      valuesFile = arg.slice('--values='.length);
    } else if (!arg.startsWith('-') && target === undefined) {
      target = arg;
    }
  }
  return { target: target ?? '.', ...(valuesFile ? { valuesFile } : {}) };
}
