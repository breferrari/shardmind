import type { ReactElement } from 'react';
import { Box, Text } from 'ink';
import { StatusMessage } from './ui.js';
import { headLines, type HookStage, type HookSummary } from '../core/hook.js';
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
        <Box flexDirection="column">
          <StatusMessage variant="warning">
            {name} exited with code {exitCode}. Non-fatal; your vault is ready.
          </StatusMessage>
          <Text dimColor>The operation succeeded; the hook's work may be incomplete.</Text>
        </Box>
      )}
      {summary.deprecated && (
        <StatusMessage variant="warning">
          The post-install hook is deprecated. Split it into bootstrap + personalize before the next minor release — see AUTHORING.md §6.
        </StatusMessage>
      )}
      {summary.violation && (
        <StatusMessage variant="warning">{violationMessage(stage, summary.violation)}</StatusMessage>
      )}
      {stdout && outputBlock('Hook stdout:', stdout, summary.logPath, 'stdout')}
      {stderr && outputBlock('Hook stderr:', stderr, summary.logPath, 'stderr')}
    </Box>
  );
}

/**
 * One captured-output block: a bold label, then the first
 * `HOOK_OUTPUT_VISIBLE_LINES` lines dimmed + indented so the hook's output
 * never reads as the primary outcome. When the output is longer, a dim
 * "… N more lines" pointer follows — naming the full log on disk when one was
 * written (`summary.logPath`). A long Node stack trace from a crashed hook
 * thus collapses to a few dim lines plus a path, instead of dominating the
 * Summary. See #105.
 */
function outputBlock(
  label: string,
  text: string,
  logPath: string | undefined,
  key: string,
): ReactElement {
  const { head, hidden } = headLines(text);
  return (
    <Box key={key} flexDirection="column" marginTop={1}>
      <Text bold>{label}</Text>
      <Box flexDirection="column" marginLeft={2}>
        <Text dimColor>{head}</Text>
        {hidden > 0 && (
          <Text dimColor>
            … {hidden} more line{hidden === 1 ? '' : 's'}
            {logPath ? ` — full log at ${logPath}` : ''}
          </Text>
        )}
      </Box>
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
