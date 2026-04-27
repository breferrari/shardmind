/**
 * Composed hook + banner construction.
 *
 * Each top-level command (`install`, `update`, `adopt`, `status`)
 * needs the same three pieces: read `pkg.version`, fire the npm-registry
 * check, render the banner. Inlining that triple into four command
 * files duplicates the `createRequire` boilerplate, the
 * `useSelfUpdateCheck(...)` call, and the `<SelfUpdateBanner>` JSX —
 * three sites that must stay in lockstep across edits. This wrapper
 * encapsulates them so the call site reduces to one line.
 *
 * Path note: the import-meta pkg lookup uses `'../../../package.json'`
 * because the SOURCE file lives at `source/commands/hooks/`. tsup
 * inlines this helper into each `dist/commands/<name>.js`, so at
 * runtime `import.meta.url` is the *bundle's* URL — depth from the
 * bundle to package.json is two levels (`dist/commands/<name>.js` →
 * `package.json`), which is what the inlined `createRequire` resolves.
 * If this helper is ever moved to a different source depth, recompute
 * the relative path against the bundled command output, not against
 * this file.
 *
 * Spec: ROADMAP §0.1.x Foundation #113.
 */

import { createRequire } from 'node:module';
import { type ReactNode } from 'react';
import SelfUpdateBanner from '../../components/SelfUpdateBanner.js';
import { useSelfUpdateCheck } from './use-self-update-check.js';

const pkg = createRequire(import.meta.url)('../../../package.json') as {
  version: string;
};

export function useSelfUpdateBanner(opts: { noUpdateCheck: boolean }): ReactNode {
  const { info } = useSelfUpdateCheck({
    noUpdateCheck: opts.noUpdateCheck,
    currentVersion: pkg.version,
  });
  return <SelfUpdateBanner info={info} />;
}
