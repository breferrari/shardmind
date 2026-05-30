import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runHooks, bootstrapShouldRerun, type HookRunPlan, type HookRunUi } from '../../source/core/hook-orchestrator.js';
import { writeState } from '../../source/core/state.js';
import { sha256 } from '../../source/core/fs-utils.js';
import { makeShardState, makeFileState } from '../helpers/shard-state.js';
import type { ShardManifest, ShardSchema } from '../../source/runtime/types.js';

// A schema with one value whose default is 'default'. valuesAreDefaults is true
// iff plan.values === { user_name: 'default' }.
const SCHEMA: ShardSchema = {
  schema_version: 1,
  values: {
    user_name: { type: 'string', message: 'Name?', default: 'default', group: 'g' },
  },
  groups: [{ id: 'g', label: 'G' }],
  modules: {},
  signals: [],
  frontmatter: {},
  migrations: [],
};

const NOOP_UI: HookRunUi = {
  setPhase: () => {},
  onStdout: () => {},
  onStderr: () => {},
};

let shardDir: string;
let vault: string;

beforeEach(async () => {
  shardDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'orch-shard-'));
  vault = await fsp.mkdtemp(path.join(os.tmpdir(), 'orch-vault-'));
  await fsp.mkdir(path.join(shardDir, '.shardmind', 'hooks'), { recursive: true });
});

afterEach(async () => {
  const rmOpts = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };
  await fsp.rm(shardDir, rmOpts);
  await fsp.rm(vault, rmOpts);
});

/** Write a hook script into the shard's .shardmind/hooks dir. */
async function hook(name: string, body: string): Promise<string> {
  const rel = `.shardmind/hooks/${name}`;
  await fsp.writeFile(path.join(shardDir, rel), body, 'utf-8');
  return rel;
}

/** Write a managed file into the vault and return its FileState entry. */
async function managed(rel: string, body: string) {
  const abs = path.join(vault, rel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, body, 'utf-8');
  return makeFileState({ rendered_hash: sha256(body), ownership: 'managed' });
}

function manifest(hooks: ShardManifest['hooks']): ShardManifest {
  return {
    apiVersion: 'v1',
    name: 'orch',
    namespace: 'test',
    version: '1.0.0',
    dependencies: [],
    hooks,
  };
}

function installPlan(over: Partial<HookRunPlan> & { manifest: ShardManifest }): HookRunPlan {
  return {
    command: 'install',
    tempDir: shardDir,
    schema: SCHEMA,
    vaultRoot: vault,
    state: makeShardState(),
    values: { user_name: 'alice' }, // non-default ⇒ personalize runs
    modules: {},
    newFiles: [],
    removedFiles: [],
    dryRun: false,
    ...over,
  };
}

describe('bootstrapShouldRerun', () => {
  it('reruns only when the fingerprint string differs', () => {
    expect(bootstrapShouldRerun(undefined, undefined)).toBe(false);
    expect(bootstrapShouldRerun('v1', 'v1')).toBe(false);
    expect(bootstrapShouldRerun('v1', 'v2')).toBe(true);
    expect(bootstrapShouldRerun(undefined, 'v1')).toBe(true);
    expect(bootstrapShouldRerun('v1', undefined)).toBe(true);
  });
});

