/**
 * lintShard (#34): install's own checks in check mode, collecting every
 * finding instead of stopping at the first. Never runs shard code.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// A template named `Unreadable…` fails to read with EACCES: an I/O failure,
// not a problem in the shard (#35).
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const readFile = ((p: unknown, ...rest: unknown[]) =>
    String(p).includes('Unreadable')
      ? Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))
      : (real.readFile as (...a: unknown[]) => Promise<unknown>)(p, ...rest)) as typeof real.readFile;
  return { ...real, readFile, default: { ...real.default, readFile } };
});
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { lintShard, assertShardInstallable } from '../../source/core/lint-shard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MINIMAL_SHARD = path.resolve(__dirname, '../../examples/minimal-shard');

let root: string;
let shard: string;

beforeEach(async () => {
  root = path.join(os.tmpdir(), `shardmind-lint-${crypto.randomUUID()}`);
  shard = path.join(root, 'shard');
  await fsp.cp(MINIMAL_SHARD, shard, { recursive: true });
  // The example declares a hook but ships no .gitignore (its file count is
  // pinned across the E2E suites), so each copy gets one that keeps hook
  // logs out of git, as AUTHORING.md asks of a real shard (#201).
  await fsp.writeFile(path.join(shard, '.gitignore'), '.shardmind/logs/\n', 'utf-8');
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

  describe('external_tools (#138)', () => {
    const declareTool = (extra: string) =>
      edit('.shardmind/shard.yaml', (y) =>
        `${y}\nexternal_tools:\n  shardmind-no-such-tool:\n    package: no-such-tool\n    version: ">=1.0.0"\n    command: shardmind-no-such-tool\n${extra}`,
      );

    it('accepts a when that names a boolean value', async () => {
      await declareTool('    when: qmd_enabled\n');
      expect((await lintShard(shard, {})).findings).toEqual([]);
    });

    it.each([
      ['a string value', 'user_name'],
      ['no value at all', 'no_such_value'],
    ])('reports a when that names %s as EXTERNAL_TOOL_WHEN_INVALID', async (_name, key) => {
      await declareTool(`    when: ${key}\n`);
      const found = errors(await lintShard(shard, {})).filter((f) => f.code === 'EXTERNAL_TOOL_WHEN_INVALID');
      expect(found).toHaveLength(1);
      expect(found[0]!.message).toContain('shardmind-no-such-tool');
      expect(found[0]!.message).toContain(key);
    });

    // A tool missing from PATH would be reported if lint ran it.
    it('never runs a declared tool', async () => {
      await declareTool('');
      expect((await lintShard(shard, {})).findings).toEqual([]);
    });
  });

  it('reports two files that name one output, before anyone installs (#240)', async () => {
    // A template and a static file whose outputs differ only in case.
    await write('brain/Ideas.md.njk', '# ideas\n');
    await write('brain/ideas.md', 'static\n');
    const result = await lintShard(shard, {});
    const clash = errors(result).filter((f) => f.code === 'OUTPUT_PATH_CLASH');
    expect(clash).toHaveLength(1);
    expect(clash[0]!.message).toContain('brain/Ideas.md.njk');
    expect(clash[0]!.message).toContain('brain/ideas.md');
  });

  it('warns, not errors, when the clashing files are in two different modules (#240)', async () => {
    // Two modules that may be alternatives: installing with both is refused,
    // but the shard itself is not wrong.
    // One module gates the template, the other the static file; their
    // outputs differ only in case.
    await edit('.shardmind/shard-schema.yaml', (y) =>
      y.replace(
        'modules:\n',
        'modules:\n  simple:\n    label: "Simple"\n    paths: [alt/start.md]\n    removable: true\n' +
          '  fancy:\n    label: "Fancy"\n    paths: [alt/Start.md.njk]\n    removable: true\n',
      ),
    );
    await write('alt/start.md', 'simple\n');
    await write('alt/Start.md.njk', 'fancy\n');
    const result = await lintShard(shard, {});
    expect(errors(result).filter((f) => f.code === 'OUTPUT_PATH_CLASH')).toEqual([]);
    const warning = warnings(result).find((f) => f.code === 'LINT_OUTPUT_CLASH_ACROSS_MODULES');
    // The author can tell which pair of modules clashes.
    expect(warning?.message).toMatch(/Modules '(simple|fancy)' and '(simple|fancy)' clash/);
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

  it('reports frontmatter that is not YAML once rendered (#35)', async () => {
    await write('brain/Bad Front.md.njk', '---\ntags: [unclosed\n---\nbody\n');
    const result = await lintShard(shard, {});
    expect(errors(result)).toMatchObject([{ code: 'RENDER_FRONTMATTER_ERROR', path: 'brain/Bad Front.md' }]);
  });

  it('renders an undefined variable as empty, as install does: no finding (#35)', async () => {
    await write('brain/Missing.md.njk', 'Hello {{ no_such_value }}\n');
    expect((await lintShard(shard, {})).findings).toEqual([]);
  });

  it('reports a broken template in a removable module: every module is checked (#35)', async () => {
    await write('extras/Broken.md.njk', '{% endif %}\n');
    const result = await lintShard(shard, {});
    expect(errors(result)).toMatchObject([{ path: 'extras/Broken.md' }]);
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

  describe('hook logs and the vault .gitignore (#201)', () => {
    const LOGS = 'LINT_LOGS_NOT_GITIGNORED';
    const logWarning = (r: Awaited<ReturnType<typeof lintShard>>) => warnings(r).find((f) => f.code === LOGS);

    it('is quiet when the installed .gitignore ignores .shardmind/logs/', async () => {
      await write('.gitignore', '.DS_Store\n.shardmind/logs/\n');
      expect(logWarning(await lintShard(shard, {}))).toBeUndefined();
    });

    it.each([
      ['.shardmind/logs'],
      ['.shardmind/'],
      ['*.log'],
      ['/.shardmind/logs/*'],
    ])('accepts any rule that ignores the log files: %s', async (rule) => {
      await write('.gitignore', `${rule}\n`);
      expect(logWarning(await lintShard(shard, {}))).toBeUndefined();
    });

    it('warns when a shard with a hook installs no .gitignore', async () => {
      await fsp.rm(path.join(shard, '.gitignore'), { force: true });
      const warning = logWarning(await lintShard(shard, {}));
      expect(warning?.message).toMatch(/installs no \.gitignore/);
      expect(warning?.hint).toMatch(/\.shardmind\/logs\//);
    });

    it('warns when the .gitignore does not ignore the logs, and a negation can undo a broader rule', async () => {
      await write('.gitignore', 'node_modules/\n');
      expect(logWarning(await lintShard(shard, {}))?.message).toMatch(/does not ignore \.shardmind\/logs\//);
      await write('.gitignore', '*.log\n!.shardmind/logs/*.log\n');
      expect(logWarning(await lintShard(shard, {}))).toBeDefined();
    });

    it('reads a rendered .gitignore.njk, and ignores one that .shardmindignore keeps out of the vault', async () => {
      await fsp.rm(path.join(shard, '.gitignore'), { force: true });
      await write('.gitignore.njk', '{{ "" }}.shardmind/logs/\n');
      expect(logWarning(await lintShard(shard, {}))).toBeUndefined();
      await fsp.rm(path.join(shard, '.gitignore.njk'));
      await write('.gitignore', '.shardmind/logs/\n');
      await edit('.shardmindignore', (s) => `${s}\n.gitignore\n`);
      expect(logWarning(await lintShard(shard, {}))?.message).toMatch(/installs no \.gitignore/);
    });

    it('says nothing about logs for a shard that declares no hook', async () => {
      await fsp.rm(path.join(shard, '.gitignore'), { force: true });
      await edit('.shardmind/shard.yaml', (s) => s.replace(/hooks:[\s\S]*$/, ''));
      expect(logWarning(await lintShard(shard, {}))).toBeUndefined();
    });
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

describe('lintShard: what install renders (#35 review)', () => {
  const addPeople = () =>
    edit('.shardmind/shard-schema.yaml', (s) =>
      s.replace('values:\n', 'values:\n  people:\n    type: list\n    message: "People"\n    default: []\n    group: setup\n\n'),
    );

  it('compiles an _each template whose list is empty, so its syntax error is still found', async () => {
    await addPeople();
    await write('people/_each.md.njk', '{% if %}\n');
    expect(errors(await lintShard(shard, {}))).toMatchObject([{ code: 'RENDER_TEMPLATE_ERROR', path: 'people/_each.md' }]);
  });

  it('passes a sound _each template whose list is empty', async () => {
    await addPeople();
    await write('people/_each.md.njk', '# {{ item.name }}\n');
    expect((await lintShard(shard, {})).findings).toEqual([]);
  });

  it('renders vault_name from the vault the install targets', async () => {
    await write('brain/Vault.md.njk', '{% if vault_name != "My Vault" %}{{ vault_name | nosuchfilter }}{% endif %}\n');
    expect(errors(await lintShard(shard, {}))).toHaveLength(1);
    expect((await lintShard(shard, { vaultRoot: path.join(root, 'My Vault') })).findings).toEqual([]);
  });
});

describe('assertShardInstallable (#35)', () => {
  it('passes a clean shard, and one with warnings only', async () => {
    await expect(assertShardInstallable(shard, {}, root)).resolves.toBeUndefined();
    await edit('.shardmind/shard-schema.yaml', (s) => s.replace('groups:', 'groups:\n  - id: empty_group\n    label: "Empty"'));
    expect(warnings(await lintShard(shard, {}))).not.toEqual([]);
    await expect(assertShardInstallable(shard, {}, root)).resolves.toBeUndefined();
  });

  it('lists every error with its code and path in one INSTALL_SHARD_INVALID', async () => {
    await write('brain/Broken One.md.njk', '{% if %}\n');
    await write('extras/Broken Two.md.njk', '{{ not_a_function() }}\n');
    const err = await assertShardInstallable(shard, {}, root).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'INSTALL_SHARD_INVALID' });
    expect((err as Error).message).toMatch(/2 problems/);
    expect((err as Error).message).toMatch(/brain\/Broken One\.md: [\s\S]* \[RENDER_\w+\]/);
    expect((err as Error).message).toMatch(/extras\/Broken Two\.md/);
  });

  it('lets an engine or I/O failure through as itself, not as a broken shard', async () => {
    await write('brain/Unreadable.md.njk', 'hello\n');
    const err = await assertShardInstallable(shard, {}, root).catch((e: unknown) => e);
    expect(err).not.toMatchObject({ code: 'INSTALL_SHARD_INVALID' });
    expect((err as Error).message).toMatch(/EACCES/);
  });

  it('names each file once, and keeps a multi-line message under its bullet', async () => {
    await write('brain/Bad Front.md.njk', '---\ntags: [unclosed\n---\nbody\n');
    const message = ((await assertShardInstallable(shard, {}, root).catch((e: unknown) => e)) as Error).message;
    expect(message.match(/brain[/]Bad Front[.]md/g)).toHaveLength(1);
    expect(message.split('\n').length).toBeGreaterThan(2);
    for (const line of message.split('\n').slice(1)) expect(line).toMatch(/^(  - |    )/);
  });

  it('checks the shard with the defaults when the prefill itself is invalid', async () => {
    await expect(assertShardInstallable(shard, { vault_purpose: 'not-an-option' }, root)).resolves.toBeUndefined();
    await write('brain/Broken.md.njk', '{% if %}\n');
    await expect(assertShardInstallable(shard, { vault_purpose: 'not-an-option' }, root)).rejects.toMatchObject({
      code: 'INSTALL_SHARD_INVALID',
      message: expect.stringMatching(/brain\/Broken\.md/),
    });
  });
});
