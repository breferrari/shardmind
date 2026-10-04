/**
 * Root command — `shardmind` (no args).
 *
 * Renders the vault's status dashboard. Pastel wires this to the root
 * command because the file is `commands/index.tsx`. `--verbose` adds
 * detailed diagnostics for every section; `--json` writes the report as
 * one JSON document instead (ARCHITECTURE §10.3a, #139).
 *
 * The command is a thin dispatcher on top of `useStatusReport`:
 *   booting / loading → Spinner
 *   not-in-vault      → install-hint message
 *   error             → error box with ShardMindError code + hint when present
 *   ready             → StatusView (quick) or VerboseView (full)
 *
 * Deliberately does not wrap in `CommandFrame`. CommandFrame exists to host
 * the dry-run banner + keyboard legend for interactive install/update runs;
 * neither applies to a read-only report and including them would suggest
 * affordances that don't exist.
 *
 * See docs/ARCHITECTURE.md §10.2–10.3 and docs/IMPLEMENTATION.md §4.14.
 */

import { useEffect } from 'react';
import { Box, Text } from 'ink';
import zod from 'zod';
import { updateCheckOption } from './hooks/update-check-option.js';

import { Spinner, StatusMessage } from '../components/ui.js';
import StatusView from '../components/StatusView.js';
import VerboseView from '../components/VerboseView.js';
import { ShardMindError, assertNever } from '../runtime/types.js';
import { emitJson, jsonFailure, jsonSuccess, statusResult } from '../core/json-output.js';
import { useStatusReport } from './hooks/use-status-report.js';
import { useSelfUpdateBanner } from './hooks/use-self-update-banner.js';

export const options = zod.object({
  verbose: zod
    .boolean()
    .default(false)
    .describe('Show full diagnostics (values, modules, files, frontmatter, environment)'),
  json: zod
    .boolean()
    .default(false)
    .describe('Emit the status report as one JSON document instead of the TUI'),
  updateCheck: updateCheckOption,
});

type Props = {
  options: zod.infer<typeof options>;
};

export default function Index({ options }: Props) {
  const { verbose, updateCheck, json } = options;
  const { phase } = useStatusReport({ vaultRoot: process.cwd(), verbose, uncapped: json });
  // Chrome is suppressed under --json so stdout is exactly one JSON document.
  const banner = useSelfUpdateBanner({ updateCheck: updateCheck && !json });

  // Under --json the document goes straight to stdout once the report
  // settles; an Ink frame would wrap it at the terminal width. The human
  // view exits 0 on an error it can show, but a document that says
  // `ok: false` exits 1 so `$?` and the body agree. `useStatusReport`
  // already exits the app on every terminal phase.
  useEffect(() => {
    if (!json) return;
    switch (phase.kind) {
      case 'booting':
      case 'loading':
        return;
      case 'not-in-vault':
        emitJson(jsonSuccess('status', statusResult(null)));
        return;
      case 'ready':
        emitJson(jsonSuccess('status', statusResult(phase.report)));
        return;
      case 'error':
        emitJson(jsonFailure('status', phase.error));
        process.exitCode = 1;
        return;
      default:
        assertNever(phase);
    }
  }, [json, phase]);

  if (json) return null;

  // Hoist phase rendering into a single expression so the self-update
  // banner can sit above every status variant without each switch arm
  // wrapping itself. The status command doesn't use CommandFrame, so
  // this is the natural seam for the cross-cutting banner.
  const phaseContent = (() => {
    switch (phase.kind) {
      case 'booting':
      case 'loading':
        return (
          <Box gap={1}>
            <Spinner />
            <Text>Reading vault…</Text>
          </Box>
        );
      case 'not-in-vault':
        return <NotInVault />;
      case 'error':
        return <ErrorBox error={phase.error} />;
      case 'ready':
        return verbose ? (
          <VerboseView report={phase.report} />
        ) : (
          <StatusView report={phase.report} />
        );
      default:
        return assertNever(phase);
    }
  })();

  return (
    <Box flexDirection="column">
      {banner}
      {phaseContent}
    </Box>
  );
}

/**
 * Rendered when the user runs `shardmind` in a directory with no
 * `.shardmind/state.json`. Mirrors the copy in the ARCHITECTURE spec
 * examples (§10.2) verbatim so the two stay in lockstep.
 */
function NotInVault() {
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold color="cyan">
        ◆ shardmind
      </Text>
      <Text>Not in a shard-managed vault.</Text>
      <Box flexDirection="column">
        <Text dimColor>Get started:</Text>
        <Text>
          {'  '}
          <Text bold>shardmind install breferrari/obsidian-mind</Text>
        </Text>
      </Box>
    </Box>
  );
}

function ErrorBox({ error }: { error: ShardMindError | Error }) {
  const code = error instanceof ShardMindError ? error.code : null;
  const hint = error instanceof ShardMindError ? error.hint : null;
  return (
    <Box flexDirection="column" gap={1}>
      <StatusMessage variant="error">{error.message}</StatusMessage>
      {code && <Text dimColor>code: {code}</Text>}
      {hint && <Text>{hint}</Text>}
    </Box>
  );
}

export const description = 'Show shard status for the current vault';
