import { describe, it, expect } from 'vitest';
import { ShardMindError } from '../../source/runtime/types.js';
import {
  attemptRollback,
  formatRollbackFailures,
  rollbackDetail,
  rollbackFailuresOf,
  withRollbackFailures,
} from '../../source/core/rollback-report.js';

const failure = { path: 'Home.md', reason: 'restore failed: EBUSY', backup: '/v/Home.md.shardmind-backup-1' };

describe('withRollbackFailures (#247)', () => {
  it('returns the original error untouched when nothing failed', () => {
    const err = new ShardMindError('boom', 'ADOPT_WRITE_FAILED', 'hint');
    expect(withRollbackFailures(err, [])).toBe(err);
  });

  it('wraps a known error as ROLLBACK_INCOMPLETE, keeping its message and code in the text', () => {
    const err = new ShardMindError('boom', 'ADOPT_WRITE_FAILED', 'hint');
    const wrapped = withRollbackFailures(err, [failure]) as ShardMindError & { cause?: unknown };
    expect(wrapped).toBeInstanceOf(ShardMindError);
    expect(wrapped.code).toBe('ROLLBACK_INCOMPLETE');
    expect(wrapped.message).toBe(
      'boom (ADOPT_WRITE_FAILED)\nRollback incomplete (1 path not restored):\n' +
        '  - Home.md: restore failed: EBUSY; its backup is at /v/Home.md.shardmind-backup-1',
    );
    expect(wrapped.cause).toBe(err);
    expect(err.message).toBe('boom');
    expect(rollbackFailuresOf(wrapped)).toEqual([failure]);
  });

  it('wraps an unknown error as a known one, so it is never framed as a bug', () => {
    const wrapped = withRollbackFailures(new Error('EIO'), [failure]) as ShardMindError;
    expect(wrapped).toBeInstanceOf(ShardMindError);
    expect(wrapped.code).toBe('ROLLBACK_INCOMPLETE');
    expect(wrapped.message.startsWith('EIO\n')).toBe(true);
  });

  it('lists every failure, without a cap, and omits a backup it does not have', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ path: `f${i}.md`, reason: 'unlink failed: EPERM' }));
    const text = formatRollbackFailures(many);
    expect(text.split('\n')).toHaveLength(8);
    expect(text).toMatch(/^Rollback incomplete \(7 paths not restored\):/);
    expect(text).not.toMatch(/backup/);
  });
});

describe('rollbackDetail (#247)', () => {
  it('says rolled back only when the rollback reported nothing', () => {
    expect(rollbackDetail(new Error('x'), 'Rolled back partial adopt.')).toBe('Rolled back partial adopt.');
    expect(rollbackDetail(withRollbackFailures(new Error('x'), [failure]), 'Rolled back partial adopt.')).toBeUndefined();
  });
});

describe('attemptRollback (#247)', () => {
  it("returns the rollback's own failures", async () => {
    expect(await attemptRollback(async () => [failure])).toEqual([failure]);
  });

  it('reports a rollback that throws partway as a failure, never as clean', async () => {
    const failures = await attemptRollback(async () => {
      throw new Error('EIO on the snapshot');
    });
    expect(failures).toEqual([{ path: '(the rollback)', reason: 'stopped partway: EIO on the snapshot' }]);
  });
});
