/**
 * ShardMind Runtime Module
 *
 * Thin export (~30KB) for hook scripts. Zero dependency on Ink, React, or Pastel.
 * See docs/IMPLEMENTATION.md §5 and docs/ARCHITECTURE.md §18 for full API docs.
 *
 * Usage in hook scripts:
 *   import { loadValues, loadState, validateFrontmatter } from 'shardmind/runtime';
 */

export type {
  ShardSchema,
  ShardState,
  ShardManifest,
  ValueDefinition,
  ModuleDefinition,
  SignalDefinition,
  FrontmatterRule,
  ValidationResult,
  FrontmatterValidationResult,
  HookContext,
} from './types.js';

export { ShardMindError } from './types.js';

// Implementation stubs — replace with real implementations in Day 1-2

export async function loadValues(): Promise<Record<string, unknown>> {
  throw new Error('Not implemented yet — see docs/IMPLEMENTATION.md §5.2');
}

export async function loadSchema(): Promise<import('./types.js').ShardSchema> {
  throw new Error('Not implemented yet — see docs/IMPLEMENTATION.md §5.4');
}

export async function loadState(): Promise<import('./types.js').ShardState | null> {
  throw new Error('Not implemented yet — see docs/IMPLEMENTATION.md §5.3');
}

export async function getIncludedModules(): Promise<string[]> {
  throw new Error('Not implemented yet — see docs/IMPLEMENTATION.md §5.5');
}

export function validateValues(
  _values: Record<string, unknown>,
  _schema: import('./types.js').ShardSchema,
): import('./types.js').ValidationResult {
  throw new Error('Not implemented yet — see docs/IMPLEMENTATION.md §5.6');
}

export async function validateFrontmatter(
  _filePath: string,
  _content: string,
): Promise<import('./types.js').FrontmatterValidationResult> {
  throw new Error('Not implemented yet — see docs/IMPLEMENTATION.md §5.7');
}

export function resolveVaultRoot(): string {
  throw new Error('Not implemented yet — see docs/IMPLEMENTATION.md §5.1');
}
