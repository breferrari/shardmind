/**
 * Layer 2: Open in editor hands the real terminal over and takes it back
 * (#50). Only a PTY shows this: under ink-testing-library there is no tty
 * mode to release.
 *
 * Three conflicts. The first is opened in a fake editor (a node script) that
 * records `stty -a` from the terminal it was given: canonical mode and echo
 * must be on, so raw mode was really left (Ink's own setter counts its users
 * and would not have left it). On the second, a lone ARROW_DOWN must move the
 * highlight before any ENTER: in canonical mode the arrow would wait for a
 * newline, so raw mode is really back. The third is kept as mine.
 *
 * Runs under Windows ConPTY too (#174): it ends there since the handoff
 * stops the stdin read, not only raw mode (#282).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { createGitHubStub, type GitHubStub } from '../helpers/github-stub.js';
import { ensureBuilt } from '../helpers/build-once.js';
import { createInstalledVault, type Vault } from '../helpers/vault.js';
import { spawnCliPty, ENTER, ARROW_DOWN, CTRL_C, PTY_VIEWPORT_ROWS } from './helpers/pty-cli.js';
import { noPty } from './helpers/pty-gates.js';
import { buildMutatedShard } from './helpers/build-fixture-shard.js';
import { tick } from '../../component/helpers.js';

const SLUG = 'acme/editor-handoff';
const REF = `github:${SLUG}`;
const DEFAULT_VALUES = { user_name: 'Alice', org_name: 'Acme Labs', vault_purpose: 'engineering', qmd_enabled: true };

let stub: GitHubStub;

/** As in update-conflicts.test.ts: only v0.2.0 appends, so each user edit at the bottom conflicts. */
async function buildConflictTarball(version: string, outDir: string, append: boolean): Promise<string> {
  return buildMutatedShard({
    version,
    name: 'editor-handoff',
    namespace: 'l2test',
    dropHooks: true,
    prefix: `editor-handoff-${version}`,
    outDir,
    mutate: async (workDir) => {
      if (!append) return;
      for (const [rel, line] of [
        ['Home.md.njk', 'v0.2.0 home append'],
        ['brain/North Star.md.njk', 'v0.2.0 north star append'],
        ['.claude/settings.json.njk', '"v0.2.0-settings": true'],
      ] as const) {
        const abs = path.join(workDir, rel);
        await fs.writeFile(abs, `${await fs.readFile(abs, 'utf-8')}\n${line}\n`, 'utf-8');
      }
    },
  });
}

