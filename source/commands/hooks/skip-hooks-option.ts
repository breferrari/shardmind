import zod from 'zod';

/**
 * The `--skip-hooks` option, shared by install, update and adopt (#199): run
 * no hook. Each declared hook is reported skipped, and no bootstrap
 * fingerprint is recorded, so the next run with hooks performs bootstrap
 * (SHARD-LAYOUT §Three named slots, Invariant 4).
 */
export const skipHooksOption = zod
  .boolean()
  .default(false)
  .describe('Run no hook; each is reported skipped, and the next run with hooks performs bootstrap');
