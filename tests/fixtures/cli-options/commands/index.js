// Fixture root command for tests/unit/cli-options.test.ts (#147): declares the
// same options as source/commands/index.tsx and reports what Pastel hands it.
import zod from 'zod';
import { useEffect } from 'react';
import { useApp } from 'ink';

export const options = zod.object({
  verbose: zod.boolean().default(false),
  updateCheck: zod.boolean().default(true),
});

export default function Index({ options }) {
  globalThis.__cliOptionsSink?.('index', options);
  const { exit } = useApp();
  useEffect(() => exit(), [exit]);
  return null;
}
