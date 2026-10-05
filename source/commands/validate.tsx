import { useEffect, useRef, useState } from 'react';
import { Box, Text, useApp } from 'ink';
import zod from 'zod';
import { Spinner } from '../components/ui.js';
import { updateCheckOption } from './hooks/update-check-option.js';
import { useSelfUpdateBanner } from './hooks/use-self-update-banner.js';
import { resolveEngineVersion } from './hooks/cli-version.js';
import { useSigintRollback } from './hooks/shared.js';
import { validateShard, type ValidateReport } from '../core/validate-shard.js';
import ErrorView from '../components/ErrorView.js';

export const args = zod.tuple([
  zod
    .string()
    .optional()
    .describe('Shard directory (default ".") or a shard reference, e.g. "github:owner/repo#branch"'),
]);

export const options = zod.object({
  values: zod.string().optional().describe('Path to a YAML file of values to render the templates with'),
  json: zod.boolean().default(false).describe('Emit the findings as one JSON document'),
  verbose: zod.boolean().default(false).describe('Show each finding’s hint'),
  updateCheck: updateCheckOption,
});

type Props = {
  args: zod.infer<typeof args>;
  options: zod.infer<typeof options>;
};

type Phase = { kind: 'checking' } | { kind: 'done'; report: ValidateReport } | { kind: 'error'; error: unknown };

/**
 * `shardmind validate [dir | shard]` (#34): install's checks on a shard, for
 * its author. `--json` never reaches this component: cli.ts runs it before
 * Pastel loads Ink.
 */
export default function Validate({ args, options }: Props) {
  const [target = '.'] = args;
  const { values: valuesFile, verbose, updateCheck } = options;
  const { exit } = useApp();
  const { banner } = useSelfUpdateBanner({ updateCheck });
  const [phase, setPhase] = useState<Phase>({ kind: 'checking' });
  // A downloaded shard's cleanup, registered before the fetch so a Ctrl+C
  // mid-download removes the temp dir before exiting 130 (#57).
  const cleanupRef = useRef<(() => Promise<void>) | null>(null);
  useSigintRollback({
    isActive: () => cleanupRef.current !== null,
    rollback: async () => {
      await cleanupRef.current?.();
    },
  });

  useEffect(() => {
    let live = true;
    validateShard(target, {
      ...(valuesFile ? { valuesFile } : {}),
      engineVersion: resolveEngineVersion(),
      onTempDir: (cleanup) => {
        cleanupRef.current = cleanup;
      },
    }).then(
      (report) => {
        if (!live) return;
        if (report.errors > 0) process.exitCode = 1;
        setPhase({ kind: 'done', report });
      },
      (error: unknown) => {
        if (!live) return;
        process.exitCode = 1;
        setPhase({ kind: 'error', error });
      },
    );
    return () => {
      live = false;
    };
  }, [target, valuesFile]);

  // Exit once the result has painted; a short delay, as the status command
  // takes, lets the last frame reach the terminal before Ink unmounts.
  useEffect(() => {
    if (phase.kind === 'checking') return;
    const timer = setTimeout(() => exit(), 50);
    return () => clearTimeout(timer);
  }, [phase, exit]);

  return (
    <Box flexDirection="column">
      {banner}
      {phase.kind === 'checking' && (
        <Box gap={1}>
          <Spinner />
          <Text>Checking {target}…</Text>
        </Box>
      )}
      {phase.kind === 'error' && <ErrorView error={phase.error} lead="Could not check the shard" version={resolveEngineVersion()} />}
      {phase.kind === 'done' && <Findings report={phase.report} verbose={verbose} />}
    </Box>
  );
}

function Findings({ report, verbose }: { report: ValidateReport; verbose: boolean }) {
  return (
    <Box flexDirection="column">
      {report.findings.map((f, i) => (
        <Box key={i} flexDirection="column">
          <Text>
            <Text color={f.severity === 'error' ? 'red' : 'yellow'}>{f.severity === 'error' ? '✗' : '!'}</Text>{' '}
            {f.path ? <Text bold>{f.path}: </Text> : null}
            {f.message} <Text dimColor>[{f.code}]</Text>
          </Text>
          {verbose && f.hint ? <Text dimColor>  {f.hint}</Text> : null}
          {f.severity === 'error' && !f.code.startsWith('LINT_') && f.code !== 'UNEXPECTED' ? (
            <Text dimColor>  docs/ERRORS.md#{f.code.toLowerCase()}</Text>
          ) : null}
        </Box>
      ))}
      <Text>
        {report.errors === 0 ? <Text color="green">✓</Text> : <Text color="red">✗</Text>} {report.target}:{' '}
        {report.errors} error{report.errors === 1 ? '' : 's'}, {report.warnings} warning{report.warnings === 1 ? '' : 's'}
      </Text>
    </Box>
  );
}

