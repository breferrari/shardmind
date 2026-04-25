/**
 * Unit tests for `source/core/adopt-planner.ts::classifyAdoption`.
 *
 * Adopt classification is the load-bearing step of the v6 adopt flow: it
 * decides which user-vault paths land as managed-auto vs. managed-after-
 * 2-way-prompt vs. shard-only-fresh-install vs. user-content-untouched.
 * Pure logic with a real invariant — covered by per-case fixtures plus
 * two fast-check properties (monotonicity + mutation-detection).
 *
 * Spec: `docs/SHARD-LAYOUT.md §Adopt semantics`. Adversarial enumeration
 * matches PR #77's `Take Next` plan; every numbered case there has a
 * matching `it(...)` here.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as fc from 'fast-check';

import { classifyAdoption } from '../../source/core/adopt-planner.js';
import type {
  ShardManifest,
  ShardSchema,
  ModuleSelections,
} from '../../source/runtime/types.js';
import { makeShardSource } from '../helpers/index.js';
import { sha256 } from '../../source/core/fs-utils.js';

const FIXED_DATE = new Date('2026-04-25T12:00:00Z');

function emptySchema(overrides: Partial<ShardSchema> = {}): ShardSchema {
  return {
    schema_version: 1,
    values: {},
    groups: [{ id: 'setup', label: 'Setup' }],
    modules: {},
    signals: [],
    frontmatter: {},
    migrations: [],
    ...overrides,
  };
}

function manifest(): ShardManifest {
  return {
    apiVersion: 'v1',
    name: 'demo',
    namespace: 'acme',
    version: '1.0.0',
    dependencies: [],
    hooks: {},
  };
}

interface Harness {
  tempShard: string;
  vault: string;
  cleanup: () => Promise<void>;
}

async function makeHarness(prefix: string): Promise<Harness> {
  const tempShard = path.join(os.tmpdir(), `shardmind-adopt-shard-${prefix}-${crypto.randomUUID()}`);
  const vault = path.join(os.tmpdir(), `shardmind-adopt-vault-${prefix}-${crypto.randomUUID()}`);
  await fsp.mkdir(vault, { recursive: true });
  return {
    tempShard,
    vault,
    cleanup: async () => {
      await fsp.rm(tempShard, { recursive: true, force: true });
      await fsp.rm(vault, { recursive: true, force: true });
    },
  };
}

describe('classifyAdoption', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await makeHarness('main');
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('case 3: empty user vault → every shard file is shardOnly', async () => {
    await makeShardSource(harness.tempShard, {
      'README.md': '# repo\n',
      'CLAUDE.md': '# claude\n',
      'brain/North Star.md': 'goals\n',
    });

    const plan = await classifyAdoption({
      vaultRoot: harness.vault,
      schema: emptySchema(),
      manifest: manifest(),
      tempDir: harness.tempShard,
      values: {},
      selections: {},
      now: FIXED_DATE,
    });

    expect(plan.matches).toEqual([]);
    expect(plan.differs).toEqual([]);
    expect(plan.shardOnly.map((c) => c.path).sort()).toEqual([
      'CLAUDE.md',
      'README.md',
      'brain/North Star.md',
    ]);
    expect(plan.totalShardFiles).toBe(3);
  });

  it('case 4: user vault byte-equivalent to shard → all matches, zero differs', async () => {
    await makeShardSource(harness.tempShard, {
      'CLAUDE.md': 'pinned\n',
      'brain/North Star.md': 'fixed\n',
    });
    await fsp.writeFile(path.join(harness.vault, 'CLAUDE.md'), 'pinned\n', 'utf-8');
    await fsp.mkdir(path.join(harness.vault, 'brain'), { recursive: true });
    await fsp.writeFile(path.join(harness.vault, 'brain', 'North Star.md'), 'fixed\n', 'utf-8');

    const plan = await classifyAdoption({
      vaultRoot: harness.vault,
      schema: emptySchema(),
      manifest: manifest(),
      tempDir: harness.tempShard,
      values: {},
      selections: {},
      now: FIXED_DATE,
    });

    expect(plan.matches.map((c) => c.path).sort()).toEqual(['CLAUDE.md', 'brain/North Star.md']);
    expect(plan.differs).toEqual([]);
    expect(plan.shardOnly).toEqual([]);
  });

  it('classifies a mix: matches + differs + shardOnly in one walk', async () => {
    await makeShardSource(harness.tempShard, {
      'a.md': 'aaa\n',
      'b.md': 'bbb\n',
      'c.md': 'ccc\n',
    });
    // a.md matches; b.md differs; c.md is shard-only (user doesn't have it).
    await fsp.writeFile(path.join(harness.vault, 'a.md'), 'aaa\n', 'utf-8');
    await fsp.writeFile(path.join(harness.vault, 'b.md'), 'BBB-modified\n', 'utf-8');

    const plan = await classifyAdoption({
      vaultRoot: harness.vault,
      schema: emptySchema(),
      manifest: manifest(),
      tempDir: harness.tempShard,
      values: {},
      selections: {},
      now: FIXED_DATE,
    });

    expect(plan.matches.map((c) => c.path)).toEqual(['a.md']);
    expect(plan.differs.map((c) => c.path)).toEqual(['b.md']);
    expect(plan.shardOnly.map((c) => c.path)).toEqual(['c.md']);

    const diff = plan.differs[0]!;
    if (diff.kind !== 'differs') throw new Error('expected differs');
    expect(diff.userHash).toBe(sha256(Buffer.from('BBB-modified\n', 'utf-8')));
    expect(diff.shardHash).toBe(sha256(Buffer.from('bbb\n', 'utf-8')));
    expect(diff.isBinary).toBe(false);
  });

  it('case 5: Tier 1 entries in user vault are silently ignored (never enumerated)', async () => {
    await makeShardSource(harness.tempShard, { 'CLAUDE.md': 'shard claude\n' });
    // User has stray Tier 1 dirs — these are never enumerated by the planner
    // (classification is shard-source-driven), so they never appear in any
    // bucket. Same path the install walk uses.
    await fsp.mkdir(path.join(harness.vault, '.git'), { recursive: true });
    await fsp.writeFile(path.join(harness.vault, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await fsp.mkdir(path.join(harness.vault, '.obsidian'), { recursive: true });
    await fsp.writeFile(
      path.join(harness.vault, '.obsidian', 'workspace.json'),
      '{}',
      'utf-8',
    );

    const plan = await classifyAdoption({
      vaultRoot: harness.vault,
      schema: emptySchema(),
      manifest: manifest(),
      tempDir: harness.tempShard,
      values: {},
      selections: {},
      now: FIXED_DATE,
    });

    const allPaths = [
      ...plan.matches.map((c) => c.path),
      ...plan.differs.map((c) => c.path),
      ...plan.shardOnly.map((c) => c.path),
    ];
    expect(allPaths).toEqual(['CLAUDE.md']);
    expect(allPaths).not.toContain('.git/HEAD');
    expect(allPaths).not.toContain('.obsidian/workspace.json');
  });

  it('case 6: paths filtered by .shardmindignore are not classified', async () => {
    await makeShardSource(harness.tempShard, {
      'README.md': 'main readme\n',
      'README.ja.md': 'translation\n',
      '.shardmindignore': 'README.*.md\n',
    });
    // User has both files including the ignored translation.
    await fsp.writeFile(path.join(harness.vault, 'README.md'), 'main readme\n', 'utf-8');
    await fsp.writeFile(path.join(harness.vault, 'README.ja.md'), 'translation\n', 'utf-8');

    const plan = await classifyAdoption({
      vaultRoot: harness.vault,
      schema: emptySchema(),
      manifest: manifest(),
      tempDir: harness.tempShard,
      values: {},
      selections: {},
      now: FIXED_DATE,
    });

    // README.md matches (user has byte-equivalent). `.shardmindignore` itself
    // is part of the shard's installable file set (Tier 1 excludes engine
    // metadata, not the ignore file authors use to gate vault content), so
    // it appears as shardOnly when the user's vault doesn't contain it.
    // README.ja.md never gets classified — the ignore filter excluded it
    // from the shard walk, so adopt has no opinion about it.
    expect(plan.matches.map((c) => c.path)).toEqual(['README.md']);
    expect(plan.differs).toEqual([]);
    expect(plan.shardOnly.map((c) => c.path)).toEqual(['.shardmindignore']);

    const allPaths = [
      ...plan.matches.map((c) => c.path),
      ...plan.differs.map((c) => c.path),
      ...plan.shardOnly.map((c) => c.path),
    ];
    expect(allPaths).not.toContain('README.ja.md');
  });

  it('case 7: CRLF user file vs LF shard render → differs (strict byte equality)', async () => {
    await makeShardSource(harness.tempShard, { 'note.md': 'line one\nline two\n' });
    await fsp.writeFile(
      path.join(harness.vault, 'note.md'),
      'line one\r\nline two\r\n',
      'utf-8',
    );

    const plan = await classifyAdoption({
      vaultRoot: harness.vault,
      schema: emptySchema(),
      manifest: manifest(),
      tempDir: harness.tempShard,
      values: {},
      selections: {},
      now: FIXED_DATE,
    });

    expect(plan.matches).toEqual([]);
    expect(plan.differs.map((c) => c.path)).toEqual(['note.md']);
  });

  it('case 8: .njk template that renders to user bytes → matches', async () => {
    await makeShardSource(harness.tempShard, {
      'Home.md.njk': 'Welcome, {{ user_name }}.\n',
    });
    await fsp.writeFile(path.join(harness.vault, 'Home.md'), 'Welcome, Alice.\n', 'utf-8');

    const schema = emptySchema({
      values: {
        user_name: {
          type: 'string',
          message: 'name',
          default: '',
          group: 'setup',
        },
      },
    });

    const plan = await classifyAdoption({
      vaultRoot: harness.vault,
      schema,
      manifest: manifest(),
      tempDir: harness.tempShard,
      values: { user_name: 'Alice' },
      selections: {},
      now: FIXED_DATE,
    });

    expect(plan.matches.map((c) => c.path)).toEqual(['Home.md']);
  });

  it('case 9: .njk render with frontmatter → comparison uses post-normalization bytes', async () => {
    // The template emits frontmatter that the renderer parses + restringifies.
    // A user file with the post-render-normalized form should match; a user
    // file with a pre-render shape (different YAML quoting) won't, even if
    // semantically equivalent. Pin both directions.
    const templateSrc = '---\nname: {{ user_name }}\n---\nbody\n';
    await makeShardSource(harness.tempShard, { 'note.md.njk': templateSrc });
    const schema = emptySchema({
      values: {
        user_name: {
          type: 'string',
          message: 'name',
          default: '',
          group: 'setup',
        },
      },
    });

    // First: write the user's file as the template would render. This is
    // post-render normalization ("name: alice", no quotes, single trailing
    // newline emitted by stringifyYaml + the body block).
    await fsp.writeFile(path.join(harness.vault, 'note.md'), '---\nname: alice\n---\nbody\n', 'utf-8');

    const plan = await classifyAdoption({
      vaultRoot: harness.vault,
      schema,
      manifest: manifest(),
      tempDir: harness.tempShard,
      values: { user_name: 'alice' },
      selections: {},
      now: FIXED_DATE,
    });
    expect(plan.matches.map((c) => c.path)).toEqual(['note.md']);

    // Second: a YAML-equivalent but byte-different shape (`'alice'` quoted)
    // legitimately produces a differs prompt. This pins the spec
    // clarification: equality is post-normalization byte-for-byte.
    await fsp.writeFile(path.join(harness.vault, 'note.md'), "---\nname: 'alice'\n---\nbody\n", 'utf-8');
    const plan2 = await classifyAdoption({
      vaultRoot: harness.vault,
      schema,
      manifest: manifest(),
      tempDir: harness.tempShard,
      values: { user_name: 'alice' },
      selections: {},
      now: FIXED_DATE,
    });
    expect(plan2.differs.map((c) => c.path)).toEqual(['note.md']);
  });

  it('case 10: volatile-marker template → user bytes recorded as managed without prompt', async () => {
    await makeShardSource(harness.tempShard, {
      'log.md.njk': '{# shardmind: volatile #}\nrender-time: {{ install_date }}\n',
    });
    // User has hand-edited content unrelated to the template body. Volatile
    // means no prompt — the user's bytes are accepted as-is.
    await fsp.writeFile(path.join(harness.vault, 'log.md'), 'whatever the user put here\n', 'utf-8');

    const plan = await classifyAdoption({
      vaultRoot: harness.vault,
      schema: emptySchema(),
      manifest: manifest(),
      tempDir: harness.tempShard,
      values: {},
      selections: {},
      now: FIXED_DATE,
    });

    expect(plan.differs).toEqual([]);
    expect(plan.matches.map((c) => c.path)).toEqual(['log.md']);
    const m = plan.matches[0]!;
    expect(m.volatile).toBe(true);
    // User's bytes drive the recorded hash, not the rendered template.
    expect(m.shardHash).toBe(sha256(Buffer.from('whatever the user put here\n', 'utf-8')));
  });

  it('case 10b: volatile + missing user file → falls back to shardOnly (install fresh)', async () => {
    await makeShardSource(harness.tempShard, {
      'log.md.njk': '{# shardmind: volatile #}\nrender-time: {{ install_date }}\n',
    });

    const plan = await classifyAdoption({
      vaultRoot: harness.vault,
      schema: emptySchema(),
      manifest: manifest(),
      tempDir: harness.tempShard,
      values: {},
      selections: {},
      now: FIXED_DATE,
    });

    expect(plan.shardOnly.map((c) => c.path)).toEqual(['log.md']);
    expect(plan.shardOnly[0]?.volatile).toBe(true);
  });

  it('case 11: excluded-module files in user vault → not classified', async () => {
    await makeShardSource(harness.tempShard, {
      'extras/feature.md': 'extras body\n',
      'CLAUDE.md': 'always included\n',
    });
    // User has files at the excluded module's paths.
    await fsp.mkdir(path.join(harness.vault, 'extras'), { recursive: true });
    await fsp.writeFile(path.join(harness.vault, 'extras', 'feature.md'), 'user-edited extras\n', 'utf-8');
    await fsp.writeFile(path.join(harness.vault, 'CLAUDE.md'), 'always included\n', 'utf-8');

    const schema = emptySchema({
      modules: {
        extras: {
          label: 'Extras',
          paths: ['extras/'],
          removable: true,
        },
      },
    });
    const selections: ModuleSelections = { extras: 'excluded' };

    const plan = await classifyAdoption({
      vaultRoot: harness.vault,
      schema,
      manifest: manifest(),
      tempDir: harness.tempShard,
      values: {},
      selections,
      now: FIXED_DATE,
    });

    expect(plan.matches.map((c) => c.path)).toEqual(['CLAUDE.md']);
    // extras/feature.md never appears — user content stays user content.
    const allPaths = [
      ...plan.matches.map((c) => c.path),
      ...plan.differs.map((c) => c.path),
      ...plan.shardOnly.map((c) => c.path),
    ];
    expect(allPaths).not.toContain('extras/feature.md');
  });

  it('case 13: iterator template expands and matches per-iteration outputs', async () => {
    await makeShardSource(harness.tempShard, {
      'bases/widget/_each.md.njk': '# {{ item.slug }}\nbody\n',
    });
    // Pre-create one of the two expected outputs to test partial match.
    await fsp.mkdir(path.join(harness.vault, 'bases', 'widget'), { recursive: true });
    await fsp.writeFile(
      path.join(harness.vault, 'bases', 'widget', 'alpha.md'),
      '# alpha\nbody\n',
      'utf-8',
    );

    const plan = await classifyAdoption({
      vaultRoot: harness.vault,
      schema: emptySchema({
        values: {
          widget: {
            type: 'list',
            message: 'widgets',
            default: '[]',
            group: 'setup',
          },
        },
      }),
      manifest: manifest(),
      tempDir: harness.tempShard,
      values: { widget: [{ slug: 'alpha' }, { slug: 'beta' }] },
      selections: {},
      now: FIXED_DATE,
    });

    expect(plan.matches.map((c) => c.path)).toEqual(['bases/widget/alpha.md']);
    expect(plan.shardOnly.map((c) => c.path)).toEqual(['bases/widget/beta.md']);
    expect(plan.matches[0]?.iteratorKey).toBe('widget');
    expect(plan.shardOnly[0]?.iteratorKey).toBe('widget');
  });

  it('case 14: differing binary file → flagged isBinary=true', async () => {
    const shardBin = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]);
    const userBin = Buffer.from([0x00, 0x05, 0x06, 0x07, 0x08]);
    await makeShardSource(harness.tempShard);
    await fsp.writeFile(path.join(harness.tempShard, 'icon.bin'), shardBin);
    await fsp.writeFile(path.join(harness.vault, 'icon.bin'), userBin);

    const plan = await classifyAdoption({
      vaultRoot: harness.vault,
      schema: emptySchema(),
      manifest: manifest(),
      tempDir: harness.tempShard,
      values: {},
      selections: {},
      now: FIXED_DATE,
    });

    expect(plan.differs).toHaveLength(1);
    const d = plan.differs[0]!;
    if (d.kind !== 'differs') throw new Error('expected differs');
    expect(d.isBinary).toBe(true);
  });

  it('records iterator_key only on iterator-derived outputs (not on plain renders)', async () => {
    await makeShardSource(harness.tempShard, {
      'plain.md.njk': 'one\n',
      'bases/x/_each.md.njk': '# {{ item.slug }}\n',
    });
    await fsp.writeFile(path.join(harness.vault, 'plain.md'), 'one\n', 'utf-8');

    const plan = await classifyAdoption({
      vaultRoot: harness.vault,
      schema: emptySchema({
        values: {
          x: { type: 'list', message: '', default: '[]', group: 'setup' },
        },
      }),
      manifest: manifest(),
      tempDir: harness.tempShard,
      values: { x: [{ slug: 'a' }] },
      selections: {},
      now: FIXED_DATE,
    });

    const plain = plan.matches.find((c) => c.path === 'plain.md');
    expect(plain).toBeDefined();
    expect(plain!.iteratorKey).toBeUndefined();

    const iter = plan.shardOnly.find((c) => c.path === 'bases/x/a.md');
    expect(iter).toBeDefined();
    expect(iter!.iteratorKey).toBe('x');
  });

  it('records POSIX-shape templateKey relative to the shard tempdir', async () => {
    await makeShardSource(harness.tempShard, { 'sub/dir/file.md': 'body\n' });
    await fsp.writeFile(
      path.join(harness.vault, 'sub', 'dir', 'file.md'),
      'body\n',
      'utf-8',
    ).catch(async () => {
      await fsp.mkdir(path.join(harness.vault, 'sub', 'dir'), { recursive: true });
      await fsp.writeFile(path.join(harness.vault, 'sub', 'dir', 'file.md'), 'body\n', 'utf-8');
    });

    const plan = await classifyAdoption({
      vaultRoot: harness.vault,
      schema: emptySchema(),
      manifest: manifest(),
      tempDir: harness.tempShard,
      values: {},
      selections: {},
      now: FIXED_DATE,
    });

    expect(plan.matches[0]?.templateKey).toBe('sub/dir/file.md');
  });

  it('rejects symlinks in the shard source (delegates to the walk)', async () => {
    await makeShardSource(harness.tempShard, { 'real.md': 'real\n' });
    await fsp.symlink('real.md', path.join(harness.tempShard, 'link.md'));

    await expect(
      classifyAdoption({
        vaultRoot: harness.vault,
        schema: emptySchema(),
        manifest: manifest(),
        tempDir: harness.tempShard,
        values: {},
        selections: {},
        now: FIXED_DATE,
      }),
    ).rejects.toMatchObject({ code: 'WALK_SYMLINK_REJECTED' });
  });

  it('surfaces non-ENOENT read errors via COLLISION_CHECK_FAILED', async () => {
    if (process.platform === 'win32') return; // chmod-based denial doesn't apply on Windows.
    await makeShardSource(harness.tempShard, { 'secret.md': 'shard secret\n' });
    const userPath = path.join(harness.vault, 'secret.md');
    await fsp.writeFile(userPath, 'user secret\n', 'utf-8');
    await fsp.chmod(userPath, 0o000);

    try {
      await expect(
        classifyAdoption({
          vaultRoot: harness.vault,
          schema: emptySchema(),
          manifest: manifest(),
          tempDir: harness.tempShard,
          values: {},
          selections: {},
          now: FIXED_DATE,
        }),
      ).rejects.toMatchObject({ code: 'COLLISION_CHECK_FAILED' });
    } finally {
      await fsp.chmod(userPath, 0o600).catch(() => {});
    }
  });
});

// ---------------------------------------------------------------------------
// Property tests — fast-check for the real classification invariants.
// ---------------------------------------------------------------------------

describe('classifyAdoption property tests', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await makeHarness('property');
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  // Generators
  // - 1-32 ASCII filenames + a non-trivial body. Path collisions in the same
  //   shard are uninteresting (real shards don't have them), so we use Set
  //   semantics on filename to dedup.
  const fileGen = fc.tuple(
    fc.stringMatching(/^[a-z][a-z0-9_-]{0,16}\.md$/),
    fc.stringMatching(/^[a-zA-Z0-9 \n.]{1,128}$/),
  );
  const filesGen = fc
    .uniqueArray(fileGen, {
      minLength: 1,
      maxLength: 8,
      selector: ([name]) => name,
    });

  it('property: arbitrary subset of shard files copied byte-equivalent → all classified `matches`', async () => {
    await fc.assert(
      fc.asyncProperty(
        filesGen,
        fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }),
        async (files, includeFlags) => {
          // Re-shape: mark each file matched/missing in the user vault.
          // Truncate includeFlags to len(files).
          const flags = files.map((_, i) => includeFlags[i % includeFlags.length] ?? false);

          // Fresh harness per iteration — shard tempdir + vault both isolated.
          const tempShard = path.join(os.tmpdir(), `shardmind-adopt-prop-shard-${crypto.randomUUID()}`);
          const vault = path.join(os.tmpdir(), `shardmind-adopt-prop-vault-${crypto.randomUUID()}`);
          await fsp.mkdir(vault, { recursive: true });
          try {
            const fileMap = Object.fromEntries(files);
            await makeShardSource(tempShard, fileMap);
            // Copy a subset of shard files into the user vault byte-for-byte.
            for (let i = 0; i < files.length; i++) {
              if (!flags[i]) continue;
              const [name, body] = files[i]!;
              await fsp.writeFile(path.join(vault, name), body, 'utf-8');
            }

            const plan = await classifyAdoption({
              vaultRoot: vault,
              schema: emptySchema(),
              manifest: manifest(),
              tempDir: tempShard,
              values: {},
              selections: {},
              now: FIXED_DATE,
            });

            // Invariant: every flagged file lands in `matches`; every
            // unflagged file in `shardOnly`. Differs is empty for all.
            expect(plan.differs).toEqual([]);
            const matchedNames = plan.matches.map((c) => c.path).sort();
            const expectedMatched = files
              .filter((_, i) => flags[i])
              .map(([n]) => n)
              .sort();
            expect(matchedNames).toEqual(expectedMatched);
            const onlyNames = plan.shardOnly.map((c) => c.path).sort();
            const expectedOnly = files
              .filter((_, i) => !flags[i])
              .map(([n]) => n)
              .sort();
            expect(onlyNames).toEqual(expectedOnly);
          } finally {
            await fsp.rm(tempShard, { recursive: true, force: true });
            await fsp.rm(vault, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 25, timeout: 45_000 },
    );
  }, 60_000);

  it('property: any non-trivial mutation moves a file from `matches` to `differs`', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(/^[a-z][a-z0-9_-]{0,16}\.md$/),
        fc.stringMatching(/^[a-zA-Z0-9 \n.]{8,128}$/),
        fc.stringMatching(/^[a-zA-Z0-9!]{1,8}$/),
        async (filename, baseBody, mutationSuffix) => {
          const tempShard = path.join(os.tmpdir(), `shardmind-adopt-prop2-shard-${crypto.randomUUID()}`);
          const vault = path.join(os.tmpdir(), `shardmind-adopt-prop2-vault-${crypto.randomUUID()}`);
          await fsp.mkdir(vault, { recursive: true });
          try {
            await makeShardSource(tempShard, { [filename]: baseBody });
            const userBody = baseBody + mutationSuffix;
            await fsp.writeFile(path.join(vault, filename), userBody, 'utf-8');

            const plan = await classifyAdoption({
              vaultRoot: vault,
              schema: emptySchema(),
              manifest: manifest(),
              tempDir: tempShard,
              values: {},
              selections: {},
              now: FIXED_DATE,
            });

            // Invariant: mutation always lands in `differs`, never in
            // `matches` or `shardOnly`.
            expect(plan.matches).toEqual([]);
            expect(plan.shardOnly).toEqual([]);
            expect(plan.differs.map((c) => c.path)).toEqual([filename]);
          } finally {
            await fsp.rm(tempShard, { recursive: true, force: true });
            await fsp.rm(vault, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 25, timeout: 45_000 },
    );
  }, 60_000);
});
