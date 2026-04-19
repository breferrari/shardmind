/**
 * Typed extractors for Node's `err.code` pattern. Centralized so the
 * `err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined`
 * dance doesn't recur in every file that touches the filesystem.
 *
 * Lives in runtime/ so both runtime modules (for hook scripts) and core
 * modules can import without crossing the one-way runtime → core boundary.
 */

export function errnoCode(err: unknown): string | undefined {
  if (err === null || typeof err !== 'object' || !('code' in err)) return undefined;
  const code = (err as { code?: unknown }).code;
  // Node's types document `code` as string, but we guard at runtime so
  // a stray non-string (some custom errors) can't violate our return type.
  return typeof code === 'string' ? code : undefined;
}

export function isEnoent(err: unknown): boolean {
  return errnoCode(err) === 'ENOENT';
}
