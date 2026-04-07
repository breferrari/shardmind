import { defineConfig } from 'tsup';

export default defineConfig([
  // CLI entry — needs shebang for `npx shardmind`
  {
    entry: { cli: 'source/cli.ts' },
    format: ['esm'],
    dts: true,
    clean: true,
    target: 'node18',
    banner: { js: '#!/usr/bin/env node' },
  },
  // Pastel commands — file-system routing requires separate files in dist/commands/
  {
    entry: { 'commands/index': 'source/commands/index.tsx' },
    format: ['esm'],
    dts: true,
    target: 'node18',
    external: ['react', 'ink', '@inkjs/ui', 'pastel'],
  },
  // Runtime entry — NO shebang, imported as a module by hook scripts
  {
    entry: { 'runtime/index': 'source/runtime/index.ts' },
    format: ['esm'],
    dts: true,
    target: 'node18',
    splitting: true, // shared chunks for yaml/zod
  },
]);
