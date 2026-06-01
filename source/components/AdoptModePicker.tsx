import { useRef } from 'react';
import { Box, Text } from 'ink';
import { Select } from './ui.js';

/**
 * Batch resolution mode for the `differs` set (#120). `keep-all-mine` /
 * `use-all-theirs` resolve every file one way; `auto-merge` two-way-unions
 * the non-conflicting files and prompts on the rest; `decide-per-file` is the
 * per-file prompt loop. Selected via `--mode` or this picker. Defined here
 * (component-owned) so the command machine imports it the same way it imports
 * `AdoptDiffAction` / `WizardResult` — components never import from commands.
 */
export type AdoptMode =
  | 'keep-all-mine'
  | 'use-all-theirs'
  | 'auto-merge'
  | 'decide-per-file';

interface AdoptModePickerProps {
  /** Number of files that differ from the shard (drives the header count). */
  differsCount: number;
  onSelect: (mode: AdoptMode) => void;
}

const MODE_VALUES = new Set<AdoptMode>([
  'keep-all-mine',
  'use-all-theirs',
  'auto-merge',
  'decide-per-file',
]);

/**
 * Top-level batch resolution picker shown once before the per-file diff loop
 * (#120). Deciding individually across dozens of divergent files is poor UX;
 * this lets the user resolve them all at once, with per-file prompting kept
 * as a mode.
 *
 * The auto-merge label is deliberately honest: it is a best-effort two-way
 * union merge (no merge base exists for adopt), so it keeps the user's bytes,
 * does NOT apply shard deletions, and can duplicate non-adjacent edits — the
 * user should review merged files. See `core/adopt-merge.ts`.
 */
export default function AdoptModePicker({ differsCount, onSelect }: AdoptModePickerProps) {
  // `Select` can fire onChange more than once if Ink re-focuses the instance
  // (see CollisionReview / DiffView). One-shot decision → guard it.
  const firedRef = useRef(false);

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold color="yellow">
        {differsCount} file{differsCount === 1 ? '' : 's'} differ from the shard.
      </Text>
      <Text>How should I resolve them?</Text>

      <Select
        options={[
          { label: 'Keep all mine — record every divergent file as my version', value: 'keep-all-mine' },
          { label: 'Use all theirs — overwrite every divergent file with the shard version', value: 'use-all-theirs' },
          {
            label:
              'Auto-merge (best-effort) — keep both sides where they don’t overlap, prompt on conflicts; review merged files after',
            value: 'auto-merge',
          },
          { label: 'Decide per file', value: 'decide-per-file' },
        ]}
        onChange={(v) => {
          if (firedRef.current) return;
          if (!MODE_VALUES.has(v as AdoptMode)) return;
          firedRef.current = true;
          onSelect(v as AdoptMode);
        }}
      />
    </Box>
  );
}
