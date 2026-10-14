import { Box, Text } from 'ink';
import UpdateSummary from './UpdateSummary.js';
import UpToDateSummary from './UpToDateSummary.js';
import ErrorView from './ErrorView.js';
import type { ShardRun, ShardUpdateResult } from '../core/flows/update.js';
import { rollbackDetail, wasRolledBack } from '../core/rollback-report.js';

/**
 * The report of an update across several shards (#407, ARCHITECTURE
 * §10.5): one block per shard the run covered, in order, headed with its
 * name. A shard updated shows its summary, as a one-shard update does; one
 * up to date says so; the one that failed shows its error; the shards after
 * it are not reached. The shards before a failure stay updated (R3).
 */
interface UpdateShardsSummaryProps {
  runs: readonly ShardRun[];
  dryRun: boolean;
  /** shardmind's version, for a bug's report link. */
  version?: string | undefined;
}

export default function UpdateShardsSummary({ runs, dryRun, version }: UpdateShardsSummaryProps) {
  return (
    <Box flexDirection="column" gap={1}>
      {runs.map((run) => (
        <Box key={run.shard} flexDirection="column">
          <Text bold>{run.shard}</Text>
          {'result' in run ? (
            <ShardResult result={run.result} dryRun={dryRun} />
          ) : 'error' in run ? (
            <ErrorView
              error={run.error}
              version={version}
              detail={wasRolledBack(run.error) ? rollbackDetail(run.error, `Rolled back ${run.shard}; the shards before it stay updated.`) : undefined}
            />
          ) : (
            <Text dimColor>Not reached: an earlier shard failed.</Text>
          )}
        </Box>
      ))}
    </Box>
  );
}

function ShardResult({ result, dryRun }: { result: ShardUpdateResult; dryRun: boolean }) {
  if (result.kind === 'up-to-date') {
    return <UpToDateSummary version={result.state.version} hooks={result.hooks} externalTools={result.externalTools} />;
  }
  // A plan comes back only under --json, which never renders this.
  if (result.kind === 'plan') return null;
  return (
    <UpdateSummary
      summary={result.summary}
      durationMs={result.durationMs}
      migrationWarnings={result.migrationWarnings}
      hooks={result.hooks}
      dryRun={dryRun}
      backupDir={result.backupDir}
      externalTools={result.externalTools}
    />
  );
}
