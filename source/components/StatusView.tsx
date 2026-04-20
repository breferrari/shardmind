/**
 * Quick status view — the default render for `shardmind` (no args).
 *
 * Layout (see docs/ARCHITECTURE.md §10.2):
 *
 *   <Header>                                  ← namespace/name + version badge
 *   Installed 3 weeks ago · 47 managed files · 0 modified
 *
 *   ✓ Up to date                              ← exactly one of three update states
 *
 *   ⬆  v4.0.0 available — run 'shardmind update'
 *   ⚠  2 managed files modified by you.        ← zero or more warnings
 *
 * Purely presentational: consumes a `StatusReport` produced by
 * `core/status.ts`. No effects, no state, no reads. That keeps the
 * component trivial to snapshot-test and lets the same `StatusReport`
 * feed both this view and the verbose one without repeated I/O.
 */

import { Box, Text } from 'ink';
import Header from './Header.js';
import { StatusMessage } from './ui.js';
import type { StatusReport, StatusWarning } from '../runtime/types.js';
import { assertNever } from '../runtime/types.js';

interface StatusViewProps {
  report: StatusReport;
}

export default function StatusView({ report }: StatusViewProps) {
  return (
    <Box flexDirection="column">
      <Header manifest={report.manifest} />
      <InstalledLine report={report} />
      <Box marginTop={1}>
        <UpdateLine report={report} />
      </Box>
      {report.warnings.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {report.warnings.map((w, i) => (
            <WarningRow key={i} warning={w} />
          ))}
        </Box>
      )}
    </Box>
  );
}

function InstalledLine({ report }: StatusViewProps) {
  const { installedAgo, updatedAgo, drift } = report;
  // The shard manages every file recorded in state.files — that's the sum
  // of all four drift buckets: unchanged (`managed`), user-edited
  // (`modified`), shard-declared-volatile (`volatile`), and gone-from-disk
  // (`missing`). Excluding `missing` would under-report whenever a managed
  // file is temporarily deleted; the UI label says "managed files", not
  // "present managed files".
  const totalManaged =
    drift.managed + drift.modified + drift.volatile + drift.missing;
  const modifiedFragment = `${drift.modified} modified`;

  const when = updatedAgo
    ? `Installed ${installedAgo} · updated ${updatedAgo}`
    : `Installed ${installedAgo}`;

  return (
    <Text dimColor>
      {when} · {totalManaged} managed file{totalManaged === 1 ? '' : 's'} · {modifiedFragment}
    </Text>
  );
}

/**
 * One of three lines: up-to-date (green check), available (yellow arrow +
 * version + hint), or unknown (dim dash with reason). Mirrors the spec
 * examples verbatim — an explicit line rather than a silent success so the
 * user always knows the check ran.
 */
export function UpdateLine({ report }: StatusViewProps) {
  const u = report.update;

  switch (u.kind) {
    case 'up-to-date':
      return <StatusMessage variant="success">Up to date</StatusMessage>;
    case 'available': {
      const suffix = u.cacheAge === 'stale' ? ' (cached)' : '';
      return (
        <Text color="yellow">
          ⬆ v{u.latest} available{suffix} — run{' '}
          <Text bold>shardmind update</Text>
        </Text>
      );
    }
    case 'unknown': {
      const reason = reasonMessage(u.reason);
      return <Text dimColor>— {reason}</Text>;
    }
    default:
      return assertNever(u);
  }
}

function WarningRow({ warning }: { warning: StatusWarning }) {
  return (
    <Box flexDirection="column">
      <StatusMessage variant={variantForSeverity(warning.severity)}>
        {warning.message}
      </StatusMessage>
      {warning.hint && (
        <Text dimColor>   {warning.hint}</Text>
      )}
    </Box>
  );
}

/**
 * Human-readable message for each `UpdateStatus.reason`. Separated so the
 * mapping is exhaustively checked by the compiler and so a new reason
 * added to the union fails the build at every call site.
 */
function reasonMessage(
  reason: Extract<StatusReport['update'], { kind: 'unknown' }>['reason'],
): string {
  switch (reason) {
    case 'no-network':
      return 'offline — latest version unknown';
    case 'cache-miss':
      return 'update check skipped — run again to check';
    case 'unsupported-source':
      return 'non-GitHub source — update check unavailable';
    default:
      return assertNever(reason);
  }
}

function variantForSeverity(
  severity: StatusWarning['severity'],
): 'info' | 'warning' | 'error' | 'success' {
  switch (severity) {
    case 'info':
      return 'info';
    case 'warning':
      return 'warning';
    case 'error':
      return 'error';
    default:
      return assertNever(severity);
  }
}
