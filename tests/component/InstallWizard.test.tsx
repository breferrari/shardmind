import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import React from 'react';
import InstallWizard from '../../source/components/InstallWizard.js';
import type {
  ShardManifest,
  ShardSchema,
  ModuleSelections,
} from '../../source/runtime/types.js';
import { ENTER, ESC, tick, typeText, waitFor } from './helpers.js';

afterEach(() => {
  cleanup();
});

const manifest: ShardManifest = {
  apiVersion: 'v1',
  name: 'mini',
  namespace: 'breferrari',
  version: '0.1.0',
  dependencies: [],
  hooks: {},
};

const schema: ShardSchema = {
  schema_version: 1,
  values: {
    user_name: {
      type: 'string',
      required: true,
      message: 'Your name',
      group: 'setup',
    },
    org_name: {
      type: 'string',
      message: 'Organization',
      default: 'Independent',
      group: 'setup',
    },
  },
  groups: [{ id: 'setup', label: 'Quick Setup' }],
  modules: {
    core: { label: 'Core', paths: ['core/'], removable: false },
    extras: { label: 'Extras', paths: ['extras/'], removable: true },
  },
  signals: [],
  frontmatter: {},
  migrations: [],
};

const moduleFileCounts = { core: 10, extras: 5 };

async function mount(node: React.ReactElement) {
  const r = render(node);
  await tick(30);
  return r;
}

describe('InstallWizard', () => {
  it('drives through values → modules → confirm → install', async () => {
    const onComplete = vi.fn();
    const onCancel = vi.fn();
    const onError = vi.fn();

    const { stdin, lastFrame } = await mount(
      <InstallWizard
        manifest={manifest}
        schema={schema}
        prefillValues={{}}
        moduleFileCounts={moduleFileCounts}
        alwaysIncludedFileCount={0}
        onComplete={onComplete}
        onCancel={onCancel}
        onError={onError}
      />,
    );

    // Header step — Enter starts the flow
    await waitFor(lastFrame, (f) => /2 questions to answer/.test(f));
    stdin.write(ENTER);
    await waitFor(lastFrame, (f) => f.includes('Your name'));

    // Value 1: user_name (required string)
    await typeText(stdin, 'Alice');
    stdin.write(ENTER);
    await waitFor(lastFrame, (f) => f.includes('Organization'));

    // Value 2: org_name — Enter to accept default 'Independent'
    stdin.write(ENTER);
    await waitFor(lastFrame, (f) => f.includes('Choose modules to install'));

    // Module review — Enter submits default selections
    stdin.write(ENTER);
    await waitFor(lastFrame, (f) => f.includes('Ready to install'));

    // Confirm step — first option is Install
    stdin.write(ENTER);
    await waitFor(() => (onComplete.mock.calls.length > 0 ? 'ok' : ''), (f) => f === 'ok');

    const [{ values, selections }] = onComplete.mock.calls[0] as [
      { values: Record<string, unknown>; selections: ModuleSelections },
    ];
    expect(values.user_name).toBe('Alice');
    expect(values.org_name).toBe('Independent');
    expect(selections.core).toBe('included');
    expect(selections.extras).toBe('included');
    expect(onCancel).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('Esc from value step navigates back to the header', async () => {
    const { stdin, lastFrame } = await mount(
      <InstallWizard
        manifest={manifest}
        schema={schema}
        prefillValues={{}}
        moduleFileCounts={moduleFileCounts}
        alwaysIncludedFileCount={0}
        onComplete={() => {}}
        onCancel={() => {}}
        onError={() => {}}
      />,
    );

    await waitFor(lastFrame, (f) => /2 questions to answer/.test(f));
    stdin.write(ENTER);
    await waitFor(lastFrame, (f) => f.includes('Your name'));

    // Esc should return to header
    stdin.write(ESC);
    await waitFor(lastFrame, (f) => /2 questions to answer/.test(f));
  });

  it('skips to modules when all values are prefilled', async () => {
    const { lastFrame } = await mount(
      <InstallWizard
        manifest={manifest}
        schema={schema}
        prefillValues={{ user_name: 'Alice', org_name: 'Org' }}
        moduleFileCounts={moduleFileCounts}
        alwaysIncludedFileCount={0}
        onComplete={() => {}}
        onCancel={() => {}}
        onError={() => {}}
      />,
    );

    await waitFor(lastFrame, (f) => f.includes('Choose modules to install'));
  });

  it('prompts for every value under v6 (all schema values have a `default`)', async () => {
    // Regression guard: under the v6 contract, every value has a literal
    // default. If the wizard merged defaults into its prompt-list input,
    // valueKeys would always be empty and the user would never be asked
    // about anything. Pin the corrected behavior — empty raw prefill
    // surfaces all non-computed values as questions.
    const v6Schema: ShardSchema = {
      schema_version: 1,
      values: {
        user_name: { type: 'string', required: true, message: 'Your name', default: '', group: 'setup' },
        org_name: { type: 'string', message: 'Organization', default: 'Independent', group: 'setup' },
        vault_purpose: {
          type: 'select',
          required: true,
          message: 'Vault purpose',
          options: [
            { value: 'engineering', label: 'Engineering' },
            { value: 'research', label: 'Research' },
          ],
          default: 'engineering',
          group: 'setup',
        },
      },
      groups: [{ id: 'setup', label: 'Quick Setup' }],
      modules: {},
      signals: [],
      frontmatter: {},
      migrations: [],
    };

    const { lastFrame } = await mount(
      <InstallWizard
        manifest={manifest}
        schema={v6Schema}
        prefillValues={{}}
        moduleFileCounts={{}}
        alwaysIncludedFileCount={0}
        onComplete={() => {}}
        onCancel={() => {}}
        onError={() => {}}
      />,
    );

    await waitFor(lastFrame, (f) => /3 questions to answer/.test(f));
  });
});
