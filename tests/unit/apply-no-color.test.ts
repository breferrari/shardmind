/**
 * `applyNoColor` (#37): NO_COLOR turns colour off unless FORCE_COLOR is set.
 * See docs/IMPLEMENTATION.md §4.21.
 */

import { describe, it, expect } from 'vitest';
import { applyNoColor } from '../../source/core/color-env.js';

function applied(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  applyNoColor(copy);
  return copy;
}

describe('applyNoColor', () => {
  it('turns colour off when NO_COLOR is non-empty', () => {
    expect(applied({ NO_COLOR: '1' })).toEqual({ NO_COLOR: '1', FORCE_COLOR: '0' });
  });

  it('does nothing when NO_COLOR is empty', () => {
    expect(applied({ NO_COLOR: '' })).toEqual({ NO_COLOR: '' });
  });

  it('does nothing when NO_COLOR is unset', () => {
    expect(applied({})).toEqual({});
  });

  it('lets FORCE_COLOR win over NO_COLOR', () => {
    expect(applied({ NO_COLOR: '1', FORCE_COLOR: '1' })).toEqual({ NO_COLOR: '1', FORCE_COLOR: '1' });
  });

  it('lets an empty FORCE_COLOR win too, since it is set', () => {
    expect(applied({ NO_COLOR: '1', FORCE_COLOR: '' })).toEqual({ NO_COLOR: '1', FORCE_COLOR: '' });
  });

  it('leaves every other variable alone', () => {
    expect(applied({ NO_COLOR: 'yes', TERM: 'xterm', PATH: '/bin' })).toEqual({
      NO_COLOR: 'yes',
      TERM: 'xterm',
      PATH: '/bin',
      FORCE_COLOR: '0',
    });
  });
});