describe('runHooks — install/adopt order + gating', () => {
  it('runs bootstrap then personalize, in order (A11)', async () => {
    // Each hook appends its slot to an order file in the vault.
    const append = (slot: string) => `
      import { appendFile } from 'node:fs/promises';
      import { join } from 'node:path';
      export default async function (ctx) {
        await appendFile(join(ctx.vaultRoot, 'order.txt'), '${slot}\\n');
      }
    `;
    await hook('bootstrap.ts', append('bootstrap'));
    await hook('personalize.ts', append('personalize'));
    const result = await runHooks(
      installPlan({ manifest: manifest({ bootstrap: { script: '.shardmind/hooks/bootstrap.ts' }, personalize: '.shardmind/hooks/personalize.ts' }) }),
      NOOP_UI,
    );
    const order = await fsp.readFile(path.join(vault, 'order.txt'), 'utf-8');
    expect(order).toBe('bootstrap\npersonalize\n');
    expect(result.outcomes.map((o) => o.slot)).toEqual(['bootstrap', 'personalize']);
  }, 30_000);

  it('skips personalize entirely when values are defaults (A3 — Invariant 2)', async () => {
    await hook('personalize.ts', `
      import { writeFile } from 'node:fs/promises';
      import { join } from 'node:path';
      export default async function (ctx) {
        await writeFile(join(ctx.vaultRoot, 'personalized.txt'), 'ran');
      }
    `);
    const result = await runHooks(
      installPlan({
        manifest: manifest({ personalize: '.shardmind/hooks/personalize.ts' }),
        values: { user_name: 'default' }, // defaults ⇒ skip
      }),
      NOOP_UI,
    );
    // The hook never spawned: its side-effect file is absent.
    await expect(fsp.access(path.join(vault, 'personalized.txt'))).rejects.toBeTruthy();
    const personalize = result.outcomes.find((o) => o.slot === 'personalize');
    expect(personalize?.summary).toEqual({ skipped: 'values-are-defaults' });
  }, 30_000);

  it('runs personalize on non-default values and re-hashes its managed edit (A4)', async () => {
    const stateFiles = { 'North Star.md': await managed('North Star.md', '# North Star\n') };
    await hook('personalize.ts', `
      import { writeFile } from 'node:fs/promises';
      import { join } from 'node:path';
      export default async function (ctx) {
        await writeFile(join(ctx.vaultRoot, 'North Star.md'), '# North Star — ' + ctx.values.user_name + '\\n');
      }
    `);
    const result = await runHooks(
      installPlan({
        manifest: manifest({ personalize: '.shardmind/hooks/personalize.ts' }),
        state: makeShardState({ files: stateFiles }),
        values: { user_name: 'Alice' },
      }),
      NOOP_UI,
    );
    const body = await fsp.readFile(path.join(vault, 'North Star.md'), 'utf-8');
    expect(body).toContain('North Star — Alice');
    // The final state re-hashes the edited managed file.
    expect(result.stateChanged).toBe(true);
    expect(result.finalState.files['North Star.md']!.rendered_hash).toBe(sha256(body));
    // No boundary violation: personalize is allowed to edit managed files.
    expect(result.outcomes.find((o) => o.slot === 'personalize')?.summary?.violation).toBeUndefined();
  }, 30_000);
});

describe('runHooks — write-boundary detection', () => {
  it('flags bootstrap writing a managed file (A1)', async () => {
    const stateFiles = { 'Home.md': await managed('Home.md', 'home\n') };
    await hook('bootstrap.ts', `
      import { writeFile } from 'node:fs/promises';
      import { join } from 'node:path';
      export default async function (ctx) {
        await writeFile(join(ctx.vaultRoot, 'Home.md'), 'TAMPERED\\n');
      }
    `);
    const result = await runHooks(
      installPlan({
        manifest: manifest({ bootstrap: { script: '.shardmind/hooks/bootstrap.ts' } }),
        state: makeShardState({ files: stateFiles }),
      }),
      NOOP_UI,
    );
    const v = result.outcomes.find((o) => o.slot === 'bootstrap')?.summary?.violation;
    expect(v).toEqual({ kind: 'managed-write', paths: ['Home.md'] });
  }, 30_000);

  it('flags personalize creating an unmanaged file (A2)', async () => {
    await hook('personalize.ts', `
      import { writeFile, mkdir } from 'node:fs/promises';
      import { join } from 'node:path';
      export default async function (ctx) {
        await mkdir(join(ctx.vaultRoot, '.cache'), { recursive: true });
        await writeFile(join(ctx.vaultRoot, '.cache', 'stray.json'), '{}');
      }
    `);
    const result = await runHooks(
      installPlan({
        manifest: manifest({ personalize: '.shardmind/hooks/personalize.ts' }),
        values: { user_name: 'Alice' },
      }),
      NOOP_UI,
    );
    const v = result.outcomes.find((o) => o.slot === 'personalize')?.summary?.violation;
    expect(v).toEqual({ kind: 'unmanaged-create', paths: ['.cache/stray.json'] });
  }, 30_000);

  it('flags bootstrap DELETING a managed file (A1 — destructive write)', async () => {
    const stateFiles = { 'Home.md': await managed('Home.md', 'home\n') };
    await hook('bootstrap.ts', `
      import { rm } from 'node:fs/promises';
      import { join } from 'node:path';
      export default async function (ctx) {
        await rm(join(ctx.vaultRoot, 'Home.md'));
      }
    `);
    const result = await runHooks(
      installPlan({
        manifest: manifest({ bootstrap: { script: '.shardmind/hooks/bootstrap.ts' } }),
        state: makeShardState({ files: stateFiles }),
      }),
      NOOP_UI,
    );
    // A deleted managed file lands in rehash.missing, not changed — it must
    // still surface as a managed-write boundary crossing.
    const v = result.outcomes.find((o) => o.slot === 'bootstrap')?.summary?.violation;
    expect(v).toEqual({ kind: 'managed-write', paths: ['Home.md'] });
  }, 30_000);
});

