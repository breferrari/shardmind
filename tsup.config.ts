import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    cli: 'source/cli.ts',
    'runtime/index': 'source/runtime/index.ts',
  },
  format: ['esm'],
  dts: true,
  splitting: true, // shared chunks for yaml/zod between cli and runtime
  clean: true,
  target: 'node18',
  banner: {
    // Pastel entry needs shebang
    js: '#!/usr/bin/env node',
  },
});
