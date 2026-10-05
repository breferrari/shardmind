/**
 * Each kit's VENDOR.json (schemaVersion 1, shared with #280's vendor
 * tooling) describes the kit as it is: every vendored file is in the
 * record, and its header is exactly the one generated from the record, so
 * `vendor:update` can strip and re-add it byte for byte. Files ShardMind
 * wrote itself are not in the record and carry their own copyright.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../source');

interface FileEntry {
  upstream: string;
  modified: boolean;
  change?: string;
}

interface VendorRecord {
  schemaVersion: 1;
  kit: string;
  package: string;
  version: string;
  repository: string;
  tag: string;
  tagPattern?: string;
  commit: string;
  tarball: { url: string; integrity: string };
  sourceRoot: string;
  license: string;
  copyright: string;
  modifiedBy: string;
  files: Record<string, FileEntry>;
}

/** The agreed header bytes (#280 moves this to scripts/vendor/record.ts). */
function headerFor(record: VendorRecord, file: string): string {
  const entry = record.files[file]!;
  const lines = [
    '/*',
    ` * From ${record.package}@${record.version} (${record.repository} at ${record.commit}), ${entry.upstream}.`,
    ` * Copyright (c) ${record.copyright}. ${record.license}: see ${record.kit}/LICENSE.`,
  ];
  if (entry.modified) lines.push(` * Modified by ${record.modifiedBy}: ${entry.change}`);
  lines.push(' */');
  return `${lines.join('\n')}\n\n`;
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value) || value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sorted((value as Record<string, unknown>)[key])]),
  );
}

describe.each(['ui-kit', 'cli-kit'])('%s/VENDOR.json', (kit) => {
  const dir = path.join(SOURCE, kit);
  const raw = fs.readFileSync(path.join(dir, 'VENDOR.json'), 'utf-8');
  const record = JSON.parse(raw) as VendorRecord;

  it('is written with sorted keys, two-space indent and a trailing newline', () => {
    expect(raw).toBe(`${JSON.stringify(sorted(record), null, 2)}\n`);
    expect(record.schemaVersion).toBe(1);
    expect(record.kit).toBe(kit);
    expect(record.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(record.tag).toBe((record.tagPattern ?? 'v{version}').replace('{version}', record.version));
  });

  it('gives every modified file a one-line change, and no unmodified file one', () => {
    for (const [file, entry] of Object.entries(record.files)) {
      if (entry.modified) expect(entry.change, file).toMatch(/^[^\n]+$/);
      else expect(entry.change, file).toBeUndefined();
    }
  });

  it('starts each recorded file with the header generated from the record', () => {
    for (const file of Object.keys(record.files)) {
      const text = fs.readFileSync(path.join(dir, file), 'utf-8');
      expect(text.startsWith(headerFor(record, file)), file).toBe(true);
    }
  });

  it('records every file that carries an upstream header, and only those', () => {
    const headed = (fs.readdirSync(dir, { recursive: true }) as string[])
      .map((rel) => rel.split(path.sep).join('/'))
      .filter((rel) => /\.(ts|tsx)$/.test(rel))
      .filter((rel) => fs.readFileSync(path.join(dir, rel), 'utf-8').startsWith(`/*\n * From ${record.package}@`))
      .sort();
    expect(headed).toEqual(Object.keys(record.files).sort());
  });
});
