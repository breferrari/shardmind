/**
 * Root command — `shardmind` (no args).
 *
 * Renders the vault's status dashboard. Pastel wires this to the root
 * command because the file is `commands/index.tsx`. `--verbose` adds
 * detailed diagnostics for every section. `--json` writes the report as
 * one JSON document instead (ARCHITECTURE §10.3a, #139); `cli.ts` runs it
 * headless, without this component (`commands/headless/status.ts`, #302).
 *
 * The command is a thin dispatcher on top of `useStatusReport`:
 *   booting / loading → Spinner
 *   not-in-vault      → install-hint message
 *   error             → ErrorView: code + hint for a ShardMindError, else the stack + a report link (#225)
 *   ready             → StatusView (quick) or VerboseView (full)
 *
 * Deliberately does not wrap in `CommandFrame`. CommandFrame exists to host
 * the dry-run banner + keyboard legend for interactive install/update runs;
 * neither applies to a read-only report and including them would suggest
 * affordances that don't exist.
 *
 * See docs/ARCHITECTURE.md §10.2–10.3 and docs/IMPLEMENTATION.md §4.14.
 */

import { Box, Text } from 'ink';
import type zod from 'zod';

import { Spinner, StatusMessage } from '../components/ui.js';
import StatusView from '../components/StatusView.js';
import VerboseView from '../components/VerboseView.js';
import { assertNever, ShardMindError } from '../runtime/types.js';
import ErrorView from '../components/ErrorView.js';
import { resolveEngineVersion } from './hooks/cli-version.js';
import { useStatusReport } from './hooks/use-status-report.js';
import { newerStateOf } from '../core/state.js';
import { useSelfUpdateBanner } from './hooks/use-self-update-banner.js';
// Ink-free, so the headless `--json` run parses with the same options (#302).
import { options } from './options/status.js';

export { options };

type Props = {
  options: zod.infer<typeof options>;
};

export default function Index({ options }: Props) {
  // `--json` never reaches this component: cli.ts answers it headless (#302).
  const { verbose, updateCheck } = options;
  const { banner, cacheRead } = useSelfUpdateBanner({ updateCheck });
  // Status is done before npm could answer, so it never waits for npm; it
  // holds its exit only for the local cache read, so a cached banner renders (#285).
  const { phase } = useStatusReport({ vaultRoot: process.cwd(), verbose, holdExit: !cacheRead });

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
      case 'error': {
        // A newer ShardMind's vault is not a failure here: say so, and how to
        // manage it (#344).
        if (newerStateOf(phase.error)) return <NewerStateNotice error={phase.error} />;
        return <ErrorView error={phase.error} version={resolveEngineVersion()} />;
      }
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

/** The error's own message and hint, as a notice: not a failure of this command. */
function NewerStateNotice({ error }: { error: Error }) {
  const hint = error instanceof ShardMindError ? error.hint : undefined;
  return (
    <Box flexDirection="column">
      <StatusMessage variant="warning">{error.message}</StatusMessage>
      {hint && <Text>  {hint}</Text>}
    </Box>
  );
}

export const description = 'Show shard status for the current vault';
