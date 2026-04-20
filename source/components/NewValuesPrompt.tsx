import { useState, useMemo, useRef } from 'react';
import { Box, Text } from 'ink';
import ValueInput from './ValueInput.js';
import type { ShardSchema } from '../runtime/types.js';

interface NewValuesPromptProps {
  schema: ShardSchema;
  keys: string[];
  existingValues: Record<string, unknown>;
  onComplete: (collected: Record<string, unknown>) => void;
}

/**
 * Asks only for value keys the migration couldn't fill in. Mirrors the
 * shape of the install wizard's value phase but without the header,
 * computed-preview, and confirm steps — those belong to install's
 * first-run ceremony, not an update.
 *
 * `ValueInput` remounts per step because it is keyed on `id` internally,
 * so its input state resets cleanly between questions. `completedRef`
 * guards against a re-entrant submit that would fire `onComplete` twice.
 */
export default function NewValuesPrompt({
  schema,
  keys,
  existingValues,
  onComplete,
}: NewValuesPromptProps) {
  const defs = useMemo(
    () => keys.map((k) => [k, schema.values[k]!] as const),
    [keys, schema.values],
  );
  const [index, setIndex] = useState(0);
  const [values, setValues] = useState<Record<string, unknown>>(existingValues);
  const completedRef = useRef(false);

  const entry = defs[index];
  if (!entry) return null;

  const [key, def] = entry;
  // Prefer the human-readable group label from the schema (e.g.
  // "Onboarding") over the raw group id ("onboarding"). Keeps the UX
  // consistent with InstallWizard, which does the same lookup.
  const groupLabel = def.group
    ? schema.groups.find(g => g.id === def.group)?.label ?? def.group
    : null;
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>New values since your last install</Text>
      <Text dimColor>
        Step {index + 1} of {defs.length}
        {groupLabel ? ` · ${groupLabel}` : ''}
      </Text>
      <ValueInput
        id={key}
        def={def}
        initialValue={values[key]}
        onSubmit={(v) => {
          if (completedRef.current) return;
          const next = { ...values, [key]: v };
          if (index + 1 >= defs.length) {
            completedRef.current = true;
            onComplete(next);
            return;
          }
          setValues(next);
          setIndex(index + 1);
        }}
      />
    </Box>
  );
}
