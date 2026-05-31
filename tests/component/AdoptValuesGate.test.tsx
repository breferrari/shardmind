import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import React from 'react';
import AdoptValuesGate from '../../source/components/AdoptValuesGate.js';
import type { ShardManifest, ShardSchema } from '../../source/runtime/types.js';
import { ENTER, ARROW_DOWN, tick, waitFor, waitForCall } from './helpers.js';

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

/** All-defaults schema → the gate opens on the confirm page. */
const confirmSchema: ShardSchema = {
  schema_version: 1,
  values: {
    user_name: { type: 'string', message: 'Your name', default: 'Ada', group: 'g' },
    vault_purpose: {
      type: 'string',
      message: 'Purpose',
      default: 'engineering',
      group: 'g',
    },
    auto_tag: {
      type: 'string',
      message: 'Auto tag',
      default: '{{ "autogen" }}',
      group: 'g',
    },
  },
  groups: [{ id: 'g', label: 'Setup' }],
  modules: {
    core: { label: 'Core', paths: ['core/'], removable: false },
    extras: { label: 'Extras', paths: ['extras/'], removable: true },
  },
  signals: [],
  frontmatter: {},
  migrations: [],
};

async function mount(node: React.ReactElement) {
  const r = render(node);
  await tick(40);
  return r;
}

describe('AdoptValuesGate', () => {
  it('confirm page lists each value with its provenance label', async () => {
    const { lastFrame } = await mount(
      <AdoptValuesGate
        manifest={manifest}
        schema={confirmSchema}
        prefillValues={{ vault_purpose: 'research' }}
        onComplete={vi.fn()}
        onCancel={vi.fn()}
        onError={vi.fn()}
      />,
    );
    await waitFor(lastFrame, (f) => f.includes('autogen'));
    const frame = lastFrame() ?? '';
    // Literal default.
    expect(frame).toMatch(/user_name:\s+Ada\s+\(default\)/);
    // Supplied via --values prefill.
    expect(frame).toMatch(/vault_purpose:\s+research\s+\(from --values\)/);
    // Computed default resolved to its rendered value.
    expect(frame).toMatch(/auto_tag:\s+autogen\s+\(computed\)/);
    // Module defaults surfaced too — no hidden defaults.
    expect(frame).toMatch(/Modules: all 2 included/);
  });

  it('"Use these values" → onComplete with resolved values + all-default selections', async () => {
    const onComplete = vi.fn();
    const { stdin, lastFrame } = await mount(
      <AdoptValuesGate
        manifest={manifest}
        schema={confirmSchema}
        prefillValues={{}}
        onComplete={onComplete}
        onCancel={vi.fn()}
        onError={vi.fn()}
      />,
    );
    await waitFor(lastFrame, (f) => f.includes('Use these values'));
    stdin.write(ENTER); // first option focused
    await waitForCall(onComplete);
    const result = onComplete.mock.calls[0]![0] as {
      values: Record<string, unknown>;
      selections: Record<string, string>;
    };
    expect(result.values['user_name']).toBe('Ada');
    expect(result.values['auto_tag']).toBe('autogen'); // computed resolved
    expect(result.selections).toEqual({ core: 'included', extras: 'included' });
  });

  it('"Override individually" → drops into the InstallWizard', async () => {
    const { stdin, lastFrame } = await mount(
      <AdoptValuesGate
        manifest={manifest}
        schema={confirmSchema}
        prefillValues={{}}
        onComplete={vi.fn()}
        onCancel={vi.fn()}
        onError={vi.fn()}
      />,
    );
    await waitFor(lastFrame, (f) => f.includes('Use these values'));
    stdin.write(ARROW_DOWN); // → "Override individually"
    await tick(40);
    stdin.write(ENTER);
    // The wizard's header step announces the question count.
    await waitFor(lastFrame, (f) => /questions? to answer/.test(f));
    expect(lastFrame() ?? '').toMatch(/questions? to answer/);
  });

  it('"Cancel" → onCancel', async () => {
    const onCancel = vi.fn();
    const { stdin, lastFrame } = await mount(
      <AdoptValuesGate
        manifest={manifest}
        schema={confirmSchema}
        prefillValues={{}}
        onComplete={vi.fn()}
        onCancel={onCancel}
        onError={vi.fn()}
      />,
    );
    await waitFor(lastFrame, (f) => f.includes('Use these values'));
    stdin.write(ARROW_DOWN);
    await tick(40);
    stdin.write(ARROW_DOWN);
    await tick(40);
    stdin.write(ENTER); // → "Cancel"
    await waitForCall(onCancel);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('required value with no default and no prefill → opens directly in override (no confirm page)', async () => {
    const requiredSchema: ShardSchema = {
      ...confirmSchema,
      values: {
        token: { type: 'string', required: true, message: 'API token', group: 'g' },
      },
    };
    const { lastFrame } = await mount(
      <AdoptValuesGate
        manifest={manifest}
        schema={requiredSchema}
        prefillValues={{}}
        onComplete={vi.fn()}
        onCancel={vi.fn()}
        onError={vi.fn()}
      />,
    );
    await waitFor(lastFrame, (f) => /question to answer/.test(f));
    // The confirm page's hallmark string must never have rendered.
    expect(lastFrame() ?? '').not.toContain('Use these values');
  });

  it('computed default that fails to evaluate → onError, no crash', async () => {
    const onError = vi.fn();
    const badSchema: ShardSchema = {
      ...confirmSchema,
      values: {
        // number-typed computed default that resolves to a non-number →
        // resolveComputedDefaults throws COMPUTED_DEFAULT_INVALID.
        count: { type: 'number', message: 'Count', default: '{{ "abc" }}', group: 'g' },
      },
    };
    await mount(
      <AdoptValuesGate
        manifest={manifest}
        schema={badSchema}
        prefillValues={{}}
        onComplete={vi.fn()}
        onCancel={vi.fn()}
        onError={onError}
      />,
    );
    await waitForCall(onError);
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]![0] as Error).message).toMatch(/computed default/i);
  });

  it('schema with zero values → confirm page still renders and confirms', async () => {
    const onComplete = vi.fn();
    const emptyValuesSchema: ShardSchema = {
      ...confirmSchema,
      values: {},
    };
    const { stdin, lastFrame } = await mount(
      <AdoptValuesGate
        manifest={manifest}
        schema={emptyValuesSchema}
        prefillValues={{}}
        onComplete={onComplete}
        onCancel={vi.fn()}
        onError={vi.fn()}
      />,
    );
    await waitFor(lastFrame, (f) => f.includes('declares no values'));
    stdin.write(ENTER);
    await waitForCall(onComplete);
    const result = onComplete.mock.calls[0]![0] as { values: Record<string, unknown> };
    expect(result.values).toEqual({});
  });
});
