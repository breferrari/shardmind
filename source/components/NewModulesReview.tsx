import { useState } from 'react';
import { Box, Text } from 'ink';
import { MultiSelect, Select } from './ui.js';
import type { ModuleDefinition } from '../runtime/types.js';

interface NewModulesReviewProps {
  offered: Array<{ id: string; def: ModuleDefinition }>;
  onSubmit: (choices: Record<string, 'included' | 'excluded'>) => void;
}

/**
 * Offers modules that exist in the new shard but weren't present at
 * install time. Default = all included; users can uncheck any they want
 * to stay opted out of.
 */
export default function NewModulesReview({ offered, onSubmit }: NewModulesReviewProps) {
  const [selected, setSelected] = useState<string[]>(offered.map((m) => m.id));

  if (offered.length === 0) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text>No new modules in this update.</Text>
        <Select
          options={[{ label: 'Continue', value: 'continue' }]}
          onChange={() => onSubmit({})}
        />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>New modules offered</Text>
      <Text dimColor>Space to toggle, Enter to confirm. All included by default.</Text>
      <MultiSelect
        options={offered.map((m) => ({ label: `${m.def.label ?? m.id}`, value: m.id }))}
        defaultValue={selected}
        onChange={(next) => setSelected(next)}
        onSubmit={(next) => {
          const choices: Record<string, 'included' | 'excluded'> = {};
          for (const { id } of offered) {
            choices[id] = next.includes(id) ? 'included' : 'excluded';
          }
          onSubmit(choices);
        }}
      />
    </Box>
  );
}
