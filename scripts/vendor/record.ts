/**
 * The vendored-kit record, `source/<kit>/VENDOR.json`, and the provenance
 * header every vendored file starts with (#280; schema agreed with #277).
 * Repo tooling: never shipped, never imported from `source/`.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { isEnoent } from '../../source/runtime/errno.js';

/** A relative POSIX path that stays inside its folder: no `..`, no root, no backslash. */
const RelativePath = z
  .string()
  .refine(
    (p) => !p.startsWith('/') && !/^[A-Za-z]:/.test(p) && !p.includes('\\') && !p.split('/').includes('..'),
    'a relative path inside its folder',
  );

const FileSchema = z
  .object({
    upstream: RelativePath.pipe(z.string().min(1)),
    modified: z.boolean(),
    change: z.string().min(1).regex(/^[^\n]*$/, 'one line').optional(),
  })
  .strict()
  .refine((f) => !f.modified || f.change !== undefined, { message: 'a modified file needs its change' });

export const VendorRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    kit: z.string().min(1),
    package: z.string().min(1),
    version: z.string().min(1),
    repository: z.string().url(),
    tag: z.string().min(1),
    tagPattern: z.string().includes('{version}').optional(),
    commit: z.string().regex(/^[0-9a-f]{40}$/, 'a full 40-character commit'),
    tarball: z.object({ url: z.string().url(), integrity: z.string().min(1) }).strict(),
    sourceRoot: RelativePath,
    license: z.string().min(1),
    copyright: z.string().min(1),
    modifiedBy: z.string().min(1),
    files: z.record(RelativePath.pipe(z.string().min(1)), FileSchema),
  })
  .strict();

export type VendorRecord = z.infer<typeof VendorRecordSchema>;

export const RECORD_FILE = 'VENDOR.json';

export function parseRecord(raw: unknown): VendorRecord {
  return VendorRecordSchema.parse(raw);
}

export async function readRecord(kitDir: string): Promise<VendorRecord> {
  return parseRecord(JSON.parse(await fsp.readFile(path.join(kitDir, RECORD_FILE), 'utf-8')));
}

/** `value` with every object's keys sorted, at every depth. */
function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value) || value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortedKeys((value as Record<string, unknown>)[key])]),
  );
}

/** The record's bytes: keys sorted at every depth, two-space JSON, a trailing newline (#281's committed form). */
export function formatRecord(record: VendorRecord): string {
  return `${JSON.stringify(sortedKeys(record), null, 2)}\n`;
}

export async function writeRecord(kitDir: string, record: VendorRecord): Promise<void> {
  await fsp.writeFile(path.join(kitDir, RECORD_FILE), formatRecord(record), 'utf-8');
}

/** Text with CRLF line ends read as LF, so a checkout's line-end setting never reads as a change. */
export function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/** A vendored file of the kit, as LF text; names the file when it is missing. */
export async function readKitFile(kitDir: string, record: VendorRecord, file: string): Promise<string> {
  try {
    return toLf(await fsp.readFile(path.join(kitDir, file), 'utf-8'));
  } catch (err) {
    if (isEnoent(err)) throw new Error(`${record.kit}/${file} is in VENDOR.json but not on disk`);
    throw err;
  }
}

/** The tag a version of the package is released under. */
export function tagFor(record: VendorRecord, version: string): string {
  return (record.tagPattern ?? 'v{version}').replace('{version}', version);
}

/** The provenance header of a vendored file, every byte generated from the record. */
export function headerFor(record: VendorRecord, file: string): string {
  const entry = record.files[file];
  if (!entry) throw new Error(`${file} is not a vendored file of ${record.kit}`);
  const lines = [
    '/*',
    ` * From ${record.package}@${record.version} (${record.repository} at ${record.commit}), ${entry.upstream}.`,
    ` * Copyright (c) ${record.copyright}. ${record.license}: see ${record.kit}/LICENSE.`,
  ];
  if (entry.modified) lines.push(` * Modified by ${record.modifiedBy}: ${entry.change}`);
  lines.push(' */', '', '');
  return lines.join('\n');
}

/** A vendored file without its header; refuses one whose header is not exactly the generated one. */
export function stripHeader(text: string, record: VendorRecord, file: string): string {
  const header = headerFor(record, file);
  if (!text.startsWith(header)) {
    throw new Error(`${record.kit}/${file}: its header is not the one VENDOR.json generates; fix the header or the record`);
  }
  return text.slice(header.length);
}
