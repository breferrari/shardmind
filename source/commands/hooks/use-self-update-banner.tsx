/**
 * Composed hook + banner construction.
 *
 * Each top-level command (`install`, `update`, `adopt`, `status`)
 * needs the same three pieces: read shardmind's own `pkg.version`,
 * fire the npm-registry check, render the banner. Inlining that
 * triple into four command files duplicates the `createRequire`
 * boilerplate, the `useSelfUpdateCheck(...)` call, and the
 * `<SelfUpdateBanner>` JSX — three sites that must stay in lockstep
 * across edits. This wrapper encapsulates them so the call site
 * reduces to one line.
 *
 * Version lookup is delegated to `resolvePkgVersion` (see
 * `cli-version.ts`) — extracted because the resolver is non-trivial
 * (must walk up from the bundled module's location, identifying
 * shardmind's package.json by `name`) and benefits from being
 * unit-testable in isolation.
 *
 * Spec: ROADMAP §0.1.x Foundation #113.
 */

import { type ReactNode } from 'react';
import SelfUpdateBanner from '../../components/SelfUpdateBanner.js';
import { useSelfUpdateCheck } from './use-self-update-check.js';
import { resolvePkgVersion } from './cli-version.js';

const cliVersion = resolvePkgVersion(import.meta.url);

export function useSelfUpdateBanner(opts: { noUpdateCheck: boolean }): ReactNode {
  const { info } = useSelfUpdateCheck({
    noUpdateCheck: opts.noUpdateCheck,
    currentVersion: cliVersion,
  });
  return <SelfUpdateBanner info={info} />;
}
