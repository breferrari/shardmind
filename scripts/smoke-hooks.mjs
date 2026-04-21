// Smoke driver for the post-install / post-update hook runtime (#30).
// Stands up three local github-stubs, each serving a custom tarball
// that embeds a different kind of hook — happy / throwing / hanging —
// then drives the built CLI against each and asserts on exit code,
// filesystem state, and the captured Summary output.
//
// Unlike `scripts/smoke-install.sh` (which requires a public GitHub
// shard), this driver is hermetic: no network, no remote fixture. The
// github-stub helper from `tests/e2e/helpers/` answers the three
// endpoints the CLI consumes. Run from the repo root:
//
//   npm run build
//   node --import tsx scripts/smoke-hooks.mjs
//
// Complements the E2E vitest suite — that coverage runs in CI, this
// script is for human-eye verification mid-PR when behavior might
// have changed in ways the test assertions don't cover (live UI
// rendering, wrapping, color).
//
// Expects `dist/cli.js` + `dist/internal/hook-runner.js` already built.

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import * as tar from 'tar';
import { fileURLToPath } from 'node:url';
import { createGitHubStub } from '../tests/e2e/helpers/github-stub.ts';
import { spawnCli } from '../tests/e2e/helpers/spawn-cli.ts';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MINIMAL = path.join(REPO, 'examples/minimal-shard');

async function copyTree(src, dst) {
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const from = path.join(src, e.name);
    const to = path.join(dst, e.name);
    if (e.isDirectory()) await copyTree(from, to);
    else if (e.isFile()) await fs.copyFile(from, to);
  }
}

async function buildTarball(scratch, slug, hookSource, { timeoutMs } = {}) {
  const prefix = `${slug.split('/')[1]}-0.1.0`;
  const workRoot = path.join(scratch, slug.replace('/', '-'));
  const workDir = path.join(workRoot, prefix);
  await copyTree(MINIMAL, workDir);
  await fs.mkdir(path.join(workDir, 'hooks'), { recursive: true });
  await fs.writeFile(path.join(workDir, 'hooks/post-install.ts'), hookSource, 'utf-8');
  if (timeoutMs !== undefined) {
    const shardYaml = await fs.readFile(path.join(workDir, 'shard.yaml'), 'utf-8');
    await fs.writeFile(
      path.join(workDir, 'shard.yaml'),
      shardYaml + `  timeout_ms: ${timeoutMs}\n`,
      'utf-8',
    );
  }
  const tarPath = path.join(scratch, `${prefix}.tar.gz`);
  await tar.c({ file: tarPath, gzip: true, cwd: workRoot }, [prefix]);
  return tarPath;
}

async function writeValues(vault) {
  const p = path.join(vault, '.values.yaml');
  await fs.writeFile(
    p,
    'user_name: Smoke\norg_name: Test\nvault_purpose: engineering\nqmd_enabled: true\n',
    'utf-8',
  );
  return p;
}

