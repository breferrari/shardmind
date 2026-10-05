/**
 * The rollback contract's excuse rule (#292): a difference is excused only
 * by what the run's ROLLBACK_INCOMPLETE report names. A folder covers its
 * subtree only when the report names that folder.
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { explainedByReport } from '../helpers/rollback-explained.js';

const VAULT = path.resolve('/vault');
const FOLDERS = new Set(['.shardmind', '.shardmind/templates', '.shardmind/templates/Fresh', 'brain', 'notes']);
const isFolder = (p: string) => FOLDERS.has(p);

describe('explainedByReport (#292)', () => {
  it('excuses what is under a folder the report names', () => {
    const explained = explainedByReport(
      [{ path: '.shardmind/templates', reason: 'readdir failed: EIO' }],
      VAULT,
      isFolder,
    );
    expect(explained('.shardmind/templates/Fresh')).toBe(true);
    expect(explained('.shardmind/templates/Fresh/note.md')).toBe(true);
  });

  it('keeps a difference under a folder no failure names unexcused', () => {
    // The report names another folder: brain/ was never reported, so a file
    // left changed there is a silent failure and stays red.
    const explained = explainedByReport([{ path: 'notes', reason: 'remove failed: EIO' }], VAULT, isFolder);
    expect(explained('brain/North Star.md')).toBe(false);
    expect(explained('brain')).toBe(false);
    // With no report at all, nothing is excused.
    const none = explainedByReport([], VAULT, isFolder);
    expect(none('brain/North Star.md')).toBe(false);
    expect(none('.shardmind/templates/Fresh/note.md')).toBe(false);
  });

  it('lets a named file excuse itself and the folders on its way, not their other contents', () => {
    const explained = explainedByReport([{ path: 'brain/North Star.md', reason: 'restore failed: EIO' }], VAULT, isFolder);
    expect(explained('brain/North Star.md')).toBe(true);
    expect(explained('brain')).toBe(true);
    expect(explained('brain/Other.md')).toBe(false);
  });

  it('excuses nothing under a named path that is a file, not a folder', () => {
    const explained = explainedByReport([{ path: 'notes.md', reason: 'restore failed: EIO' }], VAULT, isFolder);
    expect(explained('notes.md/x')).toBe(false);
  });

  it('lets a failure on the vault itself (`.`) excuse everything, and names a backup folder by its path', () => {
    const backup = path.join(VAULT, '.shardmind', 'backups', 'update-1', 'files');
    const whole = explainedByReport([{ path: '.', reason: 'read failed: EIO', backup }], VAULT, isFolder);
    expect(whole('Home.md')).toBe(true);
    const backupOnly = explainedByReport([{ path: 'Home.md', reason: 'restore failed: EIO', backup }], VAULT, isFolder);
    expect(backupOnly('.shardmind/backups/update-1/files')).toBe(true);
    expect(backupOnly('CLAUDE.md')).toBe(false);
  });
});
