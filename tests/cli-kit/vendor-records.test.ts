/**
 * Each kit's VENDOR.json (schemaVersion 1, read and written by
 * scripts/vendor/, #280) describes the kit as it is: every vendored file is in the
 * record, and its header is exactly the one generated from the record, so
 * `vendor:update` can strip and re-add it byte for byte. Files ShardMind
 * wrote itself are not in the record and carry their own copyright.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatRecord, headerFor, parseRecord, stripHeader, tagFor } from '../../scripts/vendor/record.js';

const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../source');

describe.each(['ui-kit', 'cli-kit'])('%s/VENDOR.json', (kit) => {
  const dir = path.join(SOURCE, kit);
  const raw = fs.readFileSync(path.join(dir, 'VENDOR.json'), 'utf-8');
  // The vendor tooling's own schema: a record it would refuse fails here, not at the next update.
  const record = parseRecord(JSON.parse(raw));

  it('is valid under the tooling schema and in the exact bytes vendor:update writes', () => {
    expect(raw).toBe(formatRecord(record));
    expect(record.kit).toBe(kit);
    expect(record.tag).toBe(tagFor(record, record.version));
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
      // vendor:update strips it the same way, so an update can start from this kit.
      expect(() => stripHeader(text, record, file), file).not.toThrow();
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
