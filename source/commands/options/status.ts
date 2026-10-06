/**
 * The status command's options (`shardmind`, `commands/index.tsx`), Ink-free
 * so its headless `--json` run can parse with them (#302).
 */

import zod from 'zod';
import { updateCheckOption } from '../hooks/update-check-option.js';

export const options = zod.object({
  verbose: zod
    .boolean()
    .default(false)
    .describe('Show full diagnostics (values, modules, files, frontmatter, environment)'),
  // Read by cli.ts, which answers `--json` headless (#302); declared here so
  // it parses and shows in --help.
  json: zod
    .boolean()
    .default(false)
    .describe('Emit the status report as one JSON document instead of the TUI'),
  updateCheck: updateCheckOption,
});
