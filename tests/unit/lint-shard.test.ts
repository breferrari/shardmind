/**
 * lintShard (#34): install's own checks in check mode, collecting every
 * finding instead of stopping at the first. Never runs shard code.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { lintShard } from '../../source/core/lint-shard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MINIMAL_SHARD = path.resolve(__dirname, '../../examples/minimal-shard');

let root: string;
let shard: string;

beforeEach(async () => {
  root = path.join(os.tmpdir(), `shardmind-lint-${crypto.randomUUID()}`);
  shard = path.join(root, 'shard');
  await fsp.cp(MINIMAL_SHARD, shard, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

const write = async (rel: string, body: string) => {
  await fsp.mkdir(path.dirname(path.join(shard, rel)), { recursive: true });
  await fsp.writeFile(path.join(shard, rel), body, 'utf-8');
};
const edit = async (rel: string, fn: (s: string) => string) =>
  write(rel, fn(await fsp.readFile(path.join(shard, rel), 'utf-8')));
const errors = (r: Awaited<ReturnType<typeof lintShard>>) => r.findings.filter((f) => f.severity === 'error');
const warnings = (r: Awaited<ReturnType<typeof lintShard>>) => r.findings.filter((f) => f.severity === 'warning');

describe('lintShard (#34)', () => {
  it('finds nothing in the minimal shard', async () => {
    const result = await lintShard(shard, {});
    expect(result.findings).toEqual([]);
  });

  it('reports an unparseable schema and stops there', async () => {
    await write('.shardmind/shard-schema.yaml', 'schema_version: 1\nvalues: [not, a, map]\n');
    const result = await lintShard(shard, {});
    expect(errors(result)).toHaveLength(1);
    expect(errors(result)[0]!.code).toMatch(/^SCHEMA_/);
  });

  it('collects every broken template, each with its path, instead of stopping at the first', async () => {
    await write('brain/Broken One.md.njk', '{% if %}\n');
    await write('brain/Broken Two.md.njk', '{{ user_name | nosuchfilter }}\n');
    const result = await lintShard(shard, {});
    expect(errors(result).map((f) => f.path).sort()).toEqual(['brain/Broken One.md', 'brain/Broken Two.md']);
    for (const f of errors(result)) expect(f.code).toMatch(/^RENDER_/);
  });

  it('renders with the schema defaults, and with --values over them', async () => {
    // Breaks only when org_name is Acme: clean with the default, an error
    // with the supplied value, so supplied values are what renders.
    await write('brain/Acme.md.njk', '{% if org_name == "Acme" %}{{ org_name | nosuchfilter }}{% endif %}\n');
    expect((await lintShard(shard, {})).findings).toEqual([]);
    const supplied = await lintShard(shard, { values: { org_name: 'Acme' } });
    expect(errors(supplied).map((f) => f.path)).toEqual(['brain/Acme.md']);
  });

  it('reports a supplied value the schema rejects, without coercing it', async () => {
    const badOption = await lintShard(shard, { values: { vault_purpose: 'not-an-option' } });
    expect(errors(badOption).map((f) => f.code)).toEqual(['VALUES_INVALID']);
    const wrongType = await lintShard(shard, { values: { qmd_enabled: 'yes' } });
    expect(errors(wrongType).map((f) => f.code)).toEqual(['VALUES_INVALID']);
    expect(errors(wrongType)[0]!.message).toMatch(/qmd_enabled/);
  });

  it('stops at a failed computed default instead of echoing it as an error per template', async () => {
    await edit('.shardmind/shard-schema.yaml', (s) =>
      s.replace('groups:', '  broken_default:\n    type: string\n    message: "Broken"\n    default: "{{ nosuchvalue | nosuchfilter }}"\n    group: setup\n\ngroups:'),
    );
    const result = await lintShard(shard, {});
    expect(errors(result).map((f) => f.code)).toEqual(['COMPUTED_DEFAULT_FAILED']);
  });

  it('stops at invalid values instead of rendering every template with them', async () => {
    await write('brain/Uses Purpose.md.njk', '{{ vault_purpose | nosuchfilter }}\n');
    const result = await lintShard(shard, { values: { vault_purpose: 'not-an-option' } });
    expect(errors(result).map((f) => f.code)).toEqual(['VALUES_INVALID']);
  });

  it('reports a supplied key the schema does not declare', async () => {
    const result = await lintShard(shard, { values: { usr_name: 'typo' } });
    expect(errors(result).map((f) => f.code)).toEqual(['VALUES_FILE_INVALID']);
    expect(errors(result)[0]!.message).toMatch(/usr_name/);
  });

  it('warns about a module whose paths match no file and a group with no values', async () => {
    await edit('.shardmind/shard-schema.yaml', (s) =>
      s
        .replace('groups:\n', 'groups:\n  - id: empty\n    label: "Nothing here"\n')
        .replace('modules:\n', 'modules:\n  ghost:\n    label: "Ghost"\n    paths: ["ghost/"]\n    removable: true\n\n'),
    );
    const result = await lintShard(shard, {});
    expect(errors(result)).toEqual([]);
    expect(warnings(result).map((f) => f.message).join('\n')).toMatch(/ghost/);
    expect(warnings(result).map((f) => f.message).join('\n')).toMatch(/empty/);
  });

  it('reports an engine-version requirement this engine does not meet', async () => {
    await edit('.shardmind/shard.yaml', (s) => s.replace('requires:\n', 'requires:\n  shardmind: ">=99.0.0"\n'));
    const result = await lintShard(shard, { engineVersion: '0.1.7' });
    expect(errors(result).length).toBe(1);
  });

  it('never runs shard code: a hook that would write a marker does not run', async () => {
    const marker = path.join(root, 'hook-ran');
    const hook = `import { writeFileSync } from 'node:fs';\nexport default async function () { writeFileSync(${JSON.stringify(marker)}, 'x'); }\n`;
    await write('.shardmind/hooks/post-install.ts', hook);
    await write('hooks/post-install.ts', hook);
    await edit('.shardmind/shard.yaml', (s) =>
      s.replace(/hooks:[\s\S]*$/, 'hooks:\n  bootstrap:\n    script: .shardmind/hooks/post-install.ts\n  personalize: .shardmind/hooks/post-install.ts\n'),
    );
    await lintShard(shard, {});
    await expect(fsp.access(marker)).rejects.toBeTruthy();
  });
});

describe('parseValidateArgv (#34)', () => {
  it('reads the target, --values in both forms, and ignores other flags', async () => {
    const { parseValidateArgv } = await import('../../source/core/validate-shard.js');
    expect(parseValidateArgv([])).toEqual({ target: '.' });
    expect(parseValidateArgv(['--json'])).toEqual({ target: '.' });
    expect(parseValidateArgv(['shard', '--json'])).toEqual({ target: 'shard' });
    expect(parseValidateArgv(['--values', 'v.yaml', 'shard'])).toEqual({ target: 'shard', valuesFile: 'v.yaml' });
    expect(parseValidateArgv(['shard', '--values=v.yaml', '--verbose'])).toEqual({ target: 'shard', valuesFile: 'v.yaml' });
    expect(parseValidateArgv(['--json', '--', '--weird-name'])).toEqual({ target: '--weird-name' });
    expect(() => parseValidateArgv(['--values'])).toThrow(expect.objectContaining({ code: 'VALIDATE_TARGET_INVALID' }));
    expect(() => parseValidateArgv(['--values', '--json'])).toThrow(expect.objectContaining({ code: 'VALIDATE_TARGET_INVALID' }));
  });

  it('refuses a path-shaped target that is missing or a file, never looking it up as a reference', async () => {
    const { validateShard } = await import('../../source/core/validate-shard.js');
    await expect(validateShard(path.join(root, 'nope'), {})).rejects.toMatchObject({ code: 'VALIDATE_TARGET_INVALID' });
    await expect(validateShard('./nope', {})).rejects.toMatchObject({ code: 'VALIDATE_TARGET_INVALID' });
    await expect(validateShard(path.join(shard, 'CLAUDE.md'), {})).rejects.toMatchObject({ code: 'VALIDATE_TARGET_INVALID' });
  });
});
