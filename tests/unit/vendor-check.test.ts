import { describe, it, expect, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { checkKits, formatReport, main } from '../../scripts/vendor/check.js';
import { readRecord, writeRecord } from '../../scripts/vendor/record.js';
import { makeVendorFixture } from '../helpers/vendor-fixture.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function fixture() {
  const f = await makeVendorFixture(['a.ts', 'b.ts']);
  cleanups.push(f.cleanup);
  return f;
}

describe('vendor:check (#280)', () => {
  it('lists a kit behind npm latest, with its recorded flags verified', async () => {
    const { root, source } = await fixture();
    const [status] = await checkKits({ root, source });
    expect(status).toEqual({
      kit: 'demo-kit',
      package: 'demo-pkg',
      version: '1.0.0',
      latest: '2.0.0',
      behind: true,
      wrongModified: [],
    });
    expect(formatReport([status!])).toMatch(/demo-kit.*demo-pkg 1\.0\.0 → 2\.0\.0/);
  });

  it('reports a kit at latest as up to date', async () => {
    const { root, source } = await fixture();
    const [status] = await checkKits({ root, source: { ...source, latestVersion: async () => '1.0.0' } });
    expect(status).toMatchObject({ behind: false });
    expect(formatReport([status!])).toMatch(/up to date/);
  });

  it('does not call a kit ahead of npm latest behind', async () => {
    const { root, source } = await fixture();
    const [status] = await checkKits({ root, source: { ...source, latestVersion: async () => '0.9.0' } });
    expect(status).toMatchObject({ behind: false });
  });

  it('reads a CRLF checkout of the kit by its content, not its line ends', async () => {
    const { root, kitDir, source } = await fixture();
    for (const f of ['a.ts', 'b.ts']) {
      const p = path.join(kitDir, f);
      await fsp.writeFile(p, (await fsp.readFile(p, 'utf-8')).replace(/\n/g, '\r\n'));
    }
    const [status] = await checkKits({ root, source });
    expect(status).toMatchObject({ wrongModified: [] });
  });

  it("reports a file whose recorded `modified` disagrees with its bytes", async () => {
    const { root, kitDir, source } = await fixture();
    const record = await readRecord(kitDir);
    // b.ts is upstream's bytes, but the record claims it was changed.
    await writeRecord(kitDir, { ...record, files: { ...record.files, 'b.ts': { upstream: 'lib/b.ts', modified: true, change: 'nothing.' } } });
    // Its header then differs too; rewrite it so only `modified` is wrong.
    const { headerFor } = await import('../../scripts/vendor/record.js');
    const next = await readRecord(kitDir);
    const body = (await fsp.readFile(path.join(kitDir, 'b.ts'), 'utf-8')).split('*/\n\n')[1]!;
    await fsp.writeFile(path.join(kitDir, 'b.ts'), headerFor(next, 'b.ts') + body);
    const [status] = await checkKits({ root, source });
    expect(status!.wrongModified).toEqual(['b.ts']);
  });

  it('always exits 0, and writes the report to --summary', async () => {
    const { root, source } = await fixture();
    const summary = path.join(root, 'summary.md');
    expect(await main(['--summary', summary], { root, source })).toBe(0);
    expect(await fsp.readFile(summary, 'utf-8')).toMatch(/demo-pkg 1\.0\.0 → 2\.0\.0/);
    // A failing upstream is reported, not fatal.
    const failing = { ...source, latestVersion: async () => Promise.reject(new Error('registry down')) };
    expect(await main(['--summary', summary], { root, source: failing })).toBe(0);
    expect(await fsp.readFile(summary, 'utf-8')).toMatch(/registry down/);
  });
});