async function runScenario(name, { slug, hook, timeoutMs, validate }) {
  console.log(`\n${'='.repeat(60)}\n SCENARIO: ${name}\n${'='.repeat(60)}`);

  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'sm-smoke-'));
  const vault = path.join(scratch, 'vault');
  await fs.mkdir(vault);
  const tarball = await buildTarball(scratch, slug, hook, { timeoutMs });
  const stub = await createGitHubStub({
    shards: { [slug]: { versions: { '0.1.0': tarball }, latest: '0.1.0' } },
  });

  try {
    const valuesPath = await writeValues(vault);
    const start = Date.now();
    const result = await spawnCli(
      ['install', `github:${slug}`, '--yes', '--values', valuesPath],
      { cwd: vault, env: { SHARDMIND_GITHUB_API_BASE: stub.url } },
    );
    const elapsed = Date.now() - start;

    console.log(`\nexit code: ${result.exitCode}   elapsed: ${elapsed}ms\n`);
    console.log('--- stdout ---');
    console.log(result.stdout);
    console.log('--- stderr ---');
    console.log(result.stderr);
    console.log('--- vault files ---');
    const listed = await fs.readdir(vault);
    console.log(listed.join('\n'));

    console.log('\n--- assertions ---');
    await validate({ result, vault, elapsed });
    console.log(`\n✓ PASS: ${name}`);
  } finally {
    await stub.close();
    await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

const hooks = {
  happy: [
    "import { writeFile } from 'node:fs/promises';",
    "import { join } from 'node:path';",
    'export default async function (ctx) {',
    "  console.log('SMOKE_HAPPY for ' + ctx.shard.name);",
    "  console.error('benign stderr line');",
    "  await writeFile(join(ctx.vaultRoot, 'smoke-marker.txt'), 'ok');",
    '}',
    '',
  ].join('\n'),
  throwing: [
    'export default async function () {',
    "  console.log('before boom');",
    "  throw new Error('SMOKE_THROW_BOOM');",
    '}',
    '',
  ].join('\n'),
  hanging: [
    'export default async function () {',
    "  console.log('about to hang');",
    '  await new Promise(resolve => setTimeout(resolve, 10000));',
    '}',
    '',
  ].join('\n'),
};

await runScenario('happy path', {
  slug: 'smoke/happy',
  hook: hooks.happy,
  validate: async ({ result, vault }) => {
    if (result.exitCode !== 0) throw new Error(`expected exit 0, got ${result.exitCode}`);
    const marker = await fs.readFile(path.join(vault, 'smoke-marker.txt'), 'utf-8');
    if (marker !== 'ok') throw new Error(`marker content: ${JSON.stringify(marker)}`);
    if (!result.stdout.includes('Post-install hook completed'))
      throw new Error('expected "Post-install hook completed" in stdout');
    if (!result.stdout.includes('SMOKE_HAPPY'))
      throw new Error('expected captured stdout line in summary');
    console.log('  ✓ exit 0');
    console.log('  ✓ marker written');
    console.log('  ✓ Summary shows "completed"');
    console.log('  ✓ captured stdout surfaced');
  },
});

await runScenario('throwing hook', {
  slug: 'smoke/throwing',
  hook: hooks.throwing,
  validate: async ({ result, vault }) => {
    if (result.exitCode !== 0) throw new Error(`expected exit 0 (install succeeded), got ${result.exitCode}`);
    try {
      await fs.access(path.join(vault, '.shardmind/state.json'));
    } catch {
      throw new Error('state.json missing — rollback fired, should not have');
    }
    try {
      await fs.access(path.join(vault, 'Home.md'));
    } catch {
      throw new Error('Home.md missing — rollback fired');
    }
    if (!result.stdout.includes('Post-install hook exited with code 1'))
      throw new Error('expected "exited with code 1" warning in stdout');
    if (!result.stdout.includes('SMOKE_THROW_BOOM'))
      throw new Error('expected throw message in captured output');
    // Ink may soft-wrap at terminal width; collapse whitespace before matching.
    const collapsed = result.stdout.replace(/\s+/g, ' ');
    if (!collapsed.includes("Install succeeded; the hook's work may be incomplete."))
      throw new Error('expected "Install succeeded" warning phrasing (after whitespace collapse)');
    console.log('  ✓ exit 0 (install completed despite hook throw)');
    console.log('  ✓ state.json + Home.md present (no rollback)');
    console.log('  ✓ yellow warning with exit code 1');
    console.log('  ✓ thrown error reached captured output');
  },
});

await runScenario('hanging hook + timeout_ms: 1000', {
  // 1000 ms is the minimum the manifest zod validator accepts
  // (source/core/manifest.ts::hooks.timeout_ms.min(1000)). The rationale
  // for the floor — documented in manifest.ts — is that even a warm-cache
  // `git init` completes in ~50ms but a cold spawn can hit 200ms, so a
  // sub-second budget is almost always an authoring bug. The PR body's
  // test-plan bullet called out 500ms; that was a writing error — the
  // actual minimum is 1000ms.
  slug: 'smoke/hanging',
  hook: hooks.hanging,
  timeoutMs: 1000,
  validate: async ({ result, elapsed, vault }) => {
    if (result.exitCode !== 0) throw new Error(`expected exit 0, got ${result.exitCode}`);
    try {
      await fs.access(path.join(vault, '.shardmind/state.json'));
    } catch {
      throw new Error('state.json missing — rollback fired');
    }
    // elapsed ~= spawn cold-start + 1000 ms + up to 2 s SIGKILL grace.
    if (elapsed > 10_000)
      throw new Error(`elapsed ${elapsed}ms too long — timeout not enforced?`);
    if (!result.stdout.match(/timed out after 1\.0\s*s/i))
      throw new Error('expected "timed out after 1.0s" in stdout');
    if (!result.stdout.includes('about to hang'))
      throw new Error('expected partial output preserved');
    console.log('  ✓ exit 0 (install completed despite hook timeout)');
    console.log('  ✓ state.json present');
    console.log(`  ✓ timed out at ~${elapsed}ms (budget 1000ms + grace)`);
    console.log('  ✓ partial output preserved');
  },
});

console.log('\n' + '='.repeat(60));
console.log(' ALL SMOKE SCENARIOS PASSED');
console.log('='.repeat(60));
