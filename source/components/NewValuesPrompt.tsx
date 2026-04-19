import { useState, useMemo, useEffect } from 'react';
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
 */
export default function NewValuesPrompt({
  schema,
  keys,
  existingValues,
  onComplete,
}: NewValuesPromptProps) {
  const [index, setIndex] = useState(0);
  const [values, setValues] = useState<Record<string, unknown>>(existingValues);

  const defs = useMemo(
    () => keys.map((k) => [k, schema.values[k]!] as const),
    [keys, schema.values],
  );

  const done = index >= defs.length;
  useEffect(() => {
    if (done) onComplete(values);
    // One-shot: we only want to fire once when we cross into "done".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done]);

  if (done) return null;

  const [key, def] = defs[index]!;
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>New values since your last install</Text>
      <Text dimColor>
        Step {index + 1} of {defs.length}
        {def.group ? ` · ${def.group}` : ''}
      </Text>
      <ValueInput
        id={key}
        def={def}
        initialValue={values[key]}
        onSubmit={(v) => {
          const next = { ...values, [key]: v };
          setValues(next);
          setIndex((i) => i + 1);
        }}
      />
    </Box>
  );
}
