/**
 * The two helpers the cli-kit inlined from Sindre Sorhus's packages (#277):
 * decamelize's default path and plur's regular rule, against the cases
 * their own test suites document, plus every name ShardMind feeds them.
 */

import { describe, it, expect } from 'vitest';
import decamelize from '../../source/cli-kit/lib/decamelize.js';
import plur from '../../source/cli-kit/lib/plur.js';

describe('decamelize (decamelize 6.0.1, default path)', () => {
  it.each([
    ['', ''],
    ['A', 'a'],
    ['unicornRainbow', 'unicorn_rainbow'],
    ['UNICORN_RAINBOW', 'unicorn_rainbow'],
    ['unicornRainbowCake', 'unicorn_rainbow_cake'],
    ['thisIsATest', 'this_is_a_test'],
    ['myURLstring', 'my_ur_lstring'],
    ['dataForUSACounties', 'data_for_usa_counties'],
    ['testGUILabel', 'test_gui_label'],
    ['test1Label', 'test1_label'],
    ['légèrementFâché', 'légèrement_fâché'],
  ])('%s → %s', (input, expected) => {
    expect(decamelize(input)).toBe(expected);
  });

  it.each([
    ['updateCheck', 'update-check'],
    ['dryRun', 'dry-run'],
    ['includePrerelease', 'include-prerelease'],
    ['noUpdateCheck', 'no-update-check'],
    ['index', 'index'],
    ['_app', '_app'],
  ])('ShardMind name %s → %s with separator "-"', (input, expected) => {
    expect(decamelize(input, { separator: '-' })).toBe(expected);
  });
});

describe('plur (plur 5.1.0, regular rule)', () => {
  it.each([
    ['unicorn', 'unicorns'],
    ['box', 'boxes'],
    ['bus', 'buses'],
    ['church', 'churches'],
    ['dish', 'dishes'],
    ['fly', 'flies'],
    ['day', 'days'],
    ['FILE', 'FILES'],
    ['file', 'files'],
  ])('%s → %s', (input, expected) => {
    expect(plur(input)).toBe(expected);
  });
});
