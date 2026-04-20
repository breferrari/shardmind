import { useState, useRef } from 'react';
import { Box, Text } from 'ink';
import { Select, TextInput, Alert, StatusMessage } from './ui.js';
import type { ShardState, ModuleSelections } from '../runtime/types.js';

export type GateChoice = 'update' | 'reinstall' | 'cancel';

const GATE_CHOICES = new Set<GateChoice>(['update', 'reinstall', 'cancel']);

interface ExistingInstallGateProps {
  state: ShardState;
  onChoice: (choice: GateChoice) => void;
}

type Screen = 'choose' | 'confirm-reinstall';

export default function ExistingInstallGate({ state, onChoice }: ExistingInstallGateProps) {
  const [screen, setScreen] = useState<Screen>('choose');
  const [error, setError] = useState<string | null>(null);
  const lastSubmittedValue = useRef<string | null>(null);
  // Same `Select` double-fire guard as CollisionReview / DiffView:
  // without it, a second onChange firing of `update` or `cancel` would
  // call `onChoice` twice and the machine would transition twice.
  const firedRef = useRef(false);

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
            onChange={(v) => {
              // @inkjs/ui fires onChange on parent re-renders, which
              // would clear the error the same tick it's set. Compare
              // against lastSubmittedValue so we only clear once the
              // user actually types something new.
              // Upstream: vadimdemedes/ink-ui#26 (fix in PR #27).
              if (lastSubmittedValue.current !== null && v !== lastSubmittedValue.current) {
                lastSubmittedValue.current = null;
                setError(null);
              }
            }}
            onSubmit={(v) => {
              if (v === 'REINSTALL') {
                // Same firedRef guard as the Select path — TextInput
                // can fire onSubmit more than once on Ink re-focus,
                // and `reinstall` is destructive; a double-fire would
                // queue two wipes.
                if (firedRef.current) return;
                firedRef.current = true;
                onChoice('reinstall');
              } else {
                lastSubmittedValue.current = v;
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
            { label: 'Keep the existing install (run `shardmind update` to pick up new versions)', value: 'update' },
            { label: 'Reinstall from scratch — destructive', value: 'reinstall' },
            { label: 'Cancel', value: 'cancel' },
          ]}
          onChange={(v) => {
            if (!GATE_CHOICES.has(v as GateChoice)) return;
            const choice = v as GateChoice;
            if (choice === 'reinstall') {
              // Reinstall requires a second confirmation; don't arm
              // the firedRef until the user commits on the next screen.
              setScreen('confirm-reinstall');
              return;
            }
            if (firedRef.current) return;
            firedRef.current = true;
            onChoice(choice);
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

function summarizeModules(modules: ModuleSelections): string {
  const entries = Object.entries(modules);
  const included = entries.filter(([, s]) => s === 'included').length;
  return `${included} of ${entries.length} included`;
}