describe.skipIf(noPty())('update — Open in editor under a real terminal (#50)', () => {
  beforeAll(async () => {
    await ensureBuilt();
    stub = await createGitHubStub({ shards: { [SLUG]: { versions: {} as Record<string, string>, latest: '0.1.0' } } });
  }, 90_000);

  afterAll(async () => {
    await stub?.close();
  });

  it('leaves raw mode for the editor and takes it back for the next prompt', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'l2-editor-'));
    let vault: Vault | null = null;
    let edited: string | undefined;
    try {
      const sttyOut = path.join(tmpDir, 'stty.txt');
      const editor = path.join(tmpDir, 'editor.cjs');
      await fs.writeFile(
        editor,
        [
          "const fs = require('node:fs');",
          "const { execSync } = require('node:child_process');",
          'const file = process.argv[process.argv.length - 1];',
          "fs.writeFileSync(process.env.L2_STTY_OUT, execSync('stty -a', { stdio: ['inherit', 'pipe', 'ignore'] }).toString());",
          "fs.writeFileSync(file, 'Hand-merged in a real terminal.\\n');",
          '',
        ].join('\n'),
      );

      stub.setVersion(SLUG, '0.1.0', await buildConflictTarball('0.1.0', tmpDir, false));
      stub.setLatest(SLUG, '0.1.0');
      vault = await createInstalledVault({ stub, shardRef: REF, values: DEFAULT_VALUES, prefix: 'l2-editor' });
      for (const rel of ['Home.md', 'brain/North Star.md', '.claude/settings.json']) {
        await vault.writeFile(rel, `${await vault.readFile(rel)}\nUser bottom edit.\n`);
      }
      stub.setVersion(SLUG, '0.2.0', await buildConflictTarball('0.2.0', tmpDir, true));
      stub.setLatest(SLUG, '0.2.0');

      const handle = await spawnCliPty(['update'], {
        timeoutMs: 60_000,
        cwd: vault.root,
        env: { SHARDMIND_GITHUB_API_BASE: stub.url, VISUAL: `node "${editor}"`, EDITOR: '', L2_STTY_OUT: sttyOut },
        rows: PTY_VIEWPORT_ROWS,
      });
      try {
        // 1 of 3: Open in editor is the fourth option. Which file comes first
        // follows the filesystem's directory order, so read it off the screen.
        const first = await handle.waitForScreen((s) => /\(1 of 3\)/.test(s) && /Open in editor/.test(s), {
          timeoutMs: 30_000,
          description: 'first conflict with Open in editor',
        });
        edited = /Conflict in (.+?) \(1 of 3\)/.exec(first)?.[1];
        for (let i = 0; i < 3; i++) {
          handle.write(ARROW_DOWN);
          await tick(80);
        }
        handle.write(ENTER);

        // 2 of 3: a lone arrow moves the highlight, so raw mode is back.
        await handle.waitForScreen((s) => /\(2 of 3\)/.test(s), { timeoutMs: 30_000, description: 'second conflict' });
        await tick(200);
        handle.write(ARROW_DOWN);
        await handle.waitForScreen((s) => /❯\s*Keep mine/.test(s), {
          timeoutMs: 10_000,
          description: 'highlight on Keep mine before any ENTER',
        });
        handle.write(ENTER);

        await handle.waitForScreen((s) => /\(3 of 3\)/.test(s), { timeoutMs: 30_000, description: 'third conflict' });
        handle.write(ARROW_DOWN);
        await tick(80);
        handle.write(ENTER);

        const done = await handle.waitForScreen((s) => /Updated 0\.1\.0 → 0\.2\.0/.test(s), {
          timeoutMs: 60_000,
          description: 'final updated frame',
        });
        expect(done.replace(/\s+/g, ' ')).toContain('1 edited in your editor');
        expect((await handle.waitForExit()).exitCode).toBe(0);
      } finally {
        await handle.dispose();
      }

      // The editor had a cooked terminal: canonical mode and echo on.
      const stty = await fs.readFile(sttyOut, 'utf-8');
      expect(stty).toMatch(/(^|\s)icanon(\s|$)/);
      expect(stty).toMatch(/(^|\s)echo(\s|$)/);
      expect(edited).toBeDefined();
      expect(await vault.readFile(edited!)).toBe('Hand-merged in a real terminal.\n');
    } finally {
      if (vault) await vault.cleanup();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }, 180_000);

  it('a Ctrl+C while the editor has the terminal cancels the edit, not the update', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'l2-editor-int-'));
    let vault: Vault | null = null;
    try {
      // Waits for the user, as an editor does; dies on Ctrl+C like most.
      const editor = path.join(tmpDir, 'editor.cjs');
      await fs.writeFile(editor, "setTimeout(() => {}, 60000);\n");

      stub.setVersion(SLUG, '0.1.0', await buildConflictTarball('0.1.0', tmpDir, false));
      stub.setLatest(SLUG, '0.1.0');
      vault = await createInstalledVault({ stub, shardRef: REF, values: DEFAULT_VALUES, prefix: 'l2-editor-int' });
      for (const rel of ['Home.md', 'brain/North Star.md', '.claude/settings.json']) {
        await vault.writeFile(rel, `${await vault.readFile(rel)}\nUser bottom edit.\n`);
      }
      stub.setVersion(SLUG, '0.2.0', await buildConflictTarball('0.2.0', tmpDir, true));
      stub.setLatest(SLUG, '0.2.0');

      const handle = await spawnCliPty(['update'], {
        timeoutMs: 60_000,
        cwd: vault.root,
        env: { SHARDMIND_GITHUB_API_BASE: stub.url, VISUAL: `node "${editor}"`, EDITOR: '' },
        rows: PTY_VIEWPORT_ROWS,
      });
      try {
        await handle.waitForScreen((s) => /\(1 of 3\)/.test(s) && /Open in editor/.test(s), {
          timeoutMs: 30_000,
          description: 'first conflict with Open in editor',
        });
        for (let i = 0; i < 3; i++) {
          handle.write(ARROW_DOWN);
          await tick(80);
        }
        handle.write(ENTER);
        // The editor is running with the terminal cooked: Ctrl+C is a signal
        // to the whole foreground group, shardmind included.
        await tick(1500);
        handle.write(CTRL_C);
        await handle.waitForScreen((s) => /\(1 of 3\)/.test(s) && /choose again/.test(s.replace(/\s+/g, ' ')), {
          timeoutMs: 30_000,
          description: 'back at the first conflict with a note',
        });
        // The update is still alive: finish it with Keep mine on each file.
        for (let i = 1; i <= 3; i++) {
          await handle.waitForScreen((s) => new RegExp(`\\(${i} of 3\\)`).test(s), {
            timeoutMs: 30_000,
            description: `conflict (${i} of 3)`,
          });
          handle.write(ARROW_DOWN);
          await tick(80);
          handle.write(ENTER);
          await tick(150);
        }
        await handle.waitForScreen((s) => /Updated 0\.1\.0 → 0\.2\.0/.test(s), {
          timeoutMs: 60_000,
          description: 'final updated frame',
        });
        expect((await handle.waitForExit()).exitCode).toBe(0);
      } finally {
        await handle.dispose();
      }
    } finally {
      if (vault) await vault.cleanup();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }, 180_000);
});
