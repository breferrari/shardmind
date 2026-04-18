import { useState, useMemo, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { Select } from './ui.js';
import type { ShardManifest, ShardSchema, ValueDefinition, ModuleSelections } from '../runtime/types.js';
import Header from './Header.js';
import ValueInput from './ValueInput.js';
import ModuleReview from './ModuleReview.js';
import {
  missingValueKeys,
  resolveComputedDefaults,
  defaultModuleSelections,
} from '../core/install-planner.js';
import { isComputedDefault } from '../core/schema.js';

export interface WizardResult {
  values: Record<string, unknown>;
  selections: ModuleSelections;
}

interface InstallWizardProps {
  manifest: ShardManifest;
  schema: ShardSchema;
  prefillValues: Record<string, unknown>;
  moduleFileCounts: Record<string, number>;
  alwaysIncludedFileCount: number;
  onComplete: (result: WizardResult) => void;
  onCancel: () => void;
  onError: (err: Error) => void;
}

type Step =
  | { kind: 'header' }
  | { kind: 'value'; index: number }
  | { kind: 'computed-preview' }
  | { kind: 'modules' }
  | { kind: 'confirm' };

export default function InstallWizard({
  manifest,
  schema,
  prefillValues,
  moduleFileCounts,
  alwaysIncludedFileCount,
  onComplete,
  onCancel,
  onError,
}: InstallWizardProps) {
  const valueKeys = useMemo(
    () => missingValueKeys(schema, prefillValues),
    [schema, prefillValues],
  );
  const hasComputed = useMemo(() => hasComputedDefaults(schema), [schema]);

  const [step, setStep] = useState<Step>(() => {
    if (valueKeys.length > 0) return { kind: 'header' };
    if (hasComputed) return { kind: 'computed-preview' };
    return { kind: 'modules' };
  });
  const [values, setValues] = useState<Record<string, unknown>>(prefillValues);
  const [selections, setSelections] = useState<ModuleSelections>(
    () => defaultModuleSelections(schema),
  );
  const [resolvedValues, setResolvedValues] = useState<Record<string, unknown>>(prefillValues);

  // If we're opening directly into computed-preview, resolve on mount.
  // Using an effect keeps the useState initializer pure (no side effect)
  // and avoids React 18 strict-mode double-fire of onError.
  useEffect(() => {
    if (valueKeys.length === 0 && hasComputed) {
      try {
        setResolvedValues(resolveComputedDefaults(schema, prefillValues));
      } catch (err) {
        onError(err as Error);
      }
    }
    // Mount-only — schema/prefill don't change within a wizard session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useInput((_input, key) => {
    if (key.escape) {
      goBack();
    }
  });

  function goBack() {
    setStep((s) => {
      switch (s.kind) {
        case 'header':
          return s;
        case 'value':
          if (s.index === 0) return { kind: 'header' };
          return { kind: 'value', index: s.index - 1 };
        case 'computed-preview':
          if (valueKeys.length === 0) return { kind: 'header' };
          return { kind: 'value', index: valueKeys.length - 1 };
        case 'modules':
          if (hasComputed) return { kind: 'computed-preview' };
          if (valueKeys.length === 0) return { kind: 'header' };
          return { kind: 'value', index: valueKeys.length - 1 };
        case 'confirm':
          return { kind: 'modules' };
      }
    });
  }

  function submitValue(key: string, value: unknown) {
    const nextValues = { ...values, [key]: value };
    setValues(nextValues);

    const currentIndex = step.kind === 'value' ? step.index : -1;
    if (currentIndex === -1) return;
    if (currentIndex + 1 < valueKeys.length) {
      setStep({ kind: 'value', index: currentIndex + 1 });
      return;
    }

    try {
      const resolved = resolveComputedDefaults(schema, nextValues);
      setResolvedValues(resolved);
      setStep(hasComputed ? { kind: 'computed-preview' } : { kind: 'modules' });
    } catch (err) {
      onError(err as Error);
    }
  }

  function submitSelections(next: ModuleSelections) {
    setSelections(next);
    setStep({ kind: 'confirm' });
  }

  function submitConfirm(choice: 'install' | 'back' | 'cancel') {
    if (choice === 'install') {
      onComplete({ values: resolvedValues, selections });
    } else if (choice === 'back') {
      setStep({ kind: 'modules' });
    } else {
      onCancel();
    }
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Header manifest={manifest} />

      {step.kind === 'header' && (
        <HeaderStep
          missingValueCount={valueKeys.length}
          onContinue={() => {
            if (valueKeys.length > 0) {
              setStep({ kind: 'value', index: 0 });
              return;
            }
            if (hasComputed) {
              try {
                setResolvedValues(resolveComputedDefaults(schema, values));
                setStep({ kind: 'computed-preview' });
              } catch (err) {
                onError(err as Error);
              }
              return;
            }
            setStep({ kind: 'modules' });
          }}
        />
      )}

      {step.kind === 'value' && (() => {
        const key = valueKeys[step.index]!;
        const def = schema.values[key]!;
        return (
          <Box flexDirection="column">
            <Text dimColor>
              Step {step.index + 1} of {valueKeys.length}
              {def.group && schema.groups.find((g) => g.id === def.group)
                ? ` · ${schema.groups.find((g) => g.id === def.group)!.label}`
                : ''}
            </Text>
            <ValueInput
              id={key}
              def={def}
              initialValue={values[key]}
              onSubmit={(v) => submitValue(key, v)}
            />
          </Box>
        );
      })()}

      {step.kind === 'computed-preview' && (
        <ComputedPreview
          schema={schema}
          resolved={resolvedValues}
          onContinue={() => setStep({ kind: 'modules' })}
        />
      )}

      {step.kind === 'modules' && (
        <ModuleReview
          modules={schema.modules}
          moduleFileCounts={moduleFileCounts}
          alwaysIncludedFileCount={alwaysIncludedFileCount}
          initialSelections={selections}
          onSubmit={submitSelections}
        />
      )}

      {step.kind === 'confirm' && (
        <ConfirmStep
          manifest={manifest}
          values={resolvedValues}
          selections={selections}
          schemaValues={schema.values}
          onChoice={submitConfirm}
        />
      )}
    </Box>
  );
}

function hasComputedDefaults(schema: ShardSchema): boolean {
  return Object.values(schema.values).some(
    (def) => def.default !== undefined && isComputedDefault(def.default),
  );
}

function HeaderStep({
  missingValueCount,
  onContinue,
}: {
  missingValueCount: number;
  onContinue: () => void;
}) {
  return (
    <Box flexDirection="column" gap={1}>
      <Text>
        {missingValueCount === 0
          ? 'Pre-fill complete. Ready to review modules.'
          : `${missingValueCount} question${missingValueCount === 1 ? '' : 's'} to answer, then module review.`}
      </Text>
      <Select
        options={[{ label: 'Start', value: 'start' }]}
        onChange={() => onContinue()}
      />
    </Box>
  );
}

function ComputedPreview({
  schema,
  resolved,
  onContinue,
}: {
  schema: ShardSchema;
  resolved: Record<string, unknown>;
  onContinue: () => void;
}) {
  const computed = Object.entries(schema.values).filter(
    ([, def]) => def.default !== undefined && isComputedDefault(def.default),
  );

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Auto-filled values</Text>
      {computed.map(([key, def]) => (
        <Box key={key} flexDirection="column">
          <Text>
            <Text bold>{key}</Text>
            <Text>: </Text>
            <Text color="cyan">{formatValue(resolved[key])}</Text>
          </Text>
          <Text dimColor>  expression: {String(def.default)}</Text>
        </Box>
      ))}
      <Select options={[{ label: 'Continue', value: 'continue' }]} onChange={() => onContinue()} />
    </Box>
  );
}

