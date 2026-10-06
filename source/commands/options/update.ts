/**
 * The update command's options (`commands/update.tsx`), Ink-free so its
 * headless `--json` run can parse with them (#302).
 */

import zod from 'zod';
import { updateCheckOption } from '../hooks/update-check-option.js';

export const options = zod.object({
  yes: zod.boolean().default(false).describe('Accept defaults for every prompt (auto-keeps conflicts)'),
  verbose: zod.boolean().default(false).describe('Show per-file action history during write'),
  dryRun: zod.boolean().default(false).describe('Plan the update without touching the vault'),
  json: zod
    .boolean()
    .default(false)
    .describe('Emit machine-readable JSON instead of the TUI; with --dry-run, the per-file plan'),
  // Named `--release <v>` because Pastel reserves the program-level
  // `--version` for "print package version" (`shardmind --version`).
  // Trying to expose `update --version 0.2.0` would silently print the
  // package version and exit. `--release` matches GitHub's terminology
  // for tagged releases and avoids the collision.
  release: zod
    .string()
    .optional()
    .describe('Pin the update to a specific shard release tag (stable or prerelease)'),
  includePrerelease: zod
    .boolean()
    .default(false)
    .describe('Widen latest-release resolution to include prereleases'),
  adoptPreexisting: zod
    .boolean()
    .default(false)
    .describe('Track a file you keep at a path the new version adds as your modified copy'),
  updateCheck: updateCheckOption,
});
