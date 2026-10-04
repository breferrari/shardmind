/**
 * bugReportUrl / scrubFirstLine (#225): the report link carries the version
 * and at most the error's first line, never a value, a path or file contents.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { bugReportUrl, scrubFirstLine } from '../../source/core/bug-report.js';

const params = (url: string) => new URL(url).searchParams;

describe('scrubFirstLine (#225)', () => {
  it('keeps only the first line', () => {
    expect(scrubFirstLine('Cannot read properties of undefined\n    at foo (bar.js:1:2)')).toBe(
      'Cannot read properties of undefined',
    );
  });

  it('removes POSIX and Windows paths, and drive letters', () => {
    expect(scrubFirstLine("ENOENT: no such file or directory, open /home/ana/My Vault/x.md")).not.toMatch(/ana|Vault|x\.md/);
    expect(scrubFirstLine('EACCES: permission denied, mkdir C:\\Users\\ana\\vault')).not.toMatch(/Users|ana|vault|C:/);
    expect(scrubFirstLine('failed at D:/notes/secret.md')).not.toMatch(/notes|secret/);
  });

  it('removes quoted strings, single, double and backtick', () => {
    const line = scrubFirstLine(`Unexpected token 'hunter2' in "Acme Corp" near \`ana\``);
    expect(line).not.toMatch(/hunter2|Acme|ana/);
    expect(line).toMatch(/^Unexpected token/);
  });

  it('caps the line at 120 characters', () => {
    expect(scrubFirstLine('x'.repeat(500)).length).toBeLessThanOrEqual(120);
  });

  it('never lets a path segment through, whatever the message', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z]{3,10}$/), fc.string(), (secret, noise) => {
        const line = scrubFirstLine(`${noise} /tmp/${secret}/file ${noise}`);
        return !line.includes(`/${secret}`) && !line.includes(`${secret}/`);
      }),
    );
  });
});

describe('bugReportUrl (#225)', () => {
  it('opens a new issue on the shardmind tracker with the version and the scrubbed first line', () => {
    const url = bugReportUrl(new TypeError("Cannot read 'name' of undefined\nat /home/ana/vault"), '0.1.9');
    expect(url.startsWith('https://github.com/breferrari/shardmind/issues/new?')).toBe(true);
    const p = params(url);
    expect(p.get('title')).toBe('Unexpected error: Cannot read … of undefined');
    expect(p.get('body')).toMatch(/shardmind 0\.1\.9/);
    expect(url).not.toMatch(/ana|vault|name/);
  });

  it('says the version is unknown when it cannot be read, and takes a non-Error throw', () => {
    const p = params(bugReportUrl('plain string', undefined));
    expect(p.get('title')).toBe('Unexpected error: plain string');
    expect(p.get('body')).toMatch(/shardmind \(version unknown\)/);
  });
});