function ConfirmStep({
  manifest,
  values,
  selections,
  schemaValues,
  onChoice,
}: {
  manifest: ShardManifest;
  values: Record<string, unknown>;
  selections: ModuleSelections;
  schemaValues: Record<string, ValueDefinition>;
  onChoice: (c: 'install' | 'back' | 'cancel') => void;
}) {
  const included = Object.entries(selections).filter(([, s]) => s === 'included').map(([id]) => id);
  const excluded = Object.entries(selections).filter(([, s]) => s === 'excluded').map(([id]) => id);

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Ready to install</Text>

      <Box flexDirection="column">
        <Text dimColor>Shard:</Text>
        <Text>  {manifest.namespace}/{manifest.name}@{manifest.version}</Text>
      </Box>

      <Box flexDirection="column">
        <Text dimColor>Values:</Text>
        {Object.keys(schemaValues).map((key) => (
          <Text key={key}>
            <Text>  {key}: </Text>
            <Text color="cyan">{formatValue(values[key])}</Text>
          </Text>
        ))}
      </Box>

      <Box flexDirection="column">
        <Text dimColor>Modules included ({included.length}):</Text>
        <Text>  {included.join(', ') || '(none)'}</Text>
        {excluded.length > 0 && (
          <>
            <Text dimColor>Modules excluded ({excluded.length}):</Text>
            <Text>  {excluded.join(', ')}</Text>
          </>
        )}
      </Box>

      <Select
        options={[
          { label: 'Install', value: 'install' },
          { label: 'Back to module review', value: 'back' },
          { label: 'Cancel', value: 'cancel' },
        ]}
        onChange={(v) => onChoice(v as 'install' | 'back' | 'cancel')}
      />
    </Box>
  );
}

function formatValue(value: unknown): string {
  if (value === undefined) return '(unset)';
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return value.length === 0 ? '(empty)' : value.map(String).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
