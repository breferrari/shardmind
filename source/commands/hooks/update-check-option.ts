import zod from 'zod';

/**
 * The `--no-update-check` option, shared by every command.
 *
 * Named for the positive on purpose. Pastel turns a boolean that defaults to
 * `true` into a `--no-<name>` flag, and Commander stores a `--no-<name>` flag
 * under `<name>`. Declared as `noUpdateCheck` defaulting to `false`, Pastel
 * still emitted `--no-update-check`, Commander stored it under `updateCheck`,
 * and the command's `noUpdateCheck` never changed (#147). See
 * docs/ARCHITECTURE.md §10.1.
 */
export const updateCheckOption = zod
  .boolean()
  .default(true)
  .describe('Disable the once-per-day npm registry check for newer shardmind versions');
