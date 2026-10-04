/**
 * Honours NO_COLOR (#37). Spec: docs/IMPLEMENTATION.md §4.21.
 *
 * Ink colours every `<Text color>` and `dimColor` through chalk, and chalk 5
 * reads FORCE_COLOR but ignores NO_COLOR. chalk resolves its level once, when
 * it is first imported, so this must run on `process.env` before anything
 * loads Ink: `source/cli.ts` calls it first and imports Pastel afterwards.
 */
export function applyNoColor(env: NodeJS.ProcessEnv): void {
  // FORCE_COLOR is the explicit opt-in, so it wins whenever it is set, even
  // to an empty string, which chalk reads as level 1.
  if (env['FORCE_COLOR'] !== undefined) return;
  // no-color.org: any non-empty value disables colour; an empty one does not.
  if (env['NO_COLOR'] === undefined || env['NO_COLOR'] === '') return;
  env['FORCE_COLOR'] = '0';
}

/**
 * Whether output is coloured, by the rule chalk applies (after
 * `applyNoColor`): a set FORCE_COLOR decides, `'0'` and `'false'` meaning
 * off; otherwise colour is on in a terminal whose TERM is not `dumb`.
 */
export function colorEnabled(env: NodeJS.ProcessEnv, isTTY: boolean): boolean {
  const force = env['FORCE_COLOR'];
  if (force !== undefined) return force !== '0' && force !== 'false';
  return isTTY && env['TERM'] !== 'dumb';
}

// SGR only: CSI (7-bit `ESC [` or 8-bit U+009B), numeric parameters separated
// by `;` or `:` (truecolor's colon form), final `m`. Every other control
// sequence is left for #204.
const SGR = /(?:\x1b\[|\u009b)[0-9;:]*m/g;

/** Removes colour and style sequences (SGR), leaving all other bytes as they are. */
export function stripSgr(text: string): string {
  return text.replace(SGR, '');
}

/**
 * Hook output as our components render it: a hook is shard code, and its own
 * colour codes are dropped when the user's output is not coloured.
 */
export function hookOutputForDisplay(text: string): string {
  return colorEnabled(process.env, process.stdout.isTTY === true) ? text : stripSgr(text);
}
