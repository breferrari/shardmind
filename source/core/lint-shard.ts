/**
 * Check a shard directory the way install would, collecting every finding
 * instead of stopping at the first (#34). `shardmind validate` runs it on a
 * shard an author is about to publish; #35's pre-install check calls it too.
 *
 * It never runs shard code: no hook slot is looked up or executed.
 * Spec: docs/IMPLEMENTATION.md §4.22, docs/ARCHITECTURE.md §10.5b.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import ignore from 'ignore';
import type { ModuleSelections, ShardManifest, ShardSchema } from '../runtime/types.js';
import { ShardMindError } from '../runtime/types.js';
import { SHARD_MANIFEST_FILE, SHARD_SCHEMA_FILE, SHARD_SOURCE_DIR, HOOK_STAGES, hookLogRelPath } from '../runtime/vault-paths.js';
import { assertEngineCompatible, parseManifest } from './manifest.js';
import { buildValuesValidator, parseSchema } from './schema.js';
import { resolveComputedDefaults } from './install-planner.js';
import { resolveModules } from './modules.js';
import { findOutputClashes, outputClashError, plannedOutputRefs } from './output-clash.js';
import { buildRenderContext, compileTemplate, createRenderer, renderFile } from './renderer.js';

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
  opts: {
    values?: Record<string, unknown>;
    engineVersion?: string;
    /** The vault being installed into, for `vault_name` / `vault_slug`; `''` without it. */
    vaultRoot?: string;
    /** Throw an error that is not a ShardMindError (an engine bug, an I/O failure) instead of listing it. */
    rethrowUnexpected?: boolean;
    /** The files git tracks (#320): only these are walked, as the release tarball holds them. */
    tracked?: ReadonlySet<string>;
  },
): Promise<LintResult> {
  const findings: LintFinding[] = [];
  const error = (err: unknown, filePath?: string): void => {
    const known = err instanceof ShardMindError;
    if (!known && opts.rethrowUnexpected) throw err;
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

  // External tools (#138): a `when` must name a boolean value. Checked here,
  // before any step that stops, and no tool is ever run.
  for (const [name, tool] of Object.entries(manifest.external_tools ?? {})) {
    if (tool.when === undefined || schema.values[tool.when]?.type === 'boolean') continue;
    findings.push({
      severity: 'error',
      code: 'EXTERNAL_TOOL_WHEN_INVALID',
      message: `external_tools.${name}.when names '${tool.when}', which is not a boolean value in shard-schema.yaml`,
      hint: 'Point `when` at a boolean value the schema declares, or remove it to check the tool on every install.',
    });
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
    resolution = await resolveModules(schema, selections, shardDir, { tracked: opts.tracked });
  } catch (err) {
    error(err);
    return done();
  }

  const context = buildRenderContext(manifest, values, selections, new Date(), opts.vaultRoot);
  const env = createRenderer(shardDir);
  // A rendered `.gitignore.njk`, kept for the hook-log check below (#201).
  let renderedGitignore: string | undefined;
  for (const entry of resolution.render) {
    try {
      const list = entry.iterator ? values[entry.iterator] : undefined;
      // An `_each` over an empty list renders nothing, so compile it instead.
      if (Array.isArray(list) && list.length === 0) {
        await compileTemplate(entry, env);
      } else {
        const rendered = await renderFile(entry, context, env);
        if (entry.outputPath === '.gitignore' && !Array.isArray(rendered)) renderedGitignore = rendered.content;
      }
    } catch (err) {
      error(err, entry.outputPath);
    }
  }

  // Two outputs naming one vault path (#240), `_each` lists expanded with
  // these values. Every clash is reported. Two different modules may be
  // alternatives a user picks between, so a clash across modules is a
  // warning; within one module, or with an always-installed file, an error.
  for (const clash of findOutputClashes(plannedOutputRefs(resolution, values, shardDir))) {
    const a = clash.first.module ?? null;
    const b = clash.second.module ?? null;
    if (a !== null && b !== null && a !== b) {
      findings.push({
        severity: 'warning',
        code: 'LINT_OUTPUT_CLASH_ACROSS_MODULES',
        message: `Modules '${a}' and '${b}' clash: ${clash.first.origin} and ${clash.second.origin} both install to ${clash.at}`,
        hint: `A user who selects both '${a}' and '${b}' is refused with OUTPUT_PATH_CLASH; either one alone installs. Fine if they are alternatives; otherwise rename one file.`,
      });
    } else {
      error(outputClashError(clash));
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

  // Hook logs land in `.shardmind/logs/` inside the vault, which is often a
  // git repository: the .gitignore the shard installs should keep them out
  // (#201). The engine writes no .gitignore of its own.
  if (HOOK_STAGES.some((slot) => manifest.hooks[slot])) {
    const gitignore = [...resolution.copy, ...resolution.render].find((e) => e.outputPath === '.gitignore');
    // Its text: copied as is, or as rendered above. A .gitignore.njk that
    // failed to render is already reported, so it is left unjudged here.
    const gitignoreText =
      gitignore && resolution.copy.includes(gitignore) ? await fs.readFile(gitignore.sourcePath, 'utf-8') : renderedGitignore;
    const logFile = hookLogRelPath('bootstrap');
    const logs = path.posix.dirname(logFile);
    const logsIgnored = gitignoreText === undefined || ignore().add(gitignoreText).ignores(logFile);
    if (!gitignore || !logsIgnored) {
      findings.push({
        severity: 'warning',
        code: 'LINT_LOGS_NOT_GITIGNORED',
        message: gitignore
          ? `The shard's .gitignore does not ignore ${logs}/, where its hooks' logs land`
          : `The shard declares a hook but installs no .gitignore, so its hooks' logs in ${logs}/ can be committed`,
        hint: `List ${logs}/ in the .gitignore at the shard's root. See docs/AUTHORING.md.`,
      });
    }
  }

  return done();
}

function isComputed(value: unknown): boolean {
  return typeof value === 'string' && value.includes('{{');
}

/** The error findings, warnings dropped. */
export function errorFindings(findings: readonly LintFinding[]): LintFinding[] {
  return findings.filter((f) => f.severity === 'error');
}

/** Codes `lintShard` emits when the values are wrong, not the shard (its values step). */
// A clash can come from the prefill's own `_each` items (#234, #240): if it
// is gone with the defaults alone, it is the user's to fix, not the shard's.
const VALUE_CODES = new Set(['VALUES_INVALID', 'COMPUTED_DEFAULT_FAILED', 'OUTPUT_PATH_CLASH', 'RENDER_ITERATOR_NAME_CLASH']);

/**
 * Install's pre-wizard check (#35): `lintShard` for the vault it installs
 * into, with the `--values` prefill over the defaults. A prefill the schema
 * rejects is the user's to fix in the wizard (or a later VALUES_INVALID under
 * --yes), so the shard is then checked with the defaults alone. Any error left
 * throws INSTALL_SHARD_INVALID listing every one; warnings never block. An
 * engine bug or an I/O failure is thrown as itself, not blamed on the shard.
 */
export async function assertShardInstallable(
  shardDir: string,
  prefill: Record<string, unknown>,
  vaultRoot: string,
): Promise<void> {
  const lint = (values: Record<string, unknown>) =>
    lintShard(shardDir, { values, vaultRoot, rethrowUnexpected: true }).then((r) => errorFindings(r.findings));
  let errors = await lint(prefill);
  if (Object.keys(prefill).length > 0 && errors.some((f) => VALUE_CODES.has(f.code))) {
    errors = await lint({});
  }
  if (errors.length === 0) return;
  // Path, message and code, as `shardmind validate` lists them. The path is
  // left out when the message already names it, and a multi-line message
  // stays indented under its bullet.
  const lines = errors.map((f) => {
    const where = f.path && !f.message.includes(f.path) ? `${f.path}: ` : '';
    return `  - ${where}${f.message} [${f.code}]`.replace(/\n/g, '\n    ');
  });
  throw new ShardMindError(
    `The shard has ${errors.length} problem${errors.length === 1 ? '' : 's'}; nothing was asked or written:\n${lines.join('\n')}`,
    'INSTALL_SHARD_INVALID',
    'Shard author: run `shardmind validate` on the shard. User: report it to the shard author, or install an earlier version.',
  );
}
