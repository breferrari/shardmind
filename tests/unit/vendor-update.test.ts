import { describe, it, expect, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { updateKit } from '../../scripts/vendor/update.js';
import { headerFor, readRecord } from '../../scripts/vendor/record.js';
import { finishKit, main } from '../../scripts/vendor/update.js';
import { makeVendorFixture, UPSTREAM, V1_COMMIT, V2_COMMIT } from '../helpers/vendor-fixture.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function fixture(files: Parameters<typeof makeVendorFixture>[0]) {
  const f = await makeVendorFixture(files);
  cleanups.push(f.cleanup);
  return f;
}

describe('vendor:update (#280)', () => {
  it('updates an unmodified file cleanly and merges a modified one, then advances the record', async () => {
    const { kitDir, source } = await fixture(['a.ts', 'b.ts']);
    const result = await updateKit({ kitDir, version: '2.0.0', source });

    expect(result.conflicts).toEqual([]);
    expect(result.updated).toEqual(['b.ts']);
    expect(result.merged).toEqual(['a.ts']);
    const record = await readRecord(kitDir);
    expect(record).toMatchObject({ version: '2.0.0', tag: 'v2.0.0', commit: V2_COMMIT });
    expect(record.tarball.integrity).toBe('sha512-v2');

    // b.ts is v2 exactly, under the new header.
    expect(await fsp.readFile(path.join(kitDir, 'b.ts'), 'utf-8')).toBe(headerFor(record, 'b.ts') + UPSTREAM['2.0.0']['lib/b.ts']);
    expect(record.files['b.ts']).toEqual({ upstream: 'lib/b.ts', modified: false });
    // a.ts has upstream's change and ShardMind's.
    const a = await fsp.readFile(path.join(kitDir, 'a.ts'), 'utf-8');
    expect(a.startsWith(headerFor(record, 'a.ts'))).toBe(true);
    expect(a).toContain('export const a1 = 10;');
    expect(a).toContain('export const a5 = 50; // ShardMind');
    expect(record.files['a.ts']).toMatchObject({ modified: true, change: 'local change to a.ts.' });
  });

  it('writes a conflict with markers, lists it, and leaves the record where it was', async () => {
    const { kitDir, source } = await fixture(['b.ts', 'c.ts']);
    const before = await fsp.readFile(path.join(kitDir, 'VENDOR.json'), 'utf-8');
    const result = await updateKit({ kitDir, version: '2.0.0', source });

    expect(result.conflicts).toEqual([{ file: 'c.ts', reason: 'conflicting changes' }]);
    const c = await fsp.readFile(path.join(kitDir, 'c.ts'), 'utf-8');
    expect(c).toContain('<<<<<<< shardmind');
    expect(c).toContain('export const c = 99; // ShardMind');
    expect(c).toContain('export const c = 2;');
    expect(c).toContain('>>>>>>> demo-pkg@2.0.0');
    expect(await fsp.readFile(path.join(kitDir, 'VENDOR.json'), 'utf-8')).toBe(before);
    expect((await readRecord(kitDir)).commit).toBe(V1_COMMIT);
  });

  it('keeps the old headers on a conflict, and --resolved then advances the kit as the person left it', async () => {
    const { kitDir, source } = await fixture(['b.ts', 'c.ts']);
    const old = await readRecord(kitDir);
    await updateKit({ kitDir, version: '2.0.0', source });

    // Every written file, the clean one too, still carries the header the record describes.
    for (const f of ['b.ts', 'c.ts']) {
      expect((await fsp.readFile(path.join(kitDir, f), 'utf-8')).startsWith(headerFor(old, f))).toBe(true);
    }
    // A person resolves c.ts by keeping both sides' intent.
    await fsp.writeFile(path.join(kitDir, 'c.ts'), headerFor(old, 'c.ts') + 'export const c = 99; // ShardMind, over 2\n');

    await finishKit({ kitDir, version: '2.0.0', source });
    const record = await readRecord(kitDir);
    expect(record).toMatchObject({ version: '2.0.0', commit: V2_COMMIT });
    expect(record.files['b.ts']).toEqual({ upstream: 'lib/b.ts', modified: false });
    expect(await fsp.readFile(path.join(kitDir, 'c.ts'), 'utf-8')).toBe(
      headerFor(record, 'c.ts') + 'export const c = 99; // ShardMind, over 2\n',
    );
  });

  it('--resolved refuses a file that still holds a marker, and one upstream removed', async () => {
    const { kitDir, source } = await fixture(['b.ts', 'c.ts']);
    await updateKit({ kitDir, version: '2.0.0', source });
    const before = await fsp.readFile(path.join(kitDir, 'VENDOR.json'), 'utf-8');
    await expect(finishKit({ kitDir, version: '2.0.0', source })).rejects.toThrow('demo-kit/c.ts still holds a conflict marker');
    expect(await fsp.readFile(path.join(kitDir, 'VENDOR.json'), 'utf-8')).toBe(before);

    const removed = await fixture(['b.ts', 'd.ts']);
    await expect(finishKit({ kitDir: removed.kitDir, version: '2.0.0', source: removed.source })).rejects.toThrow(/lib\/d\.ts is gone in 2\.0\.0/);
    expect((await readRecord(removed.kitDir)).version).toBe('1.0.0');
  });

  it('reads a CRLF checkout of the kit as unmodified, not as a change on every line', async () => {
    const { kitDir, source } = await fixture(['b.ts']);
    const b = path.join(kitDir, 'b.ts');
    await fsp.writeFile(b, (await fsp.readFile(b, 'utf-8')).replace(/\n/g, '\r\n'));
    const result = await updateKit({ kitDir, version: '2.0.0', source });
    expect(result).toMatchObject({ updated: ['b.ts'], merged: [], conflicts: [] });
    expect((await readRecord(kitDir)).files['b.ts']).toEqual({ upstream: 'lib/b.ts', modified: false });
  });

  it('names a vendored file that is missing from the kit', async () => {
    const { kitDir, source } = await fixture(['a.ts', 'b.ts']);
    await fsp.rm(path.join(kitDir, 'b.ts'));
    await expect(updateKit({ kitDir, version: '2.0.0', source })).rejects.toThrow('demo-kit/b.ts is in VENDOR.json but not on disk');
  });

  it('reports a file upstream removed and leaves it, and lists files upstream added', async () => {
    const { kitDir, source } = await fixture(['b.ts', 'd.ts']);
    const dBefore = await fsp.readFile(path.join(kitDir, 'd.ts'), 'utf-8');
    const result = await updateKit({ kitDir, version: '2.0.0', source });

    expect(result.conflicts).toEqual([{ file: 'd.ts', reason: 'removed upstream' }]);
    expect(await fsp.readFile(path.join(kitDir, 'd.ts'), 'utf-8')).toBe(dBefore);
    expect(result.addedUpstream).toEqual(['lib/e.ts']);
    expect((await readRecord(kitDir)).version).toBe('1.0.0');
  });

  it('refuses a vendored file whose header was edited by hand, before writing anything', async () => {
    const { kitDir, source } = await fixture(['a.ts', 'b.ts']);
    await fsp.writeFile(path.join(kitDir, 'b.ts'), '/* edited */\nexport const b = 1;\n');
    const aBefore = await fsp.readFile(path.join(kitDir, 'a.ts'), 'utf-8');
    await expect(updateKit({ kitDir, version: '2.0.0', source })).rejects.toThrow(/header/);
    expect(await fsp.readFile(path.join(kitDir, 'a.ts'), 'utf-8')).toBe(aBefore);
  });

  it('with commit, makes two commits: the new upstream as-is, then ShardMind’s changes', async () => {
    const { root, kitDir, source } = await fixture(['a.ts', 'b.ts']);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf-8' }).trim();
    git('init', '-q');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'vendored at 1.0.0');

    const result = await updateKit({
      kitDir,
      version: '2.0.0',
      source,
      commit: { author: 't <t@t>' },
    });
    expect(result.conflicts).toEqual([]);
    const log = git('log', '--format=%s', '-3').split('\n');
    expect(log).toEqual([
      "chore: re-apply ShardMind's changes to demo-kit",
      'chore: vendor demo-pkg@2.0.0 as-is into demo-kit',
      'vendored at 1.0.0',
    ]);
    // The first commit holds upstream's a.ts as-is; the second, the merge.
    const asIs = git('show', `HEAD~1:source/demo-kit/a.ts`);
    expect(asIs).toContain('export const a5 = 5;');
    expect(asIs).not.toContain('ShardMind');
    expect(git('show', 'HEAD:source/demo-kit/a.ts')).toContain('export const a5 = 50; // ShardMind');
    expect(git('status', '--porcelain')).toBe('');
  });

  async function committedFixture(files: Parameters<typeof makeVendorFixture>[0]) {
    const f = await fixture(files);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: f.root, encoding: 'utf-8' }).trim();
    git('init', '-q');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'vendored at 1.0.0');
    return { ...f, git };
  }

  it('with commit and no ShardMind change left, makes only the as-is commit', async () => {
    const { kitDir, source, git } = await committedFixture(['b.ts']);
    await updateKit({ kitDir, version: '2.0.0', source, commit: { author: 't <t@t>' } });
    expect(git('log', '--format=%s', '-2').split('\n')).toEqual([
      'chore: vendor demo-pkg@2.0.0 as-is into demo-kit',
      'vendored at 1.0.0',
    ]);
    expect(git('status', '--porcelain')).toBe('');
  });

  it('with commit, refuses a dirty kit or a staged change before writing anything', async () => {
    const { root, kitDir, source, git } = await committedFixture(['a.ts', 'b.ts']);
    const a = path.join(kitDir, 'a.ts');
    await fsp.appendFile(a, '// wip\n');
    const aBefore = await fsp.readFile(a, 'utf-8');
    await expect(updateKit({ kitDir, version: '2.0.0', source, commit: { author: 't <t@t>' } })).rejects.toThrow(/clean demo-kit/);
    expect(await fsp.readFile(a, 'utf-8')).toBe(aBefore);

    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-am', 'wip');
    await fsp.writeFile(path.join(root, 'other.txt'), 'x');
    git('add', 'other.txt');
    await expect(updateKit({ kitDir, version: '2.0.0', source, commit: { author: 't <t@t>' } })).rejects.toThrow(/empty index/);
    expect((await readRecord(kitDir)).version).toBe('1.0.0');
  });

  it('with commit, refuses an author that is not "Name <email>"', async () => {
    const { kitDir, source } = await committedFixture(['b.ts']);
    await expect(updateKit({ kitDir, version: '2.0.0', source, commit: { author: 'just a name' } })).rejects.toThrow(/Name <email>/);
    expect((await readRecord(kitDir)).version).toBe('1.0.0');
  });

  it('the command refuses a missing --commit author and stray arguments', async () => {
    const { root } = await fixture(['b.ts']);
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((m: unknown) => void errors.push(String(m)));
    try {
      expect(await main(['demo-kit', '2.0.0', '--commit'], root)).toBe(2);
      expect(await main(['demo-kit', '2.0.0', 'extra'], root)).toBe(2);
      expect(await main(['demo-kit'], root)).toBe(2);
    } finally {
      spy.mockRestore();
    }
    expect(errors.join('\n')).toMatch(/usage: npm run vendor:update/);
    expect((await readRecord(path.join(root, 'source', 'demo-kit'))).version).toBe('1.0.0');
  });
});
