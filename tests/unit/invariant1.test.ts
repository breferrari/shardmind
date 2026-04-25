/**
 * Unit coverage for `verifyInvariant1` — the helper that operationalizes
 * `docs/SHARD-LAYOUT.md §Installation invariants` for the CI E2E gate.
 *
 * Each test builds a clone + install pair on disk and asserts the helper
 * detects exactly the divergence under test (clone-only, install-only,
 * static byte mismatch, Tier 1 leak, `.shardmindignore` leak, `.njk`
 * mapping, engine metadata exclusion). A property test with fast-check
 * pins the helper's mutation-detection invariant: any single byte
 * change to a static file must surface as `staticByteMismatches`.
 */

import { describe, it, expect, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as fc from 'fast-check';

import { verifyInvariant1 } from '../e2e/helpers/invariant1.js';

interface Pair {
  cloneDir: string;
  installDir: string;
  cleanup: () => Promise<void>;
}

const liveDirs = new Set<string>();

async function makePair(prefix: string): Promise<Pair> {
  const cloneDir = await fsp.mkdtemp(path.join(os.tmpdir(), `shardmind-inv1-${prefix}-clone-`));
  const installDir = await fsp.mkdtemp(path.join(os.tmpdir(), `shardmind-inv1-${prefix}-install-`));
  liveDirs.add(cloneDir);
  liveDirs.add(installDir);
  return {
    cloneDir,
    installDir,
    cleanup: async () => {
      liveDirs.delete(cloneDir);
      liveDirs.delete(installDir);
      await Promise.all([
        fsp.rm(cloneDir, { recursive: true, force: true }),
        fsp.rm(installDir, { recursive: true, force: true }),
      ]);
    },
  };
}

async function writeFile(root: string, rel: string, content: string | Buffer): Promise<void> {
  const abs = path.join(root, rel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content);
}

afterEach(async () => {
  for (const dir of [...liveDirs]) {
    liveDirs.delete(dir);
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe('verifyInvariant1 — happy path', () => {
  it('returns a clean report when every static file matches and every .njk maps cleanly', async () => {
    const pair = await makePair('happy');
    try {
      // Clone has: 2 static files + 1 .njk template + the .shardmindignore itself.
      await writeFile(pair.cloneDir, 'README.md', '# Static\n');
      await writeFile(pair.cloneDir, 'CLAUDE.md', '# Agent config\n');
      await writeFile(pair.cloneDir, 'Home.md.njk', '# Home {{ user_name }}\n');
      await writeFile(pair.cloneDir, '.shardmindignore', '*.gif\n');

      // Install: the same 3 paths after .njk-stripping + engine metadata.
      await writeFile(pair.installDir, 'README.md', '# Static\n');
      await writeFile(pair.installDir, 'CLAUDE.md', '# Agent config\n');
      await writeFile(pair.installDir, 'Home.md', '# Home Independent\n'); // rendered, bytes differ — that's fine.
      await writeFile(pair.installDir, '.shardmindignore', '*.gif\n');
      await writeFile(pair.installDir, '.shardmind/state.json', '{}');
      await writeFile(pair.installDir, '.shardmind/shard.yaml', 'name: x\n');
      await writeFile(pair.installDir, '.shardmind/templates/Home.md.njk', '...');
      await writeFile(pair.installDir, 'shard-values.yaml', 'user_name: Independent\n');

      const report = await verifyInvariant1(pair);
      expect(report.staticByteMismatches).toEqual([]);
      expect(report.missingFromInstall).toEqual([]);
      expect(report.extrasInInstall).toEqual([]);
      // 4 clone paths matched: 3 statics + 1 .njk-mapped.
      expect(report.matched).toBe(4);
    } finally {
      await pair.cleanup();
    }
  });
});

describe('verifyInvariant1 — divergence detection', () => {
  it('reports static byte mismatch when install bytes disagree with clone bytes', async () => {
    const pair = await makePair('byte');
    try {
      await writeFile(pair.cloneDir, 'README.md', 'original\n');
      await writeFile(pair.installDir, 'README.md', 'corrupted\n');
      const report = await verifyInvariant1(pair);
      expect(report.staticByteMismatches).toEqual(['README.md']);
      expect(report.missingFromInstall).toEqual([]);
      expect(report.extrasInInstall).toEqual([]);
      expect(report.matched).toBe(0);
    } finally {
      await pair.cleanup();
    }
  });

  it('reports clone-side file with no install counterpart as missingFromInstall', async () => {
    const pair = await makePair('drop');
    try {
      await writeFile(pair.cloneDir, 'kept.md', 'kept\n');
      await writeFile(pair.cloneDir, 'dropped.md', 'dropped\n');
      await writeFile(pair.installDir, 'kept.md', 'kept\n');
      const report = await verifyInvariant1(pair);
      expect(report.missingFromInstall).toEqual(['dropped.md']);
      expect(report.staticByteMismatches).toEqual([]);
      expect(report.extrasInInstall).toEqual([]);
      expect(report.matched).toBe(1);
    } finally {
      await pair.cleanup();
    }
  });

  it('reports clone-side .njk with no stripped install counterpart as missingFromInstall', async () => {
    // The expected install path is the stripped form, so the missing-set
    // entry uses the stripped name (what the install lacks) — not the
    // .njk source name. The report is about install-side absence.
    const pair = await makePair('drop-njk');
    try {
      await writeFile(pair.cloneDir, 'Home.md.njk', '# {{ user_name }}\n');
      // install missing Home.md
      const report = await verifyInvariant1(pair);
      expect(report.missingFromInstall).toEqual(['Home.md']);
    } finally {
      await pair.cleanup();
    }
  });

  it('reports install-side file with no clone source as extrasInInstall', async () => {
    const pair = await makePair('extra');
    try {
      await writeFile(pair.cloneDir, 'shared.md', 'shared\n');
      await writeFile(pair.installDir, 'shared.md', 'shared\n');
      await writeFile(pair.installDir, 'extra.md', 'engine wrote this\n');
      const report = await verifyInvariant1(pair);
      expect(report.extrasInInstall).toEqual(['extra.md']);
      expect(report.matched).toBe(1);
    } finally {
      await pair.cleanup();
    }
  });

  it('flags a Tier 1 leak (`.git/HEAD` ended up in install) as extrasInInstall', async () => {
    // Tier 1 entries are stripped from the clone enumeration. If the
    // install has one anyway (engine bug), the install-side enumeration
    // includes it and the no-clone-source check fires.
    const pair = await makePair('tier1-leak');
    try {
      await writeFile(pair.cloneDir, '.git/HEAD', 'ref: refs/heads/main\n');
      await writeFile(pair.cloneDir, 'README.md', 'static\n');
      await writeFile(pair.installDir, 'README.md', 'static\n');
      await writeFile(pair.installDir, '.git/HEAD', 'ref: refs/heads/main\n');
      const report = await verifyInvariant1(pair);
      expect(report.extrasInInstall).toEqual(['.git/HEAD']);
      expect(report.staticByteMismatches).toEqual([]);
      expect(report.missingFromInstall).toEqual([]);
      expect(report.matched).toBe(1);
    } finally {
      await pair.cleanup();
    }
  });

  it('flags a `.shardmindignore`-excluded file leaking into install', async () => {
    // The clone's `.shardmindignore` excludes `*.gif` from clone
    // enumeration; an install-side `.gif` therefore has no clone source
    // and surfaces as an extra.
    const pair = await makePair('ignore-leak');
    try {
      await writeFile(pair.cloneDir, '.shardmindignore', '*.gif\n');
      await writeFile(pair.cloneDir, 'logo.gif', Buffer.from([0x47, 0x49, 0x46]));
      await writeFile(pair.cloneDir, 'README.md', 'docs\n');
      await writeFile(pair.installDir, '.shardmindignore', '*.gif\n');
      await writeFile(pair.installDir, 'README.md', 'docs\n');
      await writeFile(pair.installDir, 'logo.gif', Buffer.from([0x47, 0x49, 0x46]));
      const report = await verifyInvariant1(pair);
      expect(report.extrasInInstall).toEqual(['logo.gif']);
      expect(report.matched).toBe(2);
    } finally {
      await pair.cleanup();
    }
  });

  it('reports multiple divergences in a single pass (sorted, deterministic)', async () => {
    const pair = await makePair('multi');
    try {
      await writeFile(pair.cloneDir, 'a.md', 'A\n');
      await writeFile(pair.cloneDir, 'b.md', 'B\n');
      await writeFile(pair.cloneDir, 'c.md', 'C\n');
      await writeFile(pair.installDir, 'a.md', 'A\n');           // ok
      await writeFile(pair.installDir, 'b.md', 'corrupted\n');   // byte-mismatch
      // c.md missing
      await writeFile(pair.installDir, 'extra.md', 'extra\n');   // extra
      const report = await verifyInvariant1(pair);
      expect(report.staticByteMismatches).toEqual(['b.md']);
      expect(report.missingFromInstall).toEqual(['c.md']);
      expect(report.extrasInInstall).toEqual(['extra.md']);
      expect(report.matched).toBe(1);
    } finally {
      await pair.cleanup();
    }
  });
});

describe('verifyInvariant1 — engine-metadata + .njk semantics', () => {
  it('does not flag engine metadata under .shardmind/ or vault-root shard-values.yaml', async () => {
    // The install side legitimately carries every documented metadata path
    // (state.json, cached manifest+schema, templates cache, vault-root
    // values file). None of them appear on the clone side. The helper
    // must drop them silently, not surface as extras.
    const pair = await makePair('metadata');
    try {
      await writeFile(pair.cloneDir, 'README.md', '# clone\n');
      await writeFile(pair.installDir, 'README.md', '# clone\n');
      await writeFile(pair.installDir, '.shardmind/state.json', '{}');
      await writeFile(pair.installDir, '.shardmind/shard.yaml', 'name: x\n');
      await writeFile(pair.installDir, '.shardmind/shard-schema.yaml', 'schema_version: 1\n');
      await writeFile(pair.installDir, '.shardmind/templates/README.md', '# clone\n');
      await writeFile(pair.installDir, '.shardmind/templates/nested/file.md', 'x');
      await writeFile(pair.installDir, 'shard-values.yaml', 'user_name: Independent\n');
      const report = await verifyInvariant1(pair);
      expect(report.staticByteMismatches).toEqual([]);
      expect(report.missingFromInstall).toEqual([]);
      expect(report.extrasInInstall).toEqual([]);
      expect(report.matched).toBe(1);
    } finally {
      await pair.cleanup();
    }
  });

  it('round-trips `.shardmindignore` itself (clone has it, install has it; static byte equality)', async () => {
    // The .shardmindignore file is read by the engine, but it's not in
    // Tier 1 nor self-excluded by `*.gif`. It gets installed verbatim;
    // the helper must treat it as an ordinary static file.
    const pair = await makePair('ignore-self');
    try {
      const content = '# author note\n*.gif\n';
      await writeFile(pair.cloneDir, '.shardmindignore', content);
      await writeFile(pair.cloneDir, 'README.md', '# x\n');
      await writeFile(pair.installDir, '.shardmindignore', content);
      await writeFile(pair.installDir, 'README.md', '# x\n');
      const report = await verifyInvariant1(pair);
      expect(report.matched).toBe(2);
      expect(report.staticByteMismatches).toEqual([]);
    } finally {
      await pair.cleanup();
    }
  });

  it('allows .njk renders to differ from source bytes (path-presence only)', async () => {
    // The whole point of Invariant 1's `.njk` carve-out: a template
    // renders to legitimately different bytes via install_date and
    // value substitution. The helper must NOT byte-compare these.
    const pair = await makePair('njk-bytes-differ');
    try {
      await writeFile(
        pair.cloneDir,
        '.claude/settings.json.njk',
        '{"name": "{{ user_name }}", "ts": "{{ install_date }}"}\n',
      );
      await writeFile(
        pair.installDir,
        '.claude/settings.json',
        '{"name": "Independent", "ts": "2026-04-25"}\n',
      );
      const report = await verifyInvariant1(pair);
      expect(report.staticByteMismatches).toEqual([]);
      expect(report.missingFromInstall).toEqual([]);
      expect(report.extrasInInstall).toEqual([]);
      expect(report.matched).toBe(1);
    } finally {
      await pair.cleanup();
    }
  });

  it('respects nested directories in both .shardmindignore exclusion and recursive walk', async () => {
    // A subdirectory ignored by a glob (`docs/translations/`) must not
    // produce a clone enumeration entry; an install-side file under that
    // path therefore surfaces as an extra. Pins the recursive-walk
    // semantics — a regression that flattened the walk would silently
    // change which files Invariant 1 covers.
    const pair = await makePair('nested-ignore');
    try {
      await writeFile(
        pair.cloneDir,
        '.shardmindignore',
        'docs/translations/\nREADME.*.md\n',
      );
      await writeFile(pair.cloneDir, 'docs/translations/ja.md', 'ja\n');
      await writeFile(pair.cloneDir, 'README.ja.md', 'ja root\n');
      await writeFile(pair.cloneDir, 'README.md', '# main\n');
      await writeFile(pair.installDir, '.shardmindignore', 'docs/translations/\nREADME.*.md\n');
      await writeFile(pair.installDir, 'README.md', '# main\n');
      const report = await verifyInvariant1(pair);
      expect(report.matched).toBe(2);
      expect(report.staticByteMismatches).toEqual([]);
      expect(report.missingFromInstall).toEqual([]);
      expect(report.extrasInInstall).toEqual([]);
    } finally {
      await pair.cleanup();
    }
  });
});

describe('verifyInvariant1 — `.shardmindignore` parser delegation', () => {
  it('propagates SHARDMINDIGNORE_NEGATION_UNSUPPORTED when clone declares a `!pattern`', async () => {
    // The helper uses the same `loadShardmindignore` the engine uses;
    // negation rejection therefore fires from a single source of truth.
    // A regression that bypassed the parser (e.g. raw `ignore().add()`)
    // would silently accept negation here and diverge from the engine.
    const pair = await makePair('negation');
    try {
      await writeFile(pair.cloneDir, '.shardmindignore', '*.gif\n!keep.gif\n');
      await expect(verifyInvariant1(pair)).rejects.toThrow(
        /negation patterns/,
      );
    } finally {
      await pair.cleanup();
    }
  });
});

describe('verifyInvariant1 — fast-check property', () => {
  it('any single-byte mutation to a static file surfaces as staticByteMismatches', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9_-]{0,12}\.md$/), {
          minLength: 1,
          maxLength: 6,
        }),
        fc.stringMatching(/^[a-zA-Z0-9 \n.]{8,64}$/),
        fc.integer({ min: 0, max: 5 }),
        fc.stringMatching(/^[!@#$%^&*]{1,3}$/),
        async (filenames, baseBody, mutateIndex, suffix) => {
          const cloneDir = await fsp.mkdtemp(
            path.join(os.tmpdir(), `shardmind-inv1-prop-clone-${crypto.randomUUID()}`),
          );
          const installDir = await fsp.mkdtemp(
            path.join(os.tmpdir(), `shardmind-inv1-prop-install-${crypto.randomUUID()}`),
          );
          try {
            for (const name of filenames) {
              await writeFile(cloneDir, name, baseBody);
              await writeFile(installDir, name, baseBody);
            }
            // Mutate one install file.
            const idx = mutateIndex % filenames.length;
            const target = filenames[idx]!;
            await writeFile(installDir, target, baseBody + suffix);

            const report = await verifyInvariant1({ cloneDir, installDir });
            expect(report.staticByteMismatches).toContain(target);
            // Every other clone file should still match cleanly.
            expect(report.matched).toBe(filenames.length - 1);
            expect(report.missingFromInstall).toEqual([]);
            expect(report.extrasInInstall).toEqual([]);
          } finally {
            await fsp.rm(cloneDir, { recursive: true, force: true });
            await fsp.rm(installDir, { recursive: true, force: true });
          }
        },
      ),
      // Per-case 45s budget for macOS CI variance parity (PR #66 set the
      // pattern). Each property run does up to 6 file-pair writes plus the
      // helper's recursive walk + sha256 over both sides — well below the
      // ceiling, but the shared budget keeps future growth honest.
      { numRuns: 25, timeout: 45_000 },
    );
  }, 240_000);
});
