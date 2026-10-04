/**
 * Honours NO_COLOR (#37). Spec: docs/IMPLEMENTATION.md §4.21.
 *
 * Ink colours every `<Text color>` and `dimColor` through chalk, and chalk 5
 * reads FORCE_COLOR but ignores NO_COLOR. chalk resolves its level once, when
 * it is first imported, so this must run on `process.env` before anything
 * loads Ink: `source/cli.ts` calls it first and imports Pastel afterwards.
 */
export function applyNoColor(env: NodeJS.ProcessEnv): void {
  // chalk turns a negative FORCE_COLOR into a negative level and throws at
  // import on Linux and macOS, so treat it as off.
  const force = env['FORCE_COLOR'];
  if (force !== undefined && Number.parseInt(force, 10) < 0) env['FORCE_COLOR'] = '0';
  // FORCE_COLOR is the explicit opt-in, so it wins whenever it is set, even
  // to an empty string, which chalk reads as level 1.
  if (env['FORCE_COLOR'] !== undefined) return;
  // no-color.org: any non-empty value disables colour; an empty one does not.
  if (env['NO_COLOR'] === undefined || env['NO_COLOR'] === '') return;
  env['FORCE_COLOR'] = '0';
}

// SGR only: CSI (7-bit `ESC [` or 8-bit U+009B), numeric parameters separated
// by `;` or `:` (truecolor's colon form), final `m`. Every other control
// sequence is left for #204.
const SGR = /(?:\x1b\[|\u009b)[0-9;:]*m/g;

/** Removes colour and style sequences (SGR), leaving all other bytes as they are. */
export function stripSgr(text: string): string {
  return text.replace(SGR, '');
}
