/**
 * The summary of an update across several shards (#407): one block per
 * shard, headed with its name: updated, up to date, failed, not reached.
 * Spec: ARCHITECTURE §10.5 ("Several shards").
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import UpdateShardsSummary from '../../source/components/UpdateShardsSummary.js';
import type { UpdateSummary as Summary } from '../../source/core/update-executor.js';
import type { ShardRun, ShardUpdateResult } from '../../source/core/flows/update.js';
import { ShardMindError } from '../../source/runtime/types.js';
import { markRolledBack } from '../../source/core/rollback-report.js';
import { makeShardState } from '../helpers/index.js';

afterEach(() => {
  cleanup();
});

const summary = (fromVersion: string, toVersion: string): Summary => ({
  fromVersion,
  toVersion,
  counts: { silent: 3, overwritten: 1, adopted: 0, autoMerged: 0, conflicts: 0, volatile: 0, added: 1, deleted: 0, keptAsUser: 0, restored: 0 },
  conflictsResolved: 0,
  conflictsAcceptedNew: 0,
  conflictsEdited: 0,
  conflictsKeptMine: 0,
  conflictsSkipped: 0,
  autoMergeStats: { linesUnchanged: 0, linesAutoMerged: 0 },
  wroteFiles: [],
  deletedFiles: [],
  addedFiles: [],
  replacedFiles: [],
  keptUntracked: [],
  renamedFiles: [],
});

const done = (from: string, to: string): Extract<ShardUpdateResult, { kind: 'done' }> => ({
  kind: 'done',
  summary: summary(from, to),
  migrationWarnings: [],
  hooks: [],
  durationMs: 1200,
  backupDir: '.shardmind/backups/update-x',
  externalTools: [],
  plan: { actions: [], pendingConflicts: [], counts: summary(from, to).counts } as never,
  resolutions: {},
});

describe('UpdateShardsSummary (#407)', () => {
  it('shows a cancelled shard as cancelled, not as a failure', () => {
    const runs: ShardRun[] = [
      { shard: 'acme/base', result: done('0.1.0', '0.2.0') },
      { shard: 'acme/research', error: new ShardMindError('Cancelled.', 'CANCELLED', 'The shards before this one stay updated.') },
    ];
    const frame = render(<UpdateShardsSummary runs={runs} dryRun={false} />).lastFrame() ?? '';
    expect(frame).toContain('Cancelled. The shards before this one stay updated.');
    expect(frame).not.toContain('code: CANCELLED');
  });

  it('heads each shard with its name, in order: updated, then up to date', () => {
    const runs: ShardRun[] = [
      { shard: 'acme/base', result: done('0.1.0', '0.2.0') },
      {
        shard: 'acme/research',
        result: { kind: 'up-to-date', manifest: {} as never, state: makeShardState({ version: '1.0.0' }), hooks: [], externalTools: [], durationMs: 0 },
      },
    ];
    const frame = render(<UpdateShardsSummary runs={runs} dryRun={false} />).lastFrame() ?? '';
    expect(frame.indexOf('acme/base')).toBeLessThan(frame.indexOf('acme/research'));
    expect(frame).toContain('0.1.0 → 0.2.0');
    expect(frame).toContain('Already up to date at v1.0.0');
  });

  it('shows the failed shard with its error and rollback, and the shards after it as not reached', () => {
    const err = new ShardMindError('would write Home.md', 'UPDATE_PATH_OWNED', 'Each file has one owner.');
    markRolledBack(err);
    const runs: ShardRun[] = [
      { shard: 'acme/base', result: done('0.1.0', '0.2.0') },
      { shard: 'acme/research', error: err },
      { shard: 'acme/later', skipped: 'not-reached' },
    ];
    const frame = render(<UpdateShardsSummary runs={runs} dryRun={false} />).lastFrame() ?? '';
    expect(frame).toContain('would write Home.md');
    expect(frame).toContain('UPDATE_PATH_OWNED');
    expect(frame).toContain('Rolled back acme/research');
    expect(frame).toContain('acme/later');
    expect(frame).toContain('Not reached: the run stopped at an earlier shard.');
    // The shard before the failure stays updated, and says so.
    expect(frame).toContain('0.1.0 → 0.2.0');
  });
});
