/**
 * Check a shard directory the way install would, collecting every finding
 * instead of stopping at the first (#34). `shardmind validate` runs it on a
 * shard an author is about to publish; #35's pre-install check calls it too.
 *
 * It never runs shard code: no hook slot is looked up or executed.
 * Spec: docs/IMPLEMENTATION.md §4.22, docs/ARCHITECTURE.md §10.5b.
 */

import path from 'node:path';
import type { ModuleSelections, ShardManifest, ShardSchema } from '../runtime/types.js';
import { ShardMindError } from '../runtime/types.js';
import { SHARD_MANIFEST_FILE, SHARD_SCHEMA_FILE, SHARD_SOURCE_DIR } from '../runtime/vault-paths.js';
import { assertEngineCompatible, parseManifest } from './manifest.js';
import { buildValuesValidator, parseSchema } from './schema.js';
import { resolveComputedDefaults } from './install-planner.js';
import { resolveModules } from './modules.js';
import { buildRenderContext, createRenderer, renderFile } from './renderer.js';

export interface LintFinding {
  severity: 'error' | 'warning';
  /** An ErrorCode for errors; a `LINT_*` label for warnings. */
  code: string;
  message: string;
  hint?: string;
  /** The output path the finding is about, when it is about one file. */
  path?: string;
}

export interface LintResult {
  findings: LintFinding[];
}

export async function lintShard(
  shardDir: string,
  opts: { values?: Record<string, unknown>; engineVersion?: string },
): Promise<LintResult> {
  const findings: LintFinding[] = [];
  const error = (err: unknown, filePath?: string): void => {
    const known = err instanceof ShardMindError;
    findings.push({
      severity: 'error',
      code: known ? err.code : 'UNEXPECTED',
      message: err instanceof Error ? err.message : String(err),
      ...(known && err.hint ? { hint: err.hint } : {}),
      ...(filePath === undefined ? {} : { path: filePath }),
    });
  };
  const done = (): LintResult => ({ findings });

  let manifest: ShardManifest;
  try {
    manifest = await parseManifest(path.join(shardDir, SHARD_SOURCE_DIR, SHARD_MANIFEST_FILE));
  } catch (err) {
    error(err);
    return done();
  }
  try {
    assertEngineCompatible(manifest, opts.engineVersion);
  } catch (err) {
    error(err);
  }

  let schema: ShardSchema;
  try {
    schema = await parseSchema(path.join(shardDir, SHARD_SOURCE_DIR, SHARD_SCHEMA_FILE));
  } catch (err) {
    error(err);
    return done();
  }

  // Values: supplied ones over the schema's defaults, then computed
  // defaults. Every value declares a default (parseSchema refuses one that
  // does not), so nothing is made up.
  // A supplied key the schema does not declare is reported, not dropped:
  // install would ignore it, which hides a typo in a --values file.
  for (const key of Object.keys(opts.values ?? {})) {
    if (key in schema.values) continue;
    findings.push({
      severity: 'error',
      code: 'VALUES_FILE_INVALID',
      message: `Supplied value '${key}' is not declared in shard-schema.yaml`,
      hint: 'Remove it, or fix its name to match a key under `values`.',
    });
  }
  // Validated without the undeclared keys, so each is reported once.
  let values: Record<string, unknown> = Object.fromEntries(
    Object.entries(opts.values ?? {}).filter(([key]) => key in schema.values),
  );
  for (const [key, def] of Object.entries(schema.values)) {
    if (values[key] === undefined && def.default !== undefined && !isComputed(def.default)) values[key] = def.default;
  }
  // A failed computed default leaves later values unset, and invalid values
  // would fail every template that uses them: stop at the root cause rather
  // than list its echoes.
  try {
    values = resolveComputedDefaults(schema, values);
  } catch (err) {
    error(err);
    return done();
  }
  const parsed = buildValuesValidator(schema).safeParse(values);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      findings.push({
        severity: 'error',
        code: 'VALUES_INVALID',
        message: `Value '${issue.path.join('.')}' is invalid: ${issue.message}`,
      });
    }
    return done();
  }

  const selections: ModuleSelections = Object.fromEntries(Object.keys(schema.modules).map((id) => [id, 'included']));
  let resolution;
  try {
    resolution = await resolveModules(schema, selections, shardDir);
  } catch (err) {
    error(err);
    return done();
  }

  const context = buildRenderContext(manifest, values, selections);
  const env = createRenderer(shardDir);
  for (const entry of resolution.render) {
    try {
      await renderFile(entry, context, env);
    } catch (err) {
      error(err, entry.outputPath);
    }
  }

  const modulesWithFiles = new Set(
    [...resolution.render, ...resolution.copy, ...resolution.skip].map((e) => e.module).filter((m) => m !== null),
  );
  for (const [id, mod] of Object.entries(schema.modules)) {
    if (modulesWithFiles.has(id)) continue;
    findings.push({
      severity: 'warning',
      code: 'LINT_MODULE_EMPTY',
      message: `Module '${id}' matches no file in the shard (${mod.label})`,
      hint: 'Check its paths, commands, agents and bases, or remove the module.',
    });
  }
  const groupsInUse = new Set(Object.values(schema.values).map((def) => def.group));
  for (const group of schema.groups) {
    if (groupsInUse.has(group.id)) continue;
    findings.push({
      severity: 'warning',
      code: 'LINT_GROUP_EMPTY',
      message: `Group '${group.id}' has no values`,
      hint: 'Add values to it, or remove the group.',
    });
  }

  return done();
}

function isComputed(value: unknown): boolean {
  return typeof value === 'string' && value.includes('{{');
}


/** Value findings: the answers are wrong, not the shard. */
const VALUE_CODES = new Set(['VALUES_INVALID', 'COMPUTED_DEFAULT_FAILED']);

/**
 * Install's pre-wizard check (#35): `lintShard` with the `--values` prefill
 * over the defaults. A prefill the schema rejects is the user's to fix in the
 * wizard (or a later VALUES_INVALID under --yes), so the shard is then checked
 * with the defaults alone. Any error left throws INSTALL_SHARD_INVALID listing
 * every one; warnings never block.
 */
export async function assertShardInstallable(shardDir: string, prefill: Record<string, unknown>): Promise<void> {
  let { findings } = await lintShard(shardDir, { values: prefill });
  const errorsOf = (fs: LintFinding[]) => fs.filter((f) => f.severity === 'error');
  if (errorsOf(findings).some((f) => VALUE_CODES.has(f.code)) && Object.keys(prefill).length > 0) {
    findings = (await lintShard(shardDir, {})).findings;
  }
  const errors = errorsOf(findings);
  if (errors.length === 0) return;
  const lines = errors.map((f) => `  - ${f.code}${f.path ? ` ${f.path}` : ''}: ${f.message}`);
  throw new ShardMindError(
    `The shard has ${errors.length} problem${errors.length === 1 ? '' : 's'}; nothing was asked or written:\n${lines.join('\n')}`,
    'INSTALL_SHARD_INVALID',
    'Shard author: run `shardmind validate` on the shard. User: report it to the shard author, or install an earlier version.',
  );
}
