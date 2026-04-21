/**
 * Hook lookup + execution tests.
 *
 * The lookup surface is security-sensitive regardless of when hooks
 * execute: a shard manifest with `hooks.post-update: "../.."` must not
 * be able to probe arbitrary filesystem paths via existence detection.
 * The first `describe` block locks the sandbox invariant — the resolved
 * hook path is always inside the shard's temp directory.
 *
 * The `executeHook` block covers the full subprocess-backed runtime:
 * success / non-zero / throw / syntax / timeout / abort / stream caps /
 * stderr-stdout separation / env passthrough / ctx round-trip /
 * tempfile cleanup. Each test writes a self-contained hook to a scratch
 * dir, spawns it, and asserts the result.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  runPostInstallHook,
  runPostUpdateHook,
  executeHook,
} from '../../source/core/hook.js';
import type { HookContext, ShardManifest } from '../../source/runtime/types.js';

function makeManifest(hooks: ShardManifest['hooks']): ShardManifest {
  return {
    apiVersion: 'v1',
    name: 'test',
    namespace: 'ns',
    version: '1.0.0',
    dependencies: [],
    hooks,
  };
}

describe('lookupHook — path traversal guards', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hook-test-'));
    // Stage a legit hook + a sibling file outside the shard.
    await fsp.mkdir(path.join(tempDir, 'hooks'), { recursive: true });
    await fsp.writeFile(path.join(tempDir, 'hooks', 'post-install.ts'), '// hook\n');
    await fsp.writeFile(path.join(tempDir, 'hooks', 'post-update.ts'), '// hook\n');
  });

  afterEach(async () => {
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('resolves a legitimate relative hook path to "deferred" when no ctx given', async () => {
    const manifest = makeManifest({ 'post-install': 'hooks/post-install.ts' });
    const result = await runPostInstallHook(tempDir, manifest);
    expect(result.kind).toBe('deferred');
    if (result.kind !== 'deferred') throw new Error('narrowing');
    expect(result.hookPath).toContain('hooks');
  });

  it('refuses a parent-directory traversal (../../etc/shadow)', async () => {
    const manifest = makeManifest({ 'post-update': '../../../../etc/shadow' });
    const result = await runPostUpdateHook(tempDir, manifest);
    expect(result.kind).toBe('absent');
  });

  it('refuses an absolute path (Unix)', async () => {
    const manifest = makeManifest({ 'post-update': '/etc/shadow' });
    const result = await runPostUpdateHook(tempDir, manifest);
    expect(result.kind).toBe('absent');
  });

  it('refuses a path containing ".." segments in the middle', async () => {
    // `hooks/../../etc/shadow` would escape via the middle `..`. The
    // normalize-based guard catches this class.
    const manifest = makeManifest({ 'post-update': 'hooks/../../etc/shadow' });
    const result = await runPostUpdateHook(tempDir, manifest);
    expect(result.kind).toBe('absent');
  });

  it('returns absent when the hook file does not exist under the shard', async () => {
    const manifest = makeManifest({ 'post-install': 'hooks/does-not-exist.ts' });
    const result = await runPostInstallHook(tempDir, manifest);
    expect(result.kind).toBe('absent');
  });

  it('returns absent when no hook is declared', async () => {
    const manifest = makeManifest({});
    const result = await runPostInstallHook(tempDir, manifest);
    expect(result.kind).toBe('absent');
  });
});

/**
 * The execution tests span several seconds each (spawn + tsx cold start
 * runs ~400-800 ms on modern hardware; Windows CI is slower). They're
 * the only path that validates the real subprocess + stream capture.
 */
