/**
 * Root command — `shardmind` (no args).
 *
 * Renders the vault's status dashboard. Pastel wires this to the root
 * command because the file is `commands/index.tsx`; the only flag is
 * `--verbose` (verbose: detailed diagnostics for every section).
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

import { Box, Text } from 'ink';
import { createRequire } from 'node:module';
import zod from 'zod';

import { Spinner, StatusMessage } from '../components/ui.js';
import StatusView from '../components/StatusView.js';
import VerboseView from '../components/VerboseView.js';
import SelfUpdateBanner from '../components/SelfUpdateBanner.js';
import { ShardMindError, assertNever } from '../runtime/types.js';
import { useStatusReport } from './hooks/use-status-report.js';
import { useSelfUpdateCheck } from './hooks/use-self-update-check.js';

const pkg = createRequire(import.meta.url)('../../package.json') as {
  version: string;
};

export const options = zod.object({
  verbose: zod
    .boolean()
    .default(false)
    .describe('Show full diagnostics (values, modules, files, frontmatter, environment)'),
  noUpdateCheck: zod
    .boolean()
    .default(false)
    .describe('Disable the once-per-day npm registry check for newer shardmind versions'),
});

type Props = {
  options: zod.infer<typeof options>;
};

export default function Index({ options }: Props) {
  const { verbose, noUpdateCheck } = options;
  const { phase } = useStatusReport({ vaultRoot: process.cwd(), verbose });
  const { info: selfUpdateInfo } = useSelfUpdateCheck({
    noUpdateCheck,
    currentVersion: pkg.version,
  });

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
      <SelfUpdateBanner info={selfUpdateInfo} />
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
