import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import React from 'react';
import NewValuesPrompt from '../../source/components/NewValuesPrompt.js';
import type { ShardSchema } from '../../source/runtime/types.js';
import { ENTER, tick, typeText, waitFor } from './helpers.js';

afterEach(() => {
  cleanup();
});

function schemaWith(values: ShardSchema['values']): ShardSchema {
  return {
    schema_version: 1,
    values,
    groups: [{ id: 'setup', label: 'Setup' }],
    modules: {},
    signals: [],
    frontmatter: {},
    migrations: [],
  };
}

describe('NewValuesPrompt', () => {
  it('shows the step counter and group label for the first missing key', async () => {
    const schema = schemaWith({
      user_name: { type: 'string', required: true, message: 'Your name?', group: 'setup' },
    });
    const { lastFrame } = render(
      <NewValuesPrompt
        schema={schema}
        keys={['user_name']}
        existingValues={{}}
        onComplete={() => {}}
      />,
    );
    await tick(30);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('New values since your last install');
    expect(frame).toContain('Step 1 of 1');
    // Renders the human-readable group label ("Setup"), not the raw id
    // ("setup") — same lookup InstallWizard uses for consistency.
    expect(frame).toContain('Setup');
    expect(frame).toContain('Your name?');
  });

  it('cycles through multiple keys and fires onComplete once with merged values', async () => {
    const schema = schemaWith({
      user_name: { type: 'string', required: true, message: 'Your name?', group: 'setup' },
      team: { type: 'string', required: true, message: 'Team?', group: 'setup' },
    });
    const onComplete = vi.fn();
    const { stdin, lastFrame } = render(
      <NewValuesPrompt
        schema={schema}
        keys={['user_name', 'team']}
        existingValues={{ existing_key: 'carried over' }}
        onComplete={onComplete}
      />,
    );
    await tick(30);

    await typeText(stdin, 'Alice');
    stdin.write(ENTER);
    await waitFor(lastFrame, (f) => f.includes('Step 2 of 2'));

    await typeText(stdin, 'Platform');
    stdin.write(ENTER);
    await waitFor(
      () => (onComplete.mock.calls.length > 0 ? 'ok' : ''),
      (f) => f === 'ok',
    );

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith({
      existing_key: 'carried over',
      user_name: 'Alice',
      team: 'Platform',
    });
  });

  it('renders nothing when given an empty keys array (effectless path)', async () => {
    const schema = schemaWith({});
    const onComplete = vi.fn();
    const { lastFrame } = render(
      <NewValuesPrompt
        schema={schema}
        keys={[]}
        existingValues={{}}
        onComplete={onComplete}
      />,
    );
    await tick(30);
    // Nothing rendered; caller is expected to check the keys length upstream.
    expect(lastFrame()?.trim() ?? '').toBe('');
  });
});
