import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import React from 'react';
import UpdateSummary from '../../source/components/UpdateSummary.js';
import type { UpdateSummary as Summary } from '../../source/core/update-executor.js';

afterEach(() => {
  cleanup();
});

function summary(overrides: Partial<Summary> = {}): Summary {
  return {
    fromVersion: '0.1.0',
    toVersion: '0.2.0',
    counts: {
      silent: 43,
      autoMerged: 2,
      conflicts: 1,
      volatile: 0,
      added: 3,
      deleted: 1,
      keptAsUser: 0,
      restored: 0,
    },
    conflictsResolved: 1,
    conflictsAcceptedNew: 0,
    conflictsKeptMine: 1,
    conflictsSkipped: 0,
    autoMergeStats: { linesUnchanged: 150, linesAutoMerged: 12 },
    wroteFiles: [],
    deletedFiles: [],
    addedFiles: [],
    ...overrides,
  };
}

describe('UpdateSummary', () => {
  it('renders the version bump and core action counts', () => {
    const { lastFrame } = render(
      <UpdateSummary
        summary={summary()}
        durationMs={1500}
        migrationWarnings={[]}
        hookOutput={null}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/Updated 0\.1\.0 → 0\.2\.0/);
    expect(frame).toContain('43 silent');
    expect(frame).toContain('2 auto-merged');
    expect(frame).toContain('1 conflict');
    expect(frame).toContain('3 added');
    expect(frame).toContain('1 deleted');
  });

  it('pluralizes "conflicts" correctly', () => {
    const { lastFrame } = render(
      <UpdateSummary
        summary={summary({
          counts: {
            silent: 0, autoMerged: 0, conflicts: 2,
            volatile: 0, added: 0, deleted: 0, keptAsUser: 0, restored: 0,
          },
          conflictsResolved: 2,
          conflictsAcceptedNew: 1, conflictsKeptMine: 1, conflictsSkipped: 0,
        })}
        durationMs={500}
        migrationWarnings={[]}
        hookOutput={null}
      />,
    );
    expect(lastFrame()).toContain('2 conflicts');
  });

  it('shows "(nothing changed)" when every count is zero', () => {
    const { lastFrame } = render(
      <UpdateSummary
        summary={summary({
          counts: {
            silent: 0, autoMerged: 0, conflicts: 0,
            volatile: 0, added: 0, deleted: 0, keptAsUser: 0, restored: 0,
          },
          conflictsResolved: 0,
        })}
        durationMs={0}
        migrationWarnings={[]}
        hookOutput={null}
      />,
    );
    expect(lastFrame()).toContain('(nothing changed)');
  });

  it('renders the conflict resolution breakdown when conflicts were resolved', () => {
    const { lastFrame } = render(
      <UpdateSummary
        summary={summary()}
        durationMs={200}
        migrationWarnings={[]}
        hookOutput={null}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Conflict resolutions');
    expect(frame).toContain('0 accepted new');
    expect(frame).toContain('1 kept mine');
    expect(frame).toContain('0 skipped');
  });

  it('omits the conflict resolution section when no conflicts occurred', () => {
    const { lastFrame } = render(
      <UpdateSummary
        summary={summary({
          counts: {
            silent: 1, autoMerged: 0, conflicts: 0,
            volatile: 0, added: 0, deleted: 0, keptAsUser: 0, restored: 0,
          },
          conflictsResolved: 0,
        })}
        durationMs={0}
        migrationWarnings={[]}
        hookOutput={null}
      />,
    );
    expect(lastFrame()).not.toContain('Conflict resolutions');
  });

  it('caps migration warnings at 8 with a "…and N more" overflow', () => {
    const warnings = Array.from({ length: 12 }, (_, i) => `warn-${i}`);
    const { lastFrame } = render(
      <UpdateSummary
        summary={summary()}
        durationMs={0}
        migrationWarnings={warnings}
        hookOutput={null}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('warn-0');
    expect(frame).toContain('warn-7');
    expect(frame).not.toContain('warn-8');
    expect(frame).toContain('and 4 more');
  });

  it('renders "skipped" note when hookOutput.deferred is set', () => {
    const { lastFrame } = render(
      <UpdateSummary
        summary={summary()}
        durationMs={0}
        migrationWarnings={[]}
        hookOutput={{ deferred: true }}
      />,
    );
    // Dry-run's only path into the hook section: hook declared but
    // suppressed. Shown as a dim "skipped" note, not a warning.
    expect(lastFrame()).toContain('Post-update hook skipped (dry run).');
  });

  it('renders "completed" + stdout/stderr when hook ran cleanly', () => {
    const { lastFrame } = render(
      <UpdateSummary
        summary={summary()}
        durationMs={0}
        migrationWarnings={[]}
        hookOutput={{ stdout: 'hook output text', stderr: '', exitCode: 0 }}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Post-update hook completed.');
    expect(frame).toContain('Hook stdout:');
    expect(frame).toContain('hook output text');
    // Empty stderr should not render the stderr label.
    expect(frame).not.toContain('Hook stderr:');
  });

  it('renders yellow warning when hook exited non-zero', () => {
    const { lastFrame } = render(
      <UpdateSummary
        summary={summary()}
        durationMs={0}
        migrationWarnings={[]}
        hookOutput={{
          stdout: 'partial work',
          stderr: 'hook boom\n    at hook.ts:3:11',
          exitCode: 1,
        }}
      />,
    );
    const frame = lastFrame() ?? '';
    // Warning copy is explicit about update still succeeding — Helm
    // semantics, hook failure does not roll back the update.
    expect(frame).toContain('Post-update hook exited with code 1');
    expect(frame).toContain("Update succeeded; the hook's work may be incomplete.");
    expect(frame).toContain('partial work');
    expect(frame).toContain('hook boom');
  });

  it('shows dry-run phrasing when dryRun is true', () => {
    const { lastFrame } = render(
      <UpdateSummary
        summary={summary()}
        durationMs={1000}
        migrationWarnings={[]}
        hookOutput={null}
        dryRun
      />,
    );
    expect(lastFrame()).toMatch(/Dry run: would update 0\.1\.0 → 0\.2\.0/);
  });
});
