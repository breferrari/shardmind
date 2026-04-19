/**
 * Typed extractors for Node's `err.code` pattern. Centralized so the
 * `err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined`
 * dance doesn't recur in every file that touches the filesystem.
 *
 * Lives in runtime/ so both runtime modules (for hook scripts) and core
 * modules can import without crossing the one-way runtime → core boundary.
 */

export function errnoCode(err: unknown): string | undefined {
  if (err !== null && typeof err === 'object' && 'code' in err) {
    return (err as { code?: string }).code;
  }
  return undefined;
}

export function isEnoent(err: unknown): boolean {
  return errnoCode(err) === 'ENOENT';
}
