import { useMemo, useState, type ReactElement } from 'react';
import { Box, Text } from 'ink';
import { TextInput, Select, ConfirmInput, StatusMessage } from './ui.js';
import type { ValueDefinition } from '../runtime/types.js';
import { assertNever } from '../runtime/types.js';

interface ValueInputProps {
  id: string;
  def: ValueDefinition;
  initialValue: unknown;
  onSubmit: (value: unknown) => void;
}

/**
 * Single value prompt. Renders the right input per `def.type`, shows the
 * question, hint, and inline validation. Caller passes an initialValue so
 * back-navigation re-enters with the previous answer.
 */
export default function ValueInput({ id, def, initialValue, onSubmit }: ValueInputProps) {
  const [error, setError] = useState<string | null>(null);

  const validate = useMemo(
    () => buildValidator(def),
    [def],
  );

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>{def.message}</Text>
        {def.required && <Text color="red"> *</Text>}
      </Box>

      {def.hint && <Text dimColor>{def.hint}</Text>}

      <Box marginTop={1}>
        {renderInput(id, def, initialValue, (value) => {
          const result = validate(value);
          if (result.ok) {
            setError(null);
            onSubmit(result.value);
          } else {
            setError(result.message);
          }
        })}
      </Box>

      {error && (
        <Box marginTop={1}>
          <StatusMessage variant="error">{error}</StatusMessage>
        </Box>
      )}
    </Box>
  );
}

function renderInput(
  id: string,
  def: ValueDefinition,
  initialValue: unknown,
  onSubmit: (value: unknown) => void,
): ReactElement {
  const key = `${id}-${def.type}`;

  switch (def.type) {
    case 'string': {
      const initial = typeof initialValue === 'string' ? initialValue : typeof def.default === 'string' ? def.default : '';
      return (
        <TextInput
          key={key}
          defaultValue={initial}
          placeholder={def.placeholder ?? ''}
          onSubmit={(v) => onSubmit(v)}
        />
      );
    }
    case 'number': {
      const initial =
        typeof initialValue === 'number'
          ? String(initialValue)
          : typeof def.default === 'number'
          ? String(def.default)
          : '';
      return (
        <TextInput
          key={key}
          defaultValue={initial}
          placeholder={def.placeholder ?? ''}
          onSubmit={(v) => onSubmit(v)}
        />
      );
    }
    case 'boolean': {
      const fallback = typeof def.default === 'boolean' ? def.default : false;
      const initial = typeof initialValue === 'boolean' ? initialValue : fallback;
      return (
        <ConfirmInput
          key={key}
          defaultChoice={initial ? 'confirm' : 'cancel'}
          onConfirm={() => onSubmit(true)}
          onCancel={() => onSubmit(false)}
        />
      );
    }
    case 'select': {
      const rawOptions = (def.options ?? []).map((o) => ({ label: o.label, value: o.value }));
      const initial = typeof initialValue === 'string'
        ? initialValue
        : typeof def.default === 'string'
        ? def.default
        : undefined;
      // @inkjs/ui's Select seeds previousValue===value when defaultValue
      // is set; on Enter the `previousValue !== value` change-fire guard
      // then fails for the focused (always first) option, freezing the
      // wizard. Drop defaultValue and reorder so `initial` is index 0
      // (where the cursor pre-positions). #103.
      const options = initial && rawOptions.some((o) => o.value === initial)
        ? [
            ...rawOptions.filter((o) => o.value === initial),
            ...rawOptions.filter((o) => o.value !== initial),
          ]
        : rawOptions;
      return (
        <Select
          key={key}
          options={options}
          onChange={(v) => onSubmit(v)}
        />
      );
    }
    case 'multiselect': {
      // Textual comma-separated fallback. Swapping in @inkjs/ui's
      // MultiSelect widget is v0.2 UX polish; no v0.1 shard uses
      // multiselect values, so this path is rarely exercised.
      const initial = Array.isArray(initialValue) ? (initialValue as string[]).join(', ') : '';
      return (
        <TextInput
          key={key}
          defaultValue={initial}
          placeholder="comma,separated,values"
          onSubmit={(v) => onSubmit(v.split(',').map((s) => s.trim()).filter(Boolean))}
        />
      );
    }
    case 'list': {
      const initial = Array.isArray(initialValue) ? (initialValue as string[]).join(', ') : '';
      return (
        <TextInput
          key={key}
          defaultValue={initial}
          placeholder="comma,separated,values"
          onSubmit={(v) => onSubmit(v.split(',').map((s) => s.trim()).filter(Boolean))}
        />
      );
    }
    default:
      return assertNever(def.type);
  }
}

type ValidationOutcome =
  | { ok: true; value: unknown }
  | { ok: false; message: string };

function buildValidator(def: ValueDefinition): (raw: unknown) => ValidationOutcome {
  return (raw: unknown): ValidationOutcome => {
    switch (def.type) {
      case 'string': {
        const str = typeof raw === 'string' ? raw : '';
        if (def.required && str.trim() === '') {
          return { ok: false, message: 'Required' };
        }
        return { ok: true, value: str };
      }
      case 'number': {
        const str = typeof raw === 'string' ? raw : String(raw ?? '');
        if (def.required && str.trim() === '') {
          return { ok: false, message: 'Required' };
        }
        const n = Number(str);
        if (!Number.isFinite(n)) {
          return { ok: false, message: 'Must be a number' };
        }
        if (def.min !== undefined && n < def.min) {
          return { ok: false, message: `Must be ≥ ${def.min}` };
        }
        if (def.max !== undefined && n > def.max) {
          return { ok: false, message: `Must be ≤ ${def.max}` };
        }
        return { ok: true, value: n };
      }
      case 'boolean':
        return { ok: true, value: Boolean(raw) };
      case 'select': {
        const allowed = new Set((def.options ?? []).map((o) => o.value));
        if (typeof raw !== 'string' || !allowed.has(raw)) {
          return { ok: false, message: 'Pick one of the options' };
        }
        return { ok: true, value: raw };
      }
      case 'multiselect': {
        if (!Array.isArray(raw)) {
          return { ok: false, message: 'Must be a list' };
        }
        if (def.required && raw.length === 0) {
          return { ok: false, message: 'At least one entry required' };
        }
        const allowed = new Set((def.options ?? []).map((o) => o.value));
        const invalid = raw.filter((v) => typeof v !== 'string' || !allowed.has(v));
        if (invalid.length > 0) {
          return {
            ok: false,
            message: `Unknown option${invalid.length === 1 ? '' : 's'}: ${invalid.map(String).join(', ')}`,
          };
        }
        return { ok: true, value: raw };
      }
      case 'list':
        if (!Array.isArray(raw)) {
          return { ok: false, message: 'Must be a list' };
        }
        if (def.required && raw.length === 0) {
          return { ok: false, message: 'At least one entry required' };
        }
        return { ok: true, value: raw };
      default:
        return assertNever(def.type);
    }
  };
}
