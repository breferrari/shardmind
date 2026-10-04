import fs from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import semver from 'semver';
import { z } from 'zod';
import type { ShardManifest } from '../runtime/types.js';
import { ShardMindError } from '../runtime/types.js';
import { errnoCode } from '../runtime/errno.js';

const SemverSchema = z.string().refine((v) => semver.valid(v) !== null, 'Must be valid semver');

/**
 * A vault path in a rename migration: relative, POSIX, inside the vault
 * and outside the engine's own `.shardmind/` (#178).
 */
const VaultPathSchema = z
  .string()
  .refine((p) => p.length > 0, 'Must not be empty')
  .refine((p) => !p.includes('\\'), 'Must use forward slashes')
  .refine((p) => !p.startsWith('/') && !/^[A-Za-z]:/.test(p), 'Must be relative to the vault')
  .refine((p) => !p.split('/').includes('..'), 'Must stay inside the vault')
  // Written as it is tracked: `./a.md`, `a//b.md` or `b/` never match a path.
  .refine((p) => p.split('/').every((seg) => seg !== '' && seg !== '.'), 'Must be a plain path: no empty or "." segments, no trailing slash')
  .refine((p) => !['.shardmind', '.git'].includes(p.split('/')[0]!.toLowerCase()), 'Must not be under .shardmind/ or .git/');

const RenameMigrationSchema = z
  .object({
    from: SemverSchema,
    to: SemverSchema,
    renames: z.record(VaultPathSchema, VaultPathSchema),
  })
  .superRefine((m, ctx) => {
    if (semver.valid(m.from) && semver.valid(m.to) && !semver.gt(m.to, m.from)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: 'Must be a later version than `from`' });
    }
    const seen = new Set<string>();
    for (const [oldPath, newPath] of Object.entries(m.renames)) {
      if (oldPath === newPath) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['renames', oldPath], message: 'Renames a path to itself' });
      }
      if (seen.has(newPath)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['renames', oldPath], message: `Two paths are renamed to ${newPath}` });
      }
      seen.add(newPath);
    }
  });

// External tools (#138). The patterns keep shard text out of any shell's
// parser: the probe is spawned without a shell, and on Windows a .cmd shim
// goes through cmd.exe (core/external-tools.ts), where none of
// & | < > ^ % " ! or whitespace may appear. See SHARD-LAYOUT.md §External tools.
export const TOOL_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
export const TOOL_ARG_PATTERN = /^[A-Za-z0-9._=-]+$/;
const ToolNameSchema = z.string().regex(TOOL_NAME_PATTERN, 'Must be an executable name: lowercase letters, digits, ., _ and -');
const ToolArgSchema = z.string().regex(TOOL_ARG_PATTERN, 'Must use only letters, digits, ., _, = and -');
const NpmPackageSchema = z
  .string()
  .regex(/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/, 'Must be an npm package name');
const SemverRangeSchema = z
  .string()
  .refine(v => v.trim().length > 0 && semver.validRange(v) !== null, 'Must be a valid, non-empty semver range');

const ExternalToolSchema = z.object({
  package: NpmPackageSchema,
  version: SemverRangeSchema,
  command: ToolNameSchema,
  args: z.array(ToolArgSchema).default(['--version']),
  optional: z.boolean().default(false),
  // A boolean value key; lint checks it names one (EXTERNAL_TOOL_WHEN_INVALID).
  when: z.string().optional(),
});

export const ShardManifestSchema = z.object({
  apiVersion: z.literal('v1'),
  name: z.string().regex(/^[a-z0-9-]+$/, 'Must be lowercase alphanumeric with hyphens'),
  namespace: z.string().regex(/^[a-z0-9-]+$/, 'Must be lowercase alphanumeric with hyphens'),
  version: SemverSchema,
  description: z.string().optional(),
  persona: z.string().optional(),
  license: z.string().optional(),
  homepage: z.string().url().optional(),
  requires: z.object({
    obsidian: z.string().optional(),
    node: z.string().optional(),
    // Semver range the running engine must satisfy (#121). Validated as a
    // range at parse time (same posture as `version`'s semver.valid refine) so
    // a typo surfaces as MANIFEST_VALIDATION_FAILED, not a runtime mismatch.
    // The non-empty guard is load-bearing: `semver.validRange('')` and any
    // whitespace-only string both normalize to `*` (match-all), so without it
    // a declared-but-empty `shardmind: ""` would parse clean and then silently
    // disable the check — worse than a typo, because it reads as a constraint.
    // Deliberate match-all (`*`, `x`) stays valid.
    shardmind: z
      .string()
      .refine(v => v.trim().length > 0 && semver.validRange(v) !== null, 'Must be a valid, non-empty semver range')
      .optional(),
  }).optional(),
  dependencies: z.array(z.object({
    name: z.string(),
    namespace: z.string(),
    version: z.string(),
  })).default([]),
  hooks: z.object({
    // `bootstrap` accepts the bare-string form (`bootstrap: path`) or the
    // object form (`bootstrap: { script, fingerprint? }`). The string arm is
    // normalized into the object shape so every downstream consumer sees one
    // shape (`{ script, fingerprint? }`). See SHARD-LAYOUT.md §Hook lifecycle.
    bootstrap: z
      .union([
        z.string().transform((script) => ({ script })),
        z.object({ script: z.string(), fingerprint: z.string().optional() }),
      ])
      .optional(),
    personalize: z.string().optional(),
    'post-update': z.string().optional(),
    // Deprecated combined hook. Mutually exclusive with bootstrap/personalize;
    // the conflict is rejected post-parse as HOOK_SLOT_CONFLICT (a superRefine
    // would surface only as the generic MANIFEST_VALIDATION_FAILED).
    'post-install': z.string().optional(),
    // Per-shard hook execution timeout in milliseconds. Default 30_000 when
    // absent. Clamped to 1_000..600_000 — below one second is almost always a
    // bug (even a trivial `git init` hits ~50ms with warm caches but 200ms
    // cold); above ten minutes exceeds any legitimate first-run setup we want
    // to block the install TUI on.
    timeout_ms: z.number().int().min(1_000).max(600_000).optional(),
  }).default({}),
  // Path renames between releases (#178). See SHARD-LAYOUT.md §Rename migrations.
  migrations: z.array(RenameMigrationSchema).optional(),
  // Command-line tools the shard needs (#138). See SHARD-LAYOUT.md §External tools.
  external_tools: z.record(ToolNameSchema, ExternalToolSchema).optional(),
});

