import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import React from 'react';
import AdoptValuesGate from '../../source/components/AdoptValuesGate.js';
import type { ShardManifest, ShardSchema } from '../../source/runtime/types.js';
import {
  mergePrefill,
  resolveComputedDefaults,
  defaultModuleSelections,
} from '../../source/core/install-planner.js';
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

/**
 * Default props with `vi.fn()` callbacks; each test overrides only what it
 * exercises, so the assertion-relevant prop is the only one spelled out.
 */
function gateProps(
  overrides: Partial<React.ComponentProps<typeof AdoptValuesGate>> = {},
): React.ComponentProps<typeof AdoptValuesGate> {
  return {
    manifest,
    schema: confirmSchema,
    prefillValues: {},
    onComplete: vi.fn(),
    onCancel: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
}

describe('AdoptValuesGate', () => {
  it('confirm page lists each value with its provenance label', async () => {
    const { lastFrame } = await mount(
      <AdoptValuesGate {...gateProps({ prefillValues: { vault_purpose: 'research' } })} />,
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

  it('"Use these values" → onComplete equals the --yes (runNonInteractive) value set', async () => {
    // Parity invariant: the confirm gate's "Use these values" must feed the
    // adopt machine exactly what the --yes path (runNonInteractive) would —
    // resolveComputedDefaults(mergePrefill(prefill)) + all-default module
    // selections. The machine validates both identically in runPlanning, so
    // matching the pre-validation set is the contract.
    const prefill = { vault_purpose: 'research' };
    const onComplete = vi.fn();
    const { stdin, lastFrame } = await mount(
      <AdoptValuesGate {...gateProps({ prefillValues: prefill, onComplete })} />,
    );
    await waitFor(lastFrame, (f) => f.includes('Use these values'));
    stdin.write(ENTER); // first option focused
    await waitForCall(onComplete);
    const result = onComplete.mock.calls[0]![0] as {
      values: Record<string, unknown>;
      selections: Record<string, string>;
    };
    const expectedValues = resolveComputedDefaults(
      confirmSchema,
      mergePrefill(confirmSchema, prefill),
    );
    expect(result.values).toEqual(expectedValues);
    expect(result.values['auto_tag']).toBe('autogen'); // computed resolved
    expect(result.values['vault_purpose']).toBe('research'); // prefill wins
    expect(result.selections).toEqual(defaultModuleSelections(confirmSchema));
  });

  it('does not submit before ENTER, even for a computed-default shard', async () => {
    // Computed defaults resolve synchronously (useMemo), so mounting the
    // gate must NOT auto-fire onComplete via an effect-driven re-render of
    // the Select. Guards the stale-closure / spurious-fire race.
    const onComplete = vi.fn();
    const { lastFrame } = await mount(
      <AdoptValuesGate {...gateProps({ onComplete })} />, // confirmSchema has a computed default
    );
    await waitFor(lastFrame, (f) => f.includes('Use these values'));
    await tick(60); // give any stray effect a chance to fire
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('double ENTER on "Use these values" fires onComplete exactly once', async () => {
    // firedRef guard — Select can re-fire on Ink re-focus; a double-fire
    // would advance the adopt machine twice (CollisionReview/DiffView defense).
    const onComplete = vi.fn();
    const { stdin, lastFrame } = await mount(
      <AdoptValuesGate {...gateProps({ onComplete })} />,
    );
    await waitFor(lastFrame, (f) => f.includes('Use these values'));
    stdin.write(ENTER);
    await waitForCall(onComplete);
    // A second ENTER after the first selection is processed must not
    // re-fire — the component is not unmounted in-test (the machine would
    // do that in production), so this isolates the firedRef guard.
    stdin.write(ENTER);
    await tick(60);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('"Override individually" → drops into the InstallWizard', async () => {
    const { stdin, lastFrame } = await mount(<AdoptValuesGate {...gateProps()} />);
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
      <AdoptValuesGate {...gateProps({ onCancel })} />,
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

  it('optional value with no default → stays on the confirm page, no misleading provenance', async () => {
    // Regression for the over-broad blocking predicate: only *required*
    // no-default-no-prefill values force the wizard. An optional unset value
    // confirms fine (it renders as "(unset)" with no provenance label —
    // "(default)" there would be a lie).
    const optionalUnsetSchema: ShardSchema = {
      ...confirmSchema,
      values: {
        user_name: { type: 'string', message: 'Your name', default: 'Ada', group: 'g' },
        nickname: { type: 'string', message: 'Nickname', group: 'g' }, // optional, no default
      },
    };
    const { lastFrame } = await mount(
      <AdoptValuesGate {...gateProps({ schema: optionalUnsetSchema })} />,
    );
    await waitFor(lastFrame, (f) => f.includes('Use these values'));
    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/user_name:\s+Ada\s+\(default\)/);
    // Unset optional value: shown, but with no provenance label.
    expect(frame).toMatch(/nickname:\s+\(unset\)/);
    expect(frame).not.toMatch(/nickname:[^\n]*\(default\)/);
  });

  it('required value with no default and no prefill → opens directly in override (no confirm page)', async () => {
    const requiredSchema: ShardSchema = {
      ...confirmSchema,
      values: {
        token: { type: 'string', required: true, message: 'API token', group: 'g' },
      },
    };
    const { lastFrame } = await mount(
      <AdoptValuesGate {...gateProps({ schema: requiredSchema })} />,
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
    await mount(<AdoptValuesGate {...gateProps({ schema: badSchema, onError })} />);
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
      <AdoptValuesGate {...gateProps({ schema: emptyValuesSchema, onComplete })} />,
    );
    await waitFor(lastFrame, (f) => f.includes('declares no values'));
    stdin.write(ENTER);
    await waitForCall(onComplete);
    const result = onComplete.mock.calls[0]![0] as { values: Record<string, unknown> };
    expect(result.values).toEqual({});
  });
});
