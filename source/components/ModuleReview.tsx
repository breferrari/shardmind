import { useState, useMemo } from 'react';
import { Box, Text } from 'ink';
import { MultiSelect } from '@inkjs/ui';
import type { ModuleDefinition } from '../runtime/types.js';

interface ModuleReviewProps {
  modules: Record<string, ModuleDefinition>;
  moduleFileCounts: Record<string, number>;
  initialSelections: Record<string, 'included' | 'excluded'>;
  onSubmit: (selections: Record<string, 'included' | 'excluded'>) => void;
}

/**
 * Module multiselect. Non-removable modules are listed as always-on
 * above the checkbox group. Live "will install N files" total updates
 * as removable modules toggle.
 */
export default function ModuleReview({
  modules,
  moduleFileCounts,
  initialSelections,
  onSubmit,
}: ModuleReviewProps) {
  const [removable, locked] = useMemo(() => {
    const removable: Array<[string, ModuleDefinition]> = [];
    const locked: Array<[string, ModuleDefinition]> = [];
    for (const entry of Object.entries(modules)) {
      (entry[1].removable ? removable : locked).push(entry);
    }
    return [removable, locked];
  }, [modules]);

  const initiallyIncluded = useMemo(
    () =>
      removable
        .filter(([id]) => initialSelections[id] !== 'excluded')
        .map(([id]) => id),
    [removable, initialSelections],
  );

  const [currentIncluded, setCurrentIncluded] = useState<string[]>(initiallyIncluded);

  const totalFiles = useMemo(() => {
    let sum = 0;
    for (const [id] of locked) sum += moduleFileCounts[id] ?? 0;
    for (const id of currentIncluded) sum += moduleFileCounts[id] ?? 0;
    return sum;
  }, [locked, currentIncluded, moduleFileCounts]);

  const options = removable.map(([id, def]) => ({
    label: formatOption(id, def, moduleFileCounts[id] ?? 0),
    value: id,
  }));

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Choose modules to install</Text>

      {locked.length > 0 && (
        <Box flexDirection="column">
          <Text dimColor>Always included:</Text>
          {locked.map(([id, def]) => (
            <Text key={id}>
              <Text color="green">✓ </Text>
              <Text>{def.label ?? id}</Text>
              <Text dimColor> · {moduleFileCounts[id] ?? 0} files</Text>
            </Text>
          ))}
        </Box>
      )}

      {removable.length > 0 ? (
        <Box flexDirection="column">
          <Text dimColor>Optional (space to toggle, enter to confirm):</Text>
          <MultiSelect
            options={options}
            defaultValue={initiallyIncluded}
            onChange={(selected) => setCurrentIncluded(selected)}
            onSubmit={(selected) => {
              const next: Record<string, 'included' | 'excluded'> = {};
              for (const [id] of locked) next[id] = 'included';
              for (const [id] of removable) {
                next[id] = selected.includes(id) ? 'included' : 'excluded';
              }
              onSubmit(next);
            }}
          />
        </Box>
      ) : (
        <Text dimColor>No optional modules — all are always included.</Text>
      )}

      <Text>
        <Text bold>Will install:</Text> {totalFiles} file{totalFiles === 1 ? '' : 's'}
      </Text>
    </Box>
  );
}

function formatOption(id: string, def: ModuleDefinition, fileCount: number): string {
  const label = def.label ?? id;
  return `${label}  ·  ${fileCount} file${fileCount === 1 ? '' : 's'}`;
}
