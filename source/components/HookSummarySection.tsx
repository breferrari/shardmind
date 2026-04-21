import type { ReactElement } from 'react';
import { Box, Text } from 'ink';
import { StatusMessage } from './ui.js';
import type { HookStage } from '../core/hook.js';
import type { HookSummary } from '../commands/hooks/shared.js';

/**
 * Shared hook-outcome renderer used by both `Summary.tsx` (install) and
 * `UpdateSummary.tsx` (update). The two contexts differ only in whether
 * to say "post-install" / "install" or "post-update" / "update" — the
 * four output states, the layout, and the color discipline are identical.
 *
 * The four branches, keyed off the `HookSummary` produced by
 * `summarizeHook` in `commands/hooks/shared.ts`:
 *
 *   - null           — hook was never declared OR this was a dry run;
 *                      nothing rendered.
 *   - deferred       — hook exists but execution was suppressed (e.g.
 *                      --dry-run explicitly asked); dim "skipped" note.
 *   - ran, exit 0    — hook completed cleanly; green "completed"
 *                      headline + captured stdout + stderr (labeled,
 *                      only if non-empty).
 *   - ran, exit !=0  — hook ran but exited non-zero (or timed out /
 *                      cancelled / threw); yellow warning with exit
 *                      code + both captured streams.
 *
 * Install / update success is independent of the hook outcome (Helm
 * semantics, per ARCHITECTURE.md §9.3) — a failing hook does not roll
 * back; it surfaces here as a warning that explicitly states the
 * parent operation succeeded.
 */
interface HookSummarySectionProps {
  stage: HookStage;
  hookOutput: HookSummary | null;
}

export default function HookSummarySection({
  stage,
  hookOutput,
}: HookSummarySectionProps): ReactElement | null {
  if (hookOutput === null) return null;

  const verbs = stage === 'post-install'
    ? { hook: 'Post-install hook', parent: 'Install' }
    : { hook: 'Post-update hook', parent: 'Update' };

  if (hookOutput.deferred) {
    return (
      <Box flexDirection="column">
        <Text dimColor>{verbs.hook} skipped (dry run).</Text>
      </Box>
    );
  }

  const exitCode = hookOutput.exitCode ?? 0;
  const succeeded = exitCode === 0;
  const stdout = hookOutput.stdout?.trim();
  const stderr = hookOutput.stderr?.trim();

  return (
    <Box flexDirection="column">
      {succeeded ? (
        <Text color="green">{verbs.hook} completed.</Text>
      ) : (
        <StatusMessage variant="warning">
          {verbs.hook} exited with code {exitCode}. {verbs.parent} succeeded; the hook's work may be incomplete.
        </StatusMessage>
      )}
      {stdout && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Hook stdout:</Text>
          <Text>{stdout}</Text>
        </Box>
      )}
      {stderr && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Hook stderr:</Text>
          <Text>{stderr}</Text>
        </Box>
      )}
    </Box>
  );
}
