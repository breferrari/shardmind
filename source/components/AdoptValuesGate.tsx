import { useState, useMemo, useEffect, useRef } from 'react';
import { Box, Text } from 'ink';
import { Select } from './ui.js';
import type { ShardManifest, ShardSchema } from '../runtime/types.js';
import Header from './Header.js';
import InstallWizard, { type WizardResult, formatValue } from './InstallWizard.js';
import {
  mergePrefill,
  missingValueKeys,
  resolveComputedDefaults,
  defaultModuleSelections,
} from '../core/install-planner.js';
import { isComputedDefault } from '../core/schema.js';

/**
 * Adopt's value-collection gate (#104).
 *
 * Install interrogates a clean target step-by-step; adopt's user already
 * *has* a populated vault, so opening with the full `InstallWizard` reads
 * as a fresh-install flow shoehorned onto a retrofit. Instead, adopt opens
 * on a single page that surfaces the exact values that will drive
 * classification (`adopt-planner.ts::classifyAdoption` renders the shard's
 * `.njk` against them) — resolved defaults, computed defaults, and any
 * `--values` prefill, each labelled with its provenance — and lets the user
 * accept them in one keystroke or drop into the wizard to edit.
 *
 * "Override individually" reuses `InstallWizard` verbatim rather than
 * forking the value-iteration / computed-preview / module-review logic.
 *
 * The `--yes` / `--values` non-interactive paths never reach this component
 * (the machine resolves values directly), so they are unchanged.
 */
interface AdoptValuesGateProps {
  manifest: ShardManifest;
  schema: ShardSchema;
  /** Raw `--values` prefill (pre-merge), used for provenance + override seed. */
  prefillValues: Record<string, unknown>;
  onComplete: (result: WizardResult) => void;
  onCancel: () => void;
  onError: (err: Error) => void;
}

type Provenance = 'from --values' | 'computed' | 'default';

export default function AdoptValuesGate({
  manifest,
  schema,
  prefillValues,
  onComplete,
  onCancel,
  onError,
}: AdoptValuesGateProps) {
  const merged = useMemo(
    () => mergePrefill(schema, prefillValues),
    [schema, prefillValues],
  );

  // Required values with no default and not supplied via `--values`: there
  // is no confident "use these" set to confirm, so fall straight through to
  // the per-value wizard (adopt's pre-#104 behaviour for this shard shape).
  // `missingValueKeys` is fed the *merged* map (literal defaults filled),
  // exactly as the `--yes` path does (`use-adopt-machine.ts::runNonInteractive`)
  // — feeding it the raw prefill would flag every default-bearing key as
  // "missing" and wrongly force override for the common all-defaults shard.
  const hasMissingRequired = useMemo(
    () => missingValueKeys(schema, merged).length > 0,
    [schema, merged],
  );

  const [mode, setMode] = useState<'confirm' | 'override'>(
    hasMissingRequired ? 'override' : 'confirm',
  );

  // Resolve computed defaults *synchronously* so the confirm page — and the
  // "Use these values" action that reads `resolved` — never observe a
  // pre-resolution frame. An effect-based setState would leave a window
  // where a fast ENTER submits unresolved values (computed keys still
  // absent), and the re-render would re-fire the live Select. Skipped in
  // override mode: the wizard resolves computed defaults itself after
  // collecting values. Errors are surfaced from an effect below, not here,
  // to keep the onError call (a parent setState) off the render path.
  const { values: resolved, error: resolveError } = useMemo(
    (): { values: Record<string, unknown>; error: Error | null } => {
      if (hasMissingRequired) return { values: merged, error: null };
      try {
        return { values: resolveComputedDefaults(schema, merged), error: null };
      } catch (err) {
        return { values: merged, error: err as Error };
      }
    },
    [schema, merged, hasMissingRequired],
  );

  useEffect(() => {
    if (resolveError) onError(resolveError);
  }, [resolveError, onError]);

  // `Select` can fire onChange more than once if Ink re-focuses the
  // instance (see CollisionReview / DiffView). Every branch is a one-shot
  // decision, so guard all of them against a double-fire that would advance
  // the adopt machine twice.
  const firedRef = useRef(false);

  if (mode === 'override') {
    return (
      <InstallWizard
        manifest={manifest}
        schema={schema}
        prefillValues={prefillValues}
        // Adopt has no "X files would be installed" guess at this point —
        // the planner needs values first. Zero counts keep ModuleReview
        // rendering cleanly; the Summary shows real bucket counts at the end.
        moduleFileCounts={Object.fromEntries(
          Object.keys(schema.modules).map((id) => [id, 0]),
        )}
        alwaysIncludedFileCount={0}
        onComplete={onComplete}
        onCancel={onCancel}
        onError={onError}
      />
    );
  }

  const moduleCount = Object.keys(schema.modules).length;
  const valueKeys = Object.keys(schema.values);

  return (
    <Box flexDirection="column" gap={1}>
      <Header manifest={manifest} />

      <Text>These values will be used to compare the shard against your vault:</Text>

      <Box flexDirection="column">
        {valueKeys.length === 0 ? (
          <Text dimColor>  (this shard declares no values)</Text>
        ) : (
          valueKeys.map((key) => (
            <Text key={key}>
              <Text>  {key}: </Text>
              <Text color="cyan">{formatValue(resolved[key])}</Text>
              <Text dimColor>  ({provenanceOf(key, schema, prefillValues)})</Text>
            </Text>
          ))
        )}
      </Box>

      <Text dimColor>
        Modules: all {moduleCount} included (override to customize)
      </Text>

      <Select
        options={[
          { label: 'Use these values', value: 'use' },
          { label: 'Override individually', value: 'override' },
          { label: 'Cancel', value: 'cancel' },
        ]}
        onChange={(v) => {
          if (firedRef.current) return;
          firedRef.current = true;
          if (v === 'use') {
            onComplete({
              values: resolved,
              selections: defaultModuleSelections(schema),
            });
          } else if (v === 'override') {
            setMode('override');
          } else {
            onCancel();
          }
        }}
      />
    </Box>
  );
}

function provenanceOf(
  key: string,
  schema: ShardSchema,
  prefillValues: Record<string, unknown>,
): Provenance {
  if (Object.prototype.hasOwnProperty.call(prefillValues, key)) return 'from --values';
  const def = schema.values[key];
  if (def && def.default !== undefined && isComputedDefault(def.default)) {
    return 'computed';
  }
  return 'default';
}
