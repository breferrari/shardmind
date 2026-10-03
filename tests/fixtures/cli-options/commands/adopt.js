// Fixture subcommand for tests/unit/cli-options.test.ts (#147): declares the
// same names as the root (`verbose`, `updateCheck`), as the real adopt does.
import zod from 'zod';
import { useEffect } from 'react';
import { useApp } from 'ink';

export const options = zod.object({
  verbose: zod.boolean().default(false),
  updateCheck: zod.boolean().default(true),
  dryRun: zod.boolean().default(false),
});

export default function Adopt({ options }) {
  globalThis.__cliOptionsSink?.('adopt', options);
  const { exit } = useApp();
  useEffect(() => exit(), [exit]);
  return null;
}
