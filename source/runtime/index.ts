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
  ErrorCode,
} from './types.js';

export { ShardMindError } from './types.js';

export { resolveVaultRoot, loadState, getIncludedModules } from './state.js';
export { loadValues, validateValues } from './values.js';
export { loadSchema } from './schema.js';
export { validateFrontmatter } from './frontmatter.js';
