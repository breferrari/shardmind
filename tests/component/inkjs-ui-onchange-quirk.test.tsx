import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import React, { useState } from 'react';
import { Box, Text } from 'ink';
// Intentional direct @inkjs/ui import. This file tracks upstream
// behavior; it must keep hitting @inkjs/ui even if we later vendor or
// fork the component in source/components/ui.ts. Do not route through
// the shim.
import { TextInput } from '@inkjs/ui';
import { ENTER, tick, typeText, waitFor } from './helpers.js';

afterEach(() => {
  cleanup();
});

/**
 * Regression test documenting a quirk in @inkjs/ui's TextInput.
 *
 * When the parent passes an inline onChange closure, useTextInput's
 * internal useEffect has `onChange` as a dependency. A parent re-render
 * (e.g. from setState in onSubmit) produces a new onChange identity,
 * re-runs the effect, and the inner `state.value !== state.previousValue`
 * guard doesn't prevent a spurious call because `previousValue` holds
 * the value-before-the-last-insert, not the value last notified.
 *
 * Result: onChange fires again with the unchanged value after submit.
 *
 * This test captures the observed behavior so that:
 *   (a) if @inkjs/ui fixes the upstream issue, this test fails loudly
 *       and we can simplify our ExistingInstallGate workaround;
 *   (b) if someone simplifies ExistingInstallGate's ref-based guard
 *       back to the naive `if (error) setError(null)` pattern, they'll
 *       understand why we did what we did.
 *
 * See ExistingInstallGate.tsx for the workaround.
 *
 * Upstream issue: https://github.com/vadimdemedes/ink-ui/issues/26
 * Upstream fix (pending review): https://github.com/vadimdemedes/ink-ui/pull/27
 */
describe('@inkjs/ui TextInput onChange quirk (regression)', () => {
  it('fires onChange spuriously after submit when parent re-renders', async () => {
    const onChangeValues: string[] = [];
    const submitValues: string[] = [];

    function Harness() {
      const [_submitCount, setSubmitCount] = useState(0);
      return (
        <Box flexDirection="column">
          <TextInput
            onChange={(v) => onChangeValues.push(v)}
            onSubmit={(v) => {
              submitValues.push(v);
              setSubmitCount((c) => c + 1); // triggers a parent re-render
            }}
          />
        </Box>
      );
    }

    const { stdin } = render(<Harness />);
    await tick(30);
    await typeText(stdin, 'abc');
    stdin.write(ENTER);

    // Poll for the spurious fire rather than sleeping a fixed amount.
    // If upstream ever fixes the bug, this times out (fails the test)
    // instead of passing from a lucky-fast tick or flaking under load.
    await waitFor(
      () => (onChangeValues.length > 3 ? 'ok' : ''),
      (f) => f === 'ok',
      500,
    );

    expect(submitValues).toEqual(['abc']);

    // The typing itself produces exactly 3 onChange calls — one per
    // keystroke. If @inkjs/ui stops firing spuriously after submit,
    // this length will drop to 3 and this test should be updated (and
    // ExistingInstallGate's workaround simplified).
    const typingFires = onChangeValues.slice(0, 3);
    expect(typingFires).toEqual(['a', 'ab', 'abc']);

    const postSubmitFires = onChangeValues.slice(3);
    expect(postSubmitFires.length).toBeGreaterThan(0);
    expect(postSubmitFires.every((v) => v === 'abc')).toBe(true);
  });
});
