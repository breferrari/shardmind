/**
 * The adopt command's args and options (`commands/adopt.tsx`), Ink-free so
 * its headless `--json` run can parse with them (#302).
 */

import zod from 'zod';
import { updateCheckOption } from '../hooks/update-check-option.js';

export const args = zod.tuple([
  zod
    .string()
    .describe(
      'Shard reference, e.g. "breferrari/obsidian-mind" or "github:owner/repo"',
    ),
]);

export const options = zod.object({
  values: zod.string().optional().describe('Path to a YAML file prefilling value answers'),
  yes: zod
    .boolean()
    .default(false)
    .describe('Skip prompts; auto-keep your version on every differs decision'),
  mode: zod
    .enum(['keep-all-mine', 'use-all-theirs', 'auto-merge', 'decide-per-file'])
    .optional()
    .describe(
      'Resolve divergent files in bulk, skipping the mode picker. keep-all-mine/use-all-theirs/auto-merge are non-interactive (auto-merge still prompts on conflicts unless --yes); decide-per-file is the per-file prompt. auto-merge is best-effort (keeps your bytes, ignores shard deletions, may duplicate — review after)',
    ),
  fromVersion: zod
    .string()
    .optional()
    .describe(
      "The shard release the vault was cloned from; adopt applies the shard's renames since then, so files at old paths are adopted at their new ones",
    ),
  verbose: zod.boolean().default(false).describe('Show per-file action history during adopt'),
  dryRun: zod
    .boolean()
    .default(false)
    .describe('Preview classification + plan without writing'),
  updateCheck: updateCheckOption,
  json: zod
    .boolean()
    .default(false)
    .describe('Emit machine-readable JSON instead of the TUI'),
});
