/**
 * bugReportUrl (#225): the report link carries the shardmind version and
 * nothing from the error, and fits one 80-column line.
 */

import { describe, it, expect } from 'vitest';
import { bugReportUrl } from '../../source/core/bug-report.js';

describe('bugReportUrl (#225)', () => {
  it('opens a new issue on the shardmind tracker with the version in the body', () => {
    const url = bugReportUrl('0.1.9');
    expect(url.startsWith('https://github.com/breferrari/shardmind/issues/new?')).toBe(true);
    expect([...new URL(url).searchParams]).toEqual([['body', 'shardmind 0.1.9']]);
  });

  it('is the bare new-issue URL when the version cannot be read', () => {
    expect(bugReportUrl(undefined)).toBe('https://github.com/breferrari/shardmind/issues/new');
  });

  it('fits one 80-column line, so Ink never breaks it, even for a long version', () => {
    expect(bugReportUrl('10.20.30').length).toBeLessThanOrEqual(80);
    expect(bugReportUrl(undefined).length).toBeLessThanOrEqual(80);
  });
});
