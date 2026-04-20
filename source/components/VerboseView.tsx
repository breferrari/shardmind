/**
 * Verbose diagnostics view — the render for `shardmind --verbose`.
 *
 * Extends `StatusView` with five sections (see docs/ARCHITECTURE.md §10.3):
 *
 *   Values:        <n valid / total>  (+ invalid key list when applicable)
 *   Modules:       <included ids> / <excluded ids>
 *   Files:         managed/modified/volatile/missing/orphaned + path lists
 *   Frontmatter:   <n valid / total>  (+ missing-key rows per file)
 *   Environment:   Node.js version + Obsidian CLI availability
 *
 * Presentation-only: every decision about what to show or which bucket a
 * file belongs in happens in `core/status.ts`. This component renders the
 * report it is given and otherwise has no awareness of the engine.
 *
 * Capped lists and `…and N more` overflow handling are computed in the
 * builder; this file just respects them.
 */

import { Box, Text } from 'ink';
import StatusView from './StatusView.js';
import type {
  StatusReport,
  StatusValuesSummary,
  StatusModuleSummary,
  StatusDriftSummary,
  StatusFrontmatterSummary,
  StatusEnvironmentReport,
  StatusModifiedChanges,
} from '../runtime/types.js';

interface VerboseViewProps {
  report: StatusReport;
}