/**
 * Default hook execution timeout when a manifest doesn't override
 * `hooks.timeout_ms`. See docs/ARCHITECTURE.md §9.3.
 */
export const DEFAULT_HOOK_TIMEOUT_MS = 30_000;

export async function parseManifest(filePath: string): Promise<ShardManifest> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    const fsCode = errnoCode(err);
    if (fsCode === 'ENOENT') {
      throw new ShardMindError(
        `Cannot read shard.yaml: ${filePath}`,
        'MANIFEST_NOT_FOUND',
        'Check the file path and ensure shard.yaml exists.',
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new ShardMindError(
      `Cannot read shard.yaml: ${filePath} (${fsCode ?? 'unknown'})`,
      'MANIFEST_READ_FAILED',
      message,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ShardMindError(
      `shard.yaml is not valid YAML: ${message}`,
      'MANIFEST_INVALID_YAML',
      'Check shard.yaml for syntax errors.',
    );
  }

  const result = ShardManifestSchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues
      .map(i => `${i.path.length === 0 ? '(root)' : i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new ShardMindError(
      `shard.yaml validation failed: ${details}`,
      'MANIFEST_VALIDATION_FAILED',
      'Check shard.yaml against the shard manifest spec.',
    );
  }

  // The deprecated `post-install` slot cannot coexist with the new
  // `bootstrap` / `personalize` slots — a half-migrated manifest is a
  // mistake, not a merge. Reject post-parse so the hint is precise (a zod
  // superRefine would collapse into the generic MANIFEST_VALIDATION_FAILED).
  const hooks = result.data.hooks;
  if (hooks['post-install'] && (hooks.bootstrap || hooks.personalize)) {
    throw new ShardMindError(
      'shard.yaml declares the deprecated hooks.post-install alongside hooks.bootstrap/personalize.',
      'HOOK_SLOT_CONFLICT',
      'Remove hooks.post-install once you have split it into bootstrap + personalize. See docs/AUTHORING.md §6.',
    );
  }

  return result.data as ShardManifest;
}

/**
 * Refuse install/update/adopt when the running engine can't satisfy the shard's
 * declared `requires.shardmind` range (#121). Pure — the caller supplies the
 * engine version (see `resolveEngineVersion` in commands/hooks/cli-version.ts),
 * so this stays testable without process state and keeps the `'0.0.0'` fallback
 * sentinel a commands-layer concern.
 *
 * No-ops when:
 *  - the manifest declares no `requires.shardmind` (every pre-#121 shard), or
 *  - `engineVersion` is `undefined` / not valid semver — an unresolvable engine
 *    version is a bundle-layout quirk, not a reason to hard-block a real install.
 *
 * `includePrerelease` so a prerelease engine *ahead* of the floor (e.g.
 * `0.3.0-beta.1` against `>=0.2.0`) isn't wrongly blocked — default
 * `satisfies` rejects any prerelease against a stable range. A prerelease of
 * the required version itself (`0.2.0-beta.1`) still fails: it sorts before
 * the `0.2.0` release, so the engine is genuinely too old.
 */
export function assertEngineCompatible(
  manifest: ShardManifest,
  engineVersion: string | undefined,
): void {
  const range = manifest.requires?.shardmind;
  if (!range) return;
  if (!engineVersion || semver.valid(engineVersion) === null) return;
  if (semver.satisfies(engineVersion, range, { includePrerelease: true })) return;

  throw new ShardMindError(
    `This shard requires shardmind ${range}, but you are running ${engineVersion}.`,
    'SHARDMIND_VERSION_MISMATCH',
    'Upgrade the engine with `npm i -g shardmind@latest`, then retry.',
  );
}
