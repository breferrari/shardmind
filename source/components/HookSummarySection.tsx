import type { ReactElement } from 'react';
import { Box, Text } from 'ink';
import { StatusMessage } from './ui.js';
import type { HookStage, HookSummary } from '../core/hook.js';
import type { HookOutcome } from '../core/hook-orchestrator.js';
import { assertNever } from '../runtime/types.js';

/**
 * Shared hook-outcome renderer used by `Summary.tsx` (install),
 * `UpdateSummary.tsx` (update), and `AdoptSummary.tsx` (adopt). Renders one
 * block per slot outcome (a run can now fire up to two hooks).
 *
 * Per-outcome branches, keyed off the `HookSummary`:
 *   - null            — slot absent / not run; nothing rendered.
 *   - skipped         — engine intentionally didn't run it (personalize under
 *                       Invariant 2); dim note.
 *   - deferred        — dry run; dim "skipped (dry run)" note.
 *   - ran, exit 0     — green "completed" + captured stdout/stderr.
 *   - ran, exit !=0   — yellow warning (exit code) + both streams.
 *   - violation       — yellow non-fatal warning naming the boundary crossing.
 *   - deprecated      — yellow legacy-slot migration note.
 *
 * The parent operation's success is independent of any hook outcome (Helm
 * semantics, ARCHITECTURE.md §9.3) — a failing or out-of-boundary hook never
 * rolls back; it surfaces here as a warning.
 */

const HOOK_NAME: Record<HookStage, string> = {
  bootstrap: 'Bootstrap hook',
  personalize: 'Personalize hook',
  'post-update': 'Post-update hook',
  'post-install': 'Post-install hook',
};

interface HookSummarySectionProps {
  outcomes: HookOutcome[];
}

export default function HookSummarySection({
  outcomes,
}: HookSummarySectionProps): ReactElement | null {
  const blocks = outcomes
    .map((o, i) => renderOutcome(o.slot, o.summary, i))
    .filter((b): b is ReactElement => b !== null);
  if (blocks.length === 0) return null;
  return <Box flexDirection="column">{blocks}</Box>;
}

function renderOutcome(
  stage: HookStage,
  summary: HookSummary | null,
  key: number,
): ReactElement | null {
  if (summary === null) return null;
  const name = HOOK_NAME[stage];

  if (summary.skipped === 'values-are-defaults') {
    return (
      <Box key={key} flexDirection="column">
        <Text dimColor>{name} skipped (values are defaults).</Text>
      </Box>
    );
  }

  if (summary.deferred) {
    return (
      <Box key={key} flexDirection="column">
        <Text dimColor>{name} skipped (dry run).</Text>
      </Box>
    );
  }

  const exitCode = summary.exitCode ?? 0;
  const succeeded = exitCode === 0;
  const stdout = summary.stdout?.trim();
  const stderr = summary.stderr?.trim();

  return (
    <Box key={key} flexDirection="column" marginTop={key > 0 ? 1 : 0}>
      {succeeded ? (
        <Text color="green">{name} completed.</Text>
      ) : (
        <StatusMessage variant="warning">
          {name} exited with code {exitCode}. The operation succeeded; the hook's work may be incomplete.
        </StatusMessage>
      )}
      {summary.deprecated && (
        <StatusMessage variant="warning">
          The post-install hook is deprecated. Split it into bootstrap + personalize before the next minor release — see AUTHORING.md §6.
        </StatusMessage>
      )}
      {summary.violation && (
        <StatusMessage variant="warning">{violationMessage(stage, summary.violation)}</StatusMessage>
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

function violationMessage(
  stage: HookStage,
  violation: NonNullable<HookSummary['violation']>,
): string {
  const paths = violation.paths.join(', ');
  switch (violation.kind) {
    case 'managed-write':
      return `${HOOK_NAME[stage]} modified or removed managed file(s): ${paths}. Bootstrap may only write unmanaged paths — move managed-file edits to the personalize hook.`;
    case 'unmanaged-create':
      return `${HOOK_NAME[stage]} created unmanaged file(s): ${paths}. Personalize may only edit managed files — move artifact creation to the bootstrap hook.`;
    default:
      return assertNever(violation.kind);
  }
}