export default function VerboseView({ report }: VerboseViewProps) {
  return (
    <Box flexDirection="column" gap={1}>
      <StatusView report={report} />

      <ValuesSection values={report.values} />
      <ModulesSection modules={report.modules} />
      <FilesSection drift={report.drift} />
      {report.frontmatter && <FrontmatterSection frontmatter={report.frontmatter} />}
      {report.environment && (
        <EnvironmentSection environment={report.environment} />
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

function ValuesSection({ values }: { values: StatusValuesSummary }) {
  const validCount = values.valid ? values.total : values.total - values.invalidCount;
  const overflow = values.invalidCount - values.invalidKeys.length;
  return (
    <Section title="Values">
      {values.fileMissing ? (
        <Row icon="✗" color="red">
          shard-values.yaml is missing or unreadable
        </Row>
      ) : values.valid ? (
        <Row icon="✓" color="green">
          {values.total}/{values.total} valid
        </Row>
      ) : (
        <Box flexDirection="column">
          <Row icon="⚠" color="yellow">
            {validCount}/{values.total} valid — {values.invalidCount} invalid
          </Row>
          {values.invalidKeys.map(key => (
            <Text key={key} dimColor>
              {'   '}· {key}
            </Text>
          ))}
          {overflow > 0 && (
            <Text dimColor>
              {'   '}…and {overflow} more
            </Text>
          )}
        </Box>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Modules
// ---------------------------------------------------------------------------

function ModulesSection({ modules }: { modules: StatusModuleSummary }) {
  return (
    <Section title="Modules">
      {modules.included.length > 0 && (
        <Row icon="✓" color="green">
          {modules.included.join(', ')} (included)
        </Row>
      )}
      {modules.excluded.length > 0 && (
        <Text dimColor>
          {'  · '}
          {modules.excluded.join(', ')} (excluded)
        </Text>
      )}
      {modules.included.length === 0 && modules.excluded.length === 0 && (
        <Text dimColor>{'  '}(no modules declared)</Text>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Files (drift buckets)
// ---------------------------------------------------------------------------

function FilesSection({ drift }: { drift: StatusDriftSummary }) {
  return (
    <Section title="Files">
      <Row icon="✓" color="green">
        {drift.managed} managed (unchanged)
      </Row>

      {drift.modified > 0 && (
        <BucketList
          icon="⚠"
          color="yellow"
          total={drift.modified}
          paths={drift.modifiedPaths}
          heading="modified by you"
          renderSuffix={(_, i) => renderChangeSuffix(drift.modifiedChanges?.[i])}
        />
      )}

      {drift.volatile > 0 && (
        <Text dimColor>
          {'  · '}
          {drift.volatile} volatile (not tracked for drift)
        </Text>
      )}

      {drift.missing > 0 && (
        <BucketList
          icon="✗"
          color="red"
          total={drift.missing}
          paths={drift.missingPaths}
          heading="missing from disk"
        />
      )}

      {drift.orphaned > 0 && (
        <Text dimColor>
          {'  · '}
          {drift.orphaned} user-created (not tracked)
        </Text>
      )}
    </Section>
  );
}

/**
 * Header row + capped list of paths + `…and N more` overflow. Used for
 * every drift bucket that prints per-file rows (modified, missing). The
 * `renderSuffix` slot lets callers attach per-row decorators — `+N/−M`
 * for the `modified` bucket, none for `missing` — without each caller
 * reimplementing the shared layout.
 */
function BucketList({
  icon,
  color,
  total,
  paths,
  heading,
  renderSuffix,
}: {
  icon: string;
  color: 'yellow' | 'red';
  total: number;
  paths: string[];
  heading: string;
  renderSuffix?: (path: string, index: number) => React.ReactNode;
}) {
  return (
    <Box flexDirection="column">
      <Row icon={icon} color={color}>
        {total} {heading}:
      </Row>
      {paths.map((p, i) => (
        <Text key={p}>
          {'     '}
          {p}
          {renderSuffix?.(p, i)}
        </Text>
      ))}
      {total > paths.length && (
        <Text dimColor>
          {'     '}…and {total - paths.length} more
        </Text>
      )}
    </Box>
  );
}

/**
 * Per-modified-file suffix: `— +12 / −3` or `(diff unavailable)` when the
 * builder couldn't render the cached template. The green/red colors are
 * applied directly to the +/− count Texts rather than inheriting from a
 * dimmed wrapper, because Ink's color inheritance merges `dimColor` into
 * nested color props and washes the numbers out. The separator and the
 * "unavailable" label do inherit dim — that's the intended contrast.
 */
function renderChangeSuffix(entry: StatusModifiedChanges | undefined): React.ReactNode {
  if (!entry) return null;
  if ('skipped' in entry) {
    return <Text dimColor> (diff unavailable)</Text>;
  }
  // A 0/0 hunk means the files are logically equal after CRLF + BOM
  // normalization — drift detection saw a hash delta but the diff
  // doesn't. Rather than a confusing `+0/−0`, render the truthful cause.
  if (entry.linesAdded === 0 && entry.linesRemoved === 0) {
    return <Text dimColor> (whitespace-only)</Text>;
  }
  return (
    <>
      <Text dimColor>{' — '}</Text>
      <Text color="green">+{entry.linesAdded}</Text>
      <Text dimColor>/</Text>
      <Text color="red">−{entry.linesRemoved}</Text>
    </>
  );
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

function FrontmatterSection({
  frontmatter,
}: {
  frontmatter: StatusFrontmatterSummary;
}) {
  if (frontmatter.total === 0) {
    return (
      <Section title="Frontmatter">
        <Text dimColor>{'  '}(no managed .md files)</Text>
      </Section>
    );
  }

  const allValid = frontmatter.valid === frontmatter.total;
  return (
    <Section title="Frontmatter">
      {allValid ? (
        <Row icon="✓" color="green">
          {frontmatter.valid}/{frontmatter.total} notes valid
        </Row>
      ) : (
        <Row icon="⚠" color="yellow">
          {frontmatter.valid}/{frontmatter.total} notes valid
        </Row>
      )}

      {frontmatter.issues.map(issue => (
        <Text key={issue.path}>
          {'   '}
          {issue.path} — missing: {issue.missing.join(', ')}
          {issue.noteType && (
            <Text dimColor>
              {' '}
              ({issue.noteType})
            </Text>
          )}
        </Text>
      ))}

      {frontmatter.truncated && (
        <Text dimColor>
          {'     '}…and {frontmatter.issueCount - frontmatter.issues.length} more
        </Text>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

function EnvironmentSection({
  environment,
}: {
  environment: StatusEnvironmentReport;
}) {
  return (
    <Section title="Environment">
      <Row icon="✓" color="green">
        Node.js {environment.nodeVersion}
      </Row>
      {environment.obsidianCliAvailable ? (
        <Row icon="✓" color="green">
          Obsidian CLI on PATH
        </Row>
      ) : (
        <Text dimColor>{'  · '}Obsidian CLI not on PATH</Text>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Shared building blocks. Kept inline — two callers and no style expected
// to drift, so hoisting into a shared module would be over-abstraction.
// ---------------------------------------------------------------------------

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Box flexDirection="column">
      <Text bold>{title}:</Text>
      {children}
    </Box>
  );
}

function Row({
  icon,
  color,
  children,
}: {
  icon: string;
  color: 'green' | 'yellow' | 'red';
  children: React.ReactNode;
}) {
  return (
    <Box>
      <Text color={color}>
        {'  '}
        {icon}{' '}
      </Text>
      <Text>{children}</Text>
    </Box>
  );
}
