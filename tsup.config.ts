import { defineConfig } from 'tsup';

export default defineConfig([
  // CLI entry — needs shebang for `npx shardmind`
  {
    entry: { cli: 'source/cli.ts' },
    format: ['esm'],
    dts: true,
    // No `clean` here: the configs build in parallel, and this one's
    // declaration step deletes every `.d.ts` in dist/ when it starts, which
    // wiped dist/runtime/index.d.ts whenever the runtime's types finished
    // first (#358). `npm run build` empties dist/ once, before tsup starts.
    target: 'node18',
    banner: { js: '#!/usr/bin/env node' },
  },
  // Commands — the cli-kit routes by file, so each is its own file in dist/commands/
  {
    entry: {
      'commands/index': 'source/commands/index.tsx',
      'commands/install': 'source/commands/install.tsx',
      'commands/update': 'source/commands/update.tsx',
      'commands/adopt': 'source/commands/adopt.tsx',
      'commands/validate': 'source/commands/validate.tsx',
      'commands/_app': 'source/commands/_app.tsx',
    },
    format: ['esm'],
    dts: true,
    target: 'node18',
    external: ['react', 'ink'],
  },
  // Runtime entry — NO shebang, imported as a module by hook scripts
  {
    entry: { 'runtime/index': 'source/runtime/index.ts' },
    format: ['esm'],
    dts: true,
    target: 'node18',
    splitting: true, // shared chunks for yaml/zod
  },
  // Internal hook-runner — subprocess entry point spawned by core/hook.ts's
  // executeHook(). Emitted under `dist/internal/` and mapped in package.json
  // as `./internal/hook-runner` so `require.resolve('shardmind/internal/hook-runner')`
  // can find it regardless of the consumer's install layout. Deliberately
  // bundled standalone (no splitting) so the cold-start path for every
  // hook invocation is a single small file. `target: 'node18'` matches the
  // other bundles — the package's engines gate is `>=22`, but the bundles
  // themselves stay node18-compatible so a future engines loosening doesn't
  // silently emit node20+ JS. See source/internal/hook-runner.ts for the
  // contract and CLAUDE.md §Module Boundaries for why it's NOT public API.
  {
    entry: { 'internal/hook-runner': 'source/internal/hook-runner.ts' },
    format: ['esm'],
    dts: false,
    target: 'node18',
  },
  // Internal self-update refresh — the detached child core/self-update-check.ts's
  // spawnSelfUpdateRefresh() starts when the npm cache is stale (#285). Mapped
  // as `./internal/self-update-refresh` and bundled standalone, like the
  // hook-runner above.
  {
    entry: { 'internal/self-update-refresh': 'source/internal/self-update-refresh.ts' },
    format: ['esm'],
    dts: false,
    target: 'node18',
  },
]);
