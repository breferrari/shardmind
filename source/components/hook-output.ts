import chalk from 'chalk';
import { sanitizeHookText } from '../core/color-env.js';

/**
 * Hook output as our components render it. A hook is shard code: its terminal
 * control sequences never reach the user (#204), and its own colour codes are
 * dropped exactly when our output is plain (#37). The colour decision is
 * chalk's level, the one Ink colours by, read rather than re-derived.
 * Spec: docs/IMPLEMENTATION.md §4.21.
 */
export function hookOutputForDisplay(text: string): string {
  return sanitizeHookText(text, chalk.level > 0);
}
