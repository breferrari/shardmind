import chalk from 'chalk';
import { stripSgr } from '../core/color-env.js';

/**
 * Hook output as our components render it (#37). A hook is shard code; its
 * own colour codes are dropped exactly when our output is plain. The decision
 * is chalk's level, the one Ink colours by, read rather than re-derived, so
 * TERM, CI vendors and FORCE_COLOR parsing cannot make the two disagree.
 * Spec: docs/IMPLEMENTATION.md §4.21.
 */
export function hookOutputForDisplay(text: string): string {
  return chalk.level === 0 ? stripSgr(text) : text;
}