describe('runHooks — update bootstrap fingerprint (Invariant 4)', () => {
  const markerHook = `
    import { writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    export default async function (ctx) {
      await writeFile(join(ctx.vaultRoot, 'bootstrapped.txt'), ctx.shard.version);
    }
  `;

  function updatePlan(over: Partial<HookRunPlan> & { manifest: ShardManifest }): HookRunPlan {
    return {
      command: 'update',
      tempDir: shardDir,
      schema: SCHEMA,
      vaultRoot: vault,
      state: makeShardState(),
      values: { user_name: 'default' },
      modules: {},
      previousVersion: '0.9.0',
      newFiles: [],
      removedFiles: [],
      dryRun: false,
      ...over,
    };
  }

  it('re-runs bootstrap when the fingerprint changed (A5) and persists the new one', async () => {
    await hook('bootstrap.ts', markerHook);
    const result = await runHooks(
      updatePlan({
        manifest: manifest({ bootstrap: { script: '.shardmind/hooks/bootstrap.ts', fingerprint: 'v2' } }),
        state: makeShardState({ bootstrap_fingerprint: 'v1' }),
      }),
      NOOP_UI,
    );
    await expect(fsp.access(path.join(vault, 'bootstrapped.txt'))).resolves.toBeUndefined();
    expect(result.finalState.bootstrap_fingerprint).toBe('v2');
  }, 30_000);

  it('does NOT re-run bootstrap when the fingerprint is unchanged (A6)', async () => {
    await hook('bootstrap.ts', markerHook);
    await runHooks(
      updatePlan({
        manifest: manifest({ bootstrap: { script: '.shardmind/hooks/bootstrap.ts', fingerprint: 'v1' } }),
        state: makeShardState({ bootstrap_fingerprint: 'v1' }),
      }),
      NOOP_UI,
    );
    await expect(fsp.access(path.join(vault, 'bootstrapped.txt'))).rejects.toBeTruthy();
  }, 30_000);

  it('does NOT re-run bootstrap when no fingerprint is declared (A7)', async () => {
    await hook('bootstrap.ts', markerHook);
    await runHooks(
      updatePlan({
        manifest: manifest({ bootstrap: { script: '.shardmind/hooks/bootstrap.ts' } }),
        state: makeShardState(),
      }),
      NOOP_UI,
    );
    await expect(fsp.access(path.join(vault, 'bootstrapped.txt'))).rejects.toBeTruthy();
  }, 30_000);

  it('does NOT persist the fingerprint when bootstrap exits non-zero (A1)', async () => {
    // A bootstrap that ran but failed must re-run on the next update — recording
    // its fingerprint would strand a never-built artifact.
    await hook('bootstrap.ts', `export default async function () { process.exit(3); }`);
    const result = await runHooks(
      updatePlan({
        manifest: manifest({ bootstrap: { script: '.shardmind/hooks/bootstrap.ts', fingerprint: 'v2' } }),
        state: makeShardState({ bootstrap_fingerprint: 'v1' }),
      }),
      NOOP_UI,
    );
    expect(result.finalState.bootstrap_fingerprint).toBe('v1'); // unchanged
  }, 30_000);

  it('does NOT persist the fingerprint when bootstrap throws', async () => {
    await hook('bootstrap.ts', `export default async function () { throw new Error('boom'); }`);
    const result = await runHooks(
      updatePlan({
        manifest: manifest({ bootstrap: { script: '.shardmind/hooks/bootstrap.ts', fingerprint: 'v2' } }),
        state: makeShardState({ bootstrap_fingerprint: 'v1' }),
      }),
      NOOP_UI,
    );
    expect(result.finalState.bootstrap_fingerprint).toBe('v1');
  }, 30_000);

  it('threads previousVersion into the bootstrap and post-update contexts', async () => {
    const dumpCtx = (name: string) => `
      import { writeFile } from 'node:fs/promises';
      import { join } from 'node:path';
      export default async function (ctx) {
        await writeFile(join(ctx.vaultRoot, '${name}'), JSON.stringify(ctx));
      }
    `;
    await hook('bootstrap.ts', dumpCtx('boot-ctx.json'));
    await hook('post-update.ts', dumpCtx('pu-ctx.json'));
    await runHooks(
      updatePlan({
        manifest: manifest({
          bootstrap: { script: '.shardmind/hooks/bootstrap.ts', fingerprint: 'v2' },
          'post-update': '.shardmind/hooks/post-update.ts',
        }),
        state: makeShardState({ bootstrap_fingerprint: 'v1' }),
        previousVersion: '0.9.0',
      }),
      NOOP_UI,
    );
    const boot = JSON.parse(await fsp.readFile(path.join(vault, 'boot-ctx.json'), 'utf-8'));
    const pu = JSON.parse(await fsp.readFile(path.join(vault, 'pu-ctx.json'), 'utf-8'));
    expect(boot.previousVersion).toBe('0.9.0');
    expect(boot.slot).toBe('bootstrap');
    expect(pu.previousVersion).toBe('0.9.0');
    expect(pu.slot).toBe('post-update');
  }, 30_000);
});

