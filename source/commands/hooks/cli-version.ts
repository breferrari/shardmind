/**
 * Locate shardmind's own `package.json` at runtime.
 *
 * `cli.ts` reads `pkg.version` via a hardcoded `'../package.json'`
 * because it bundles to `dist/cli.js` (one level up from package root).
 * Helpers bundled into chunks or split-command entries land at varying
 * depths (`dist/chunk-<hash>.js`, `dist/commands/<name>.js`), so a
 * single hardcoded path cannot work universally — the wrong choice
 * silently resolves to a parent-directory `package.json` with no
 * `version` field (e.g. `~/package.json`), turning currentVersion
 * into `undefined` and silently disabling the self-update banner.
 *
 * The fix is to walk up from the loaded module's directory looking for
 * shardmind's own `package.json`, identified by `name === 'shardmind'`,
 * capped at a small depth so a misplaced bundle doesn't traverse to
 * the filesystem root.
 *
 * Returns `'0.0.0'` when nothing matches within the depth cap. The
 * sentinel is a valid semver that `semver.lt` always treats as less
 * than any plausible published version, so the banner errs toward
 * over-notifying — the right failure mode when the engine's own
 * layout is unexpected: better to show a cosmetic banner than to
 * silently never tell a user about a hotfix.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

export const PKG_VERSION_FALLBACK = '0.0.0';
export const PKG_RESOLVE_MAX_DEPTH = 6;

export function resolvePkgVersion(startUrl: string): string {
  let startPath: string;
  try {
    startPath = fileURLToPath(startUrl);
  } catch {
    return PKG_VERSION_FALLBACK;
  }
  let dir = path.dirname(startPath);
  for (let i = 0; i < PKG_RESOLVE_MAX_DEPTH; i++) {
    const candidate = path.join(dir, 'package.json');
    // Direct readFile + JSON.parse rather than `createRequire(...)(candidate)`:
    // Node's require caches `package.json` parse failures and propagates them
    // into ancestor-package-config lookups for subsequent require() calls in
    // the same process — so a malformed sibling package.json poisons the next
    // walk iteration with an unrelated "Invalid package config" error from
    // the cache, which our `try/catch` would also swallow but for the WRONG
    // candidate. Reading bytes ourselves keeps each iteration's fate
    // independent of the others.
    try {
      if (fs.existsSync(candidate)) {
        const raw = fs.readFileSync(candidate, 'utf-8');
        const pkg = JSON.parse(raw) as { name?: unknown; version?: unknown };
        if (pkg && pkg.name === 'shardmind' && typeof pkg.version === 'string') {
          return pkg.version;
        }
      }
    } catch {
      // Walk past unreadable / malformed package.json files silently.
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // hit filesystem root
    dir = parent;
  }
  return PKG_VERSION_FALLBACK;
}
