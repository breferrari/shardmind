/**
 * The suite resolves colour the way CI does, whatever the caller exports
 * (#159). A terminal that exports FORCE_COLOR=3 (Warp, for one) used to turn
 * on Ink's ANSI codes in every worker and break frame assertions that match
 * plain text.
 */

import { describe, it, expect } from 'vitest';
import chalk from 'chalk';
import config from '../../vitest.config.js';

describe('colour environment in test workers', () => {
  it("clears the caller's FORCE_COLOR and NO_COLOR", () => {
    expect(process.env['FORCE_COLOR']).toBeUndefined();
    expect(process.env['NO_COLOR']).toBeUndefined();
  });

  it('leaves chalk, which Ink colours through, at level 0', () => {
    expect(chalk.level).toBe(0);
  });

  it('is reset by a setup file vitest.config.ts registers', () => {
    expect(config.test?.setupFiles).toContain('tests/setup/color-env.ts');
  });
});