describe('runHooks — legacy + resilience', () => {
  it('runs a lone legacy post-install once with a deprecation flag (A9)', async () => {
    await hook('post-install.ts', `
      import { writeFile } from 'node:fs/promises';
      import { join } from 'node:path';
      export default async function (ctx) {
        await writeFile(join(ctx.vaultRoot, 'legacy.txt'), String(ctx.valuesAreDefaults));
      }
    `);
    const result = await runHooks(
      installPlan({
        manifest: manifest({ 'post-install': '.shardmind/hooks/post-install.ts' }),
        values: { user_name: 'default' },
      }),
      NOOP_UI,
    );
    // Legacy ctx still carries valuesAreDefaults (true here).
    expect(await fsp.readFile(path.join(vault, 'legacy.txt'), 'utf-8')).toBe('true');
    const outcome = result.outcomes.find((o) => o.slot === 'post-install');
    expect(outcome?.summary?.deprecated).toBe(true);
    expect(result.outcomes.map((o) => o.slot)).toEqual(['post-install']);
  }, 30_000);

  it('a thrown bootstrap is non-fatal and personalize still runs (A16)', async () => {
    await hook('bootstrap.ts', `export default async function () { throw new Error('boom'); }`);
    await hook('personalize.ts', `
      import { writeFile } from 'node:fs/promises';
      import { join } from 'node:path';
      export default async function (ctx) { await writeFile(join(ctx.vaultRoot, 'p.txt'), 'ok'); }
    `);
    const result = await runHooks(
      installPlan({
        manifest: manifest({ bootstrap: { script: '.shardmind/hooks/bootstrap.ts' }, personalize: '.shardmind/hooks/personalize.ts' }),
        values: { user_name: 'Alice' },
      }),
      NOOP_UI,
    );
    expect(await fsp.readFile(path.join(vault, 'p.txt'), 'utf-8')).toBe('ok');
    const bootstrap = result.outcomes.find((o) => o.slot === 'bootstrap');
    expect(bootstrap?.summary?.exitCode).toBe(1); // failed → exitCode 1
  }, 30_000);

  it('dry run reports a would-run slot as deferred without executing', async () => {
    await hook('bootstrap.ts', `
      import { writeFile } from 'node:fs/promises';
      import { join } from 'node:path';
      export default async function (ctx) { await writeFile(join(ctx.vaultRoot, 'ran.txt'), 'x'); }
    `);
    const result = await runHooks(
      installPlan({
        manifest: manifest({ bootstrap: { script: '.shardmind/hooks/bootstrap.ts' } }),
        dryRun: true,
      }),
      NOOP_UI,
    );
    await expect(fsp.access(path.join(vault, 'ran.txt'))).rejects.toBeTruthy();
    expect(result.outcomes.find((o) => o.slot === 'bootstrap')?.summary).toEqual({ deferred: true });
    expect(result.stateChanged).toBe(false);
  }, 30_000);

  it('dry run reports a defaults-skipped personalize as skipped, NOT deferred', async () => {
    // The preview must mirror Invariant 2: on a defaults install, personalize
    // would be engine-skipped, so dry-run must say "skipped (values are
    // defaults)" rather than implying the hook would fire.
    await hook('personalize.ts', `export default async function () {}`);
    const result = await runHooks(
      installPlan({
        manifest: manifest({ personalize: '.shardmind/hooks/personalize.ts' }),
        values: { user_name: 'default' }, // defaults ⇒ would skip
        dryRun: true,
      }),
      NOOP_UI,
    );
    expect(result.outcomes.find((o) => o.slot === 'personalize')?.summary).toEqual({
      skipped: 'values-are-defaults',
    });
  }, 30_000);

  it('a lone legacy post-install that writes a managed file is NOT boundary-flagged', async () => {
    // Legacy hooks predate the write boundaries; the engine must not retrofit
    // a violation onto them (SHARD-LAYOUT.md §Legacy).
    const stateFiles = { 'Home.md': await managed('Home.md', 'home\n') };
    await hook('post-install.ts', `
      import { writeFile } from 'node:fs/promises';
      import { join } from 'node:path';
      export default async function (ctx) { await writeFile(join(ctx.vaultRoot, 'Home.md'), 'EDITED\\n'); }
    `);
    const result = await runHooks(
      installPlan({
        manifest: manifest({ 'post-install': '.shardmind/hooks/post-install.ts' }),
        state: makeShardState({ files: stateFiles }),
        values: { user_name: 'Alice' },
      }),
      NOOP_UI,
    );
    const outcome = result.outcomes.find((o) => o.slot === 'post-install');
    expect(outcome?.summary?.violation).toBeUndefined();
    expect(outcome?.summary?.deprecated).toBe(true);
  }, 30_000);

  it('stops launching slots once the run is aborted during bootstrap (A5)', async () => {
    // bootstrap signals it started, then sleeps; the test aborts mid-sleep.
    // The loop's signal check must then skip personalize entirely.
    await hook('bootstrap.ts', `
      import { writeFile } from 'node:fs/promises';
      import { join } from 'node:path';
      export default async function (ctx) {
        await writeFile(join(ctx.vaultRoot, 'boot-started.txt'), '1');
        await new Promise((r) => setTimeout(r, 3000));
      }
    `);
    await hook('personalize.ts', `
      import { writeFile } from 'node:fs/promises';
      import { join } from 'node:path';
      export default async function (ctx) { await writeFile(join(ctx.vaultRoot, 'p.txt'), 'ok'); }
    `);
    const controller = new AbortController();
    const runPromise = runHooks(
      installPlan({
        manifest: manifest({
          bootstrap: { script: '.shardmind/hooks/bootstrap.ts' },
          personalize: '.shardmind/hooks/personalize.ts',
        }),
        values: { user_name: 'Alice' },
      }),
      { ...NOOP_UI, signal: controller.signal },
    );
    // Wait until bootstrap has actually started, then abort.
    const deadline = Date.now() + 10_000;
    while (true) {
      try {
        await fsp.access(path.join(vault, 'boot-started.txt'));
        break;
      } catch {
        if (Date.now() > deadline) throw new Error('bootstrap never started');
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    controller.abort();
    await runPromise;
    // personalize must NOT have run — the loop broke on the aborted signal.
    await expect(fsp.access(path.join(vault, 'p.txt'))).rejects.toBeTruthy();
  }, 30_000);
});
