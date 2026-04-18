import { useState } from 'react';
import { Box, Text } from 'ink';
import { Select, TextInput, Alert, StatusMessage } from '@inkjs/ui';
import type { ShardState } from '../runtime/types.js';

export type GateChoice = 'update' | 'reinstall' | 'cancel';

interface ExistingInstallGateProps {
  state: ShardState;
  onChoice: (choice: GateChoice) => void;
}

type Screen = 'choose' | 'confirm-reinstall';

export default function ExistingInstallGate({ state, onChoice }: ExistingInstallGateProps) {
  const [screen, setScreen] = useState<Screen>('choose');
  const [error, setError] = useState<string | null>(null);

  if (screen === 'confirm-reinstall') {
    return (
      <Box flexDirection="column" gap={1}>
        <Alert variant="error">Reinstall will destroy your values and cached state</Alert>
        <Box flexDirection="column">
          <Text>This will permanently remove:</Text>
          <Text>  · .shardmind/ (engine state, cached templates, shard manifest)</Text>
          <Text>  · shard-values.yaml (your answered values — there is no backup)</Text>
          <Text dimColor>Rendered notes in your vault are not deleted, but may be overwritten on the new install.</Text>
        </Box>
        <Box flexDirection="column">
          <Text bold>Type REINSTALL to proceed:</Text>
          <TextInput
            placeholder="REINSTALL"
            onChange={() => {
              if (error) setError(null);
            }}
            onSubmit={(v) => {
              if (v.trim() === 'REINSTALL') {
                onChoice('reinstall');
              } else {
                setError('Exact text required. Press Esc or Ctrl+C to cancel.');
              }
            }}
          />
          {error && <StatusMessage variant="error">{error}</StatusMessage>}
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Alert variant="info">
        This vault already has a shard installed
      </Alert>

      <Box flexDirection="column">
        <Text>
          <Text bold>Shard:</Text> {state.shard}
          <Text dimColor> @ {state.version}</Text>
        </Text>
        <Text>
          <Text bold>Installed:</Text>
          <Text dimColor> {formatDate(state.installed_at)}</Text>
        </Text>
        <Text>
          <Text bold>Modules:</Text>
          <Text dimColor> {summarizeModules(state.modules)}</Text>
        </Text>
      </Box>

      <Box flexDirection="column">
        <Text bold>What would you like to do?</Text>
        <Select
          options={[
            { label: 'Keep the existing install (recommended — `shardmind update` arrives in Milestone 4)', value: 'update' },
            { label: 'Reinstall from scratch — destructive', value: 'reinstall' },
            { label: 'Cancel', value: 'cancel' },
          ]}
          onChange={(v) => {
            const choice = v as GateChoice;
            if (choice === 'reinstall') {
              setScreen('confirm-reinstall');
            } else {
              onChoice(choice);
            }
          }}
        />
      </Box>
    </Box>
  );
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  } catch {
    return iso;
  }
}

function summarizeModules(modules: Record<string, 'included' | 'excluded'>): string {
  const entries = Object.entries(modules);
  const included = entries.filter(([, s]) => s === 'included').length;
  return `${included} of ${entries.length} included`;
}