describe('executeHook — subprocess runtime', () => {
  let scratchDir: string;
  let vaultDir: string;

  const baseCtx = (): HookContext => ({
    vaultRoot: vaultDir,
    values: { user_name: 'alice', vault_purpose: 'engineering' },
    modules: { core: 'included', perf: 'excluded' },
    shard: { name: 'test-shard', version: '1.0.0' },
  });

  beforeEach(async () => {
    scratchDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hook-exec-'));
    vaultDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hook-vault-'));
  });

  afterEach(async () => {
    // Windows: a child process that was SIGTERM'd mid-hook may still hold
    // a handle on `cwd: vaultDir` for a few milliseconds after the parent's
    // promise resolves. `{ maxRetries, retryDelay }` tolerates that window
    // instead of flaking the test with EBUSY.
    const rmOpts = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };
    await fsp.rm(scratchDir, rmOpts);
    await fsp.rm(vaultDir, rmOpts);
  });

  async function writeHook(name: string, source: string): Promise<string> {
    const file = path.join(scratchDir, name);
    await fsp.writeFile(file, source, 'utf-8');
    return file;
  }

  it('runs a hook that writes a file in vaultRoot', async () => {
    const hookPath = await writeHook(
      'hook.ts',
      `
        import { writeFile } from 'node:fs/promises';
        import { join } from 'node:path';
        export default async function (ctx) {
          await writeFile(join(ctx.vaultRoot, 'marker.txt'), 'ok');
          console.log('hello');
        }
      `,
    );
    const result = await executeHook(hookPath, baseCtx());
    expect(result.kind).toBe('ran');
    if (result.kind !== 'ran') throw new Error('narrowing');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hello');
    expect(result.stderr).toBe('');
    const marker = await fsp.readFile(path.join(vaultDir, 'marker.txt'), 'utf-8');
    expect(marker).toBe('ok');
  }, 30_000);

  it('separates stdout and stderr into distinct captured buffers', async () => {
    const hookPath = await writeHook(
      'hook.ts',
      `
        export default async function () {
          process.stdout.write('on stdout\\n');
          process.stderr.write('on stderr\\n');
        }
      `,
    );
    const result = await executeHook(hookPath, baseCtx());
    if (result.kind !== 'ran') throw new Error(`expected ran, got ${result.kind}`);
    expect(result.stdout).toContain('on stdout');
    expect(result.stdout).not.toContain('on stderr');
    expect(result.stderr).toContain('on stderr');
    expect(result.stderr).not.toContain('on stdout');
  }, 30_000);

  it('surfaces non-zero process.exit() as ran + exitCode', async () => {
    const hookPath = await writeHook(
      'hook.ts',
      `
        export default async function () {
          console.log('before exit');
          process.exit(2);
        }
      `,
    );
    const result = await executeHook(hookPath, baseCtx());
    if (result.kind !== 'ran') throw new Error(`expected ran, got ${result.kind}`);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain('before exit');
  }, 30_000);

  it('surfaces a thrown default export as ran + exitCode 1 + stack in stderr', async () => {
    const hookPath = await writeHook(
      'hook.ts',
      `
        export default async function () {
          console.log('before throw');
          throw new Error('boom');
        }
      `,
    );
    const result = await executeHook(hookPath, baseCtx());
    if (result.kind !== 'ran') throw new Error(`expected ran, got ${result.kind}`);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('before throw');
    // The runner wraps the thrown error and writes stack + message to
    // stderr. We don't pin the exact stack (tsx line numbers vary) but
    // the message must be there for the author to fix.
    expect(result.stderr).toContain('boom');
  }, 30_000);

  it('surfaces a syntax-error hook as ran + exitCode 1 with the parse error captured', async () => {
    const hookPath = await writeHook(
      'hook.ts',
      `export default async function () { this is not valid typescript`,
    );
    const result = await executeHook(hookPath, baseCtx());
    if (result.kind !== 'ran') throw new Error(`expected ran, got ${result.kind}`);
    expect(result.exitCode).toBe(1);
    // Either tsx's parser or node's parser emits the error — in either
    // case something recognizable must reach stderr so the author can fix.
    expect(result.stderr.length).toBeGreaterThan(0);
  }, 30_000);

  it('returns failed when the hook file vanishes between lookup and execute', async () => {
    const hookPath = path.join(scratchDir, 'does-not-exist.ts');
    const result = await executeHook(hookPath, baseCtx());
    // The runner's dynamic `import()` fails at the OS resolution layer; it
    // manifests as `ran` with exitCode 1 (the runner caught the error and
    // exited cleanly with the error on stderr). Either `ran` with non-zero
    // exit OR `failed` is acceptable — both signal "hook did not complete
    // successfully" to the caller.
    expect(['ran', 'failed']).toContain(result.kind);
    if (result.kind === 'ran') expect(result.exitCode).not.toBe(0);
  }, 30_000);

  it('round-trips HookContext fields through the subprocess', async () => {
    const echoed = path.join(vaultDir, 'echoed.json');
    const hookPath = await writeHook(
      'hook.ts',
      `
        import { writeFile } from 'node:fs/promises';
        export default async function (ctx) {
          await writeFile(${JSON.stringify(echoed)}, JSON.stringify(ctx));
        }
      `,
    );
    const ctx: HookContext = {
      ...baseCtx(),
      previousVersion: '0.9.0',
    };
    const result = await executeHook(hookPath, ctx);
    expect(result.kind).toBe('ran');
    const parsed = JSON.parse(await fsp.readFile(echoed, 'utf-8'));
    expect(parsed).toStrictEqual(ctx);
  }, 30_000);

  it('tags the child env with SHARDMIND_HOOK=1 and the stage-specific phase', async () => {
    const hookPath = await writeHook(
      'hook.ts',
      `
        export default async function () {
          console.log(JSON.stringify({
            hook: process.env.SHARDMIND_HOOK,
            phase: process.env.SHARDMIND_HOOK_PHASE,
          }));
        }
      `,
    );
    // previousVersion absent ⇒ post-install phase
    const installResult = await executeHook(hookPath, baseCtx());
    if (installResult.kind !== 'ran') throw new Error('expected ran');
    const installEnv = JSON.parse(installResult.stdout.trim());
    expect(installEnv).toStrictEqual({ hook: '1', phase: 'post-install' });

    // previousVersion present ⇒ post-update phase
    const updateResult = await executeHook(hookPath, { ...baseCtx(), previousVersion: '0.9.0' });
    if (updateResult.kind !== 'ran') throw new Error('expected ran');
    const updateEnv = JSON.parse(updateResult.stdout.trim());
    expect(updateEnv).toStrictEqual({ hook: '1', phase: 'post-update' });
  }, 30_000);

  it('enforces the timeoutMs budget with a "timed out" failure', async () => {
    // `new Promise(resolve => setTimeout(resolve, 10000))` keeps the event
    // loop alive so node doesn't exit early when the microtask queue drains.
    // A plain `new Promise(() => {})` would resolve to `exitCode 0` via
    // empty-loop detection before the timer fires.
    const hookPath = await writeHook(
      'hook.ts',
      `
        export default async function () {
          await new Promise(resolve => setTimeout(resolve, 10000));
        }
      `,
    );
    const start = Date.now();
    const result = await executeHook(hookPath, baseCtx(), { timeoutMs: 500 });
    const elapsed = Date.now() - start;
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') throw new Error('narrowing');
    expect(result.message).toMatch(/timed out after 0\.5s/);
    // Timeout plus up to 2s SIGKILL grace + CI variance. Allow a generous
    // upper bound; the important assertion is that we didn't wait ~10s.
    expect(elapsed).toBeLessThan(5_000);
  }, 15_000);

  it('treats an AbortSignal abort as failed / cancelled', async () => {
    const hookPath = await writeHook(
      'hook.ts',
      `
        export default async function () {
          await new Promise(resolve => setTimeout(resolve, 10000));
        }
      `,
    );
    const ac = new AbortController();
    // 1500 ms so that under full-suite concurrent-subprocess contention
    // on a loaded Windows CI runner, the child reliably finishes tsx
    // startup (cold ~400-800 ms) before the abort fires. A tighter budget
    // races with the child "error" event node emits on auto-kill and can
    // surface a `ran` result with no stdout/stderr captured yet.
    setTimeout(() => ac.abort(), 1_500);
    const result = await executeHook(hookPath, baseCtx(), {
      timeoutMs: 30_000,
      signal: ac.signal,
    });
    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') throw new Error('narrowing');
    expect(result.message).toBe('cancelled');
  }, 15_000);

  it('caps stdout at 256 KB and appends a truncation marker', async () => {
    const hookPath = await writeHook(
      'hook.ts',
      `
        export default async function () {
          // Write ~400 KB — well beyond the 256 KB cap.
          const chunk = 'x'.repeat(64 * 1024);
          for (let i = 0; i < 7; i++) process.stdout.write(chunk);
        }
      `,
    );
    const result = await executeHook(hookPath, baseCtx());
    if (result.kind !== 'ran') throw new Error('expected ran');
    // 256 KB = 262144 bytes. The marker adds a handful more — assert a
    // loose upper bound that includes the marker's overhead but still
    // catches an uncapped leak.
    expect(Buffer.byteLength(result.stdout)).toBeLessThan(263_000);
    expect(result.stdout).toContain('[… stdout truncated');
    expect(result.stdout).toContain('bytes discarded]');
  }, 30_000);

  it('caps stdout and stderr independently', async () => {
    const hookPath = await writeHook(
      'hook.ts',
      `
        export default async function () {
          const chunk = 'x'.repeat(64 * 1024);
          for (let i = 0; i < 5; i++) process.stdout.write(chunk);
          const echunk = 'E'.repeat(64 * 1024);
          for (let i = 0; i < 5; i++) process.stderr.write(echunk);
        }
      `,
    );
    const result = await executeHook(hookPath, baseCtx());
    if (result.kind !== 'ran') throw new Error('expected ran');
    // Both streams wrote 320 KB (over the 256 KB cap). Each capped
    // independently — neither should be empty, and both should contain
    // the truncation marker.
    expect(Buffer.byteLength(result.stdout)).toBeLessThan(263_000);
    expect(Buffer.byteLength(result.stderr)).toBeLessThan(263_000);
    expect(result.stdout).toContain('[… stdout truncated');
    expect(result.stderr).toContain('[… stderr truncated');
  }, 30_000);

  it('forwards chunks live through onStdout and onStderr callbacks', async () => {
    const hookPath = await writeHook(
      'hook.ts',
      `
        export default async function () {
          process.stdout.write('one\\n');
          await new Promise(r => setTimeout(r, 50));
          process.stderr.write('two\\n');
          await new Promise(r => setTimeout(r, 50));
          process.stdout.write('three\\n');
        }
      `,
    );
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const result = await executeHook(hookPath, baseCtx(), {
      onStdout: (c) => stdoutChunks.push(c),
      onStderr: (c) => stderrChunks.push(c),
    });
    if (result.kind !== 'ran') throw new Error('expected ran');
    // The live callbacks fire per-chunk; we should see both streams'
    // content present across the collected chunks.
    expect(stdoutChunks.join('')).toContain('one');
    expect(stdoutChunks.join('')).toContain('three');
    expect(stderrChunks.join('')).toContain('two');
  }, 30_000);

  it('unlinks the ctx tempfile after a successful run', async () => {
    const hookPath = await writeHook(
      'hook.ts',
      `export default async function () { /* no-op */ }`,
    );
    // Redirect `os.tmpdir()` into a scratch directory we own so the scan
    // below can't collide with concurrent tests in the same vitest run
    // that may have their own ctx files in flight. `os.tmpdir()` reads
    // `TMPDIR` on POSIX and `TEMP`/`TMP` on Windows; we overwrite all
    // three, run the hook, then restore.
    const scopedTmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'hook-cleanup-scope-'));
    const saved = {
      TMPDIR: process.env.TMPDIR,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
    };
    process.env.TMPDIR = scopedTmp;
    process.env.TEMP = scopedTmp;
    process.env.TMP = scopedTmp;
    try {
      const result = await executeHook(hookPath, baseCtx());
      expect(result.kind).toBe('ran');
      const remaining = (await fsp.readdir(scopedTmp)).filter((e) =>
        /^shardmind-hook-[0-9a-f]+\.json$/.test(e),
      );
      expect(remaining).toEqual([]);
    } finally {
      // Restore env (undefined if it was unset originally — delete vs assign).
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      await fsp.rm(scopedTmp, { recursive: true, force: true });
    }
  }, 30_000);
});
