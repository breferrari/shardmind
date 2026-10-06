/**
 * `parseCommandArgv` (#302): a command's arguments parsed as a Pastel run
 * parses them, without Ink, for the headless `--json` runs.
 */

import { describe, it, expect } from 'vitest';
import zod from 'zod';
import { parseCommandArgv } from '../../source/cli-kit/parse.js';

const options = zod.object({
  verbose: zod.boolean().default(false).describe('Verbose'),
  json: zod.boolean().default(false).describe('JSON'),
  dryRun: zod.boolean().default(false).describe('Dry run'),
  values: zod.string().optional().describe('Values file'),
  mode: zod.enum(['keep-all-mine', 'use-all-theirs']).optional().describe('Mode'),
  updateCheck: zod.boolean().default(true).describe('Update check'),
});
const args = zod.tuple([zod.string().describe('shard')]);

describe('parseCommandArgv (#302)', () => {
  it('parses options with their defaults, kebab-case on the line', () => {
    expect(parseCommandArgv(['--json', '--dry-run', '--values', 'v.yaml'], { options })).toEqual({
      args: [],
      options: { verbose: false, json: true, dryRun: true, values: 'v.yaml', updateCheck: true },
    });
  });

  it('reads --no-update-check as updateCheck false', () => {
    expect(parseCommandArgv(['--no-update-check'], { options }).options).toMatchObject({ updateCheck: false });
  });

  it('parses positional arguments, and one after --', () => {
    expect(parseCommandArgv(['github:a/b', '--json'], { args, options }).args).toEqual(['github:a/b']);
    expect(parseCommandArgv(['--json', '--', '--looks-like-a-flag'], { args, options }).args).toEqual(['--looks-like-a-flag']);
  });

  it("refuses an unknown option with Commander's message", () => {
    expect(() => parseCommandArgv(['--json', '--nope'], { options })).toThrow("error: unknown option '--nope'");
  });

  it('refuses a string option given without its value, with the zod message a Pastel run prints', () => {
    // Pastel declares an optional string as `--values [values]`: alone, it is `true`.
    expect(() => parseCommandArgv(['--json', '--values'], { options })).toThrow('Invalid input: expected string, received boolean at "values"');
  });

  it("refuses a value outside an enum's choices, as Commander does in a Pastel run", () => {
    expect(() => parseCommandArgv(['--json', '--mode', 'sideways'], { options })).toThrow(/^error: option '--mode \[mode\]' argument 'sideways' is invalid\./);
  });

  it('refuses a missing required argument', () => {
    expect(() => parseCommandArgv(['--json'], { args, options })).toThrow("error: missing required argument 'shard'");
  });
});
