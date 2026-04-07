/**
 * ShardMind shared types.
 * Imported by both CLI and runtime module.
 * See docs/IMPLEMENTATION.md §5, docs/ARCHITECTURE.md §18 for full documentation.
 */

export interface ShardManifest {
  apiVersion: 'v1';
  name: string;
  namespace: string;
  version: string;
  description?: string;
  persona?: string;
  license?: string;
  homepage?: string;
  requires?: {
    obsidian?: string;
    node?: string;
  };
  dependencies: ShardDependency[];
  hooks: {
    'post-install'?: string;
    'post-update'?: string;
  };
}

export interface ShardDependency {
  name: string;
  namespace: string;
  version: string;
}

export interface ShardSchema {
  schema_version: number;
  values: Record<string, ValueDefinition>;
  groups: GroupDefinition[];
  modules: Record<string, ModuleDefinition>;
  signals: SignalDefinition[];
  frontmatter: Record<string, FrontmatterRule>;
  migrations: Migration[];
}

export interface ValueDefinition {
  type: 'string' | 'boolean' | 'number' | 'select' | 'multiselect' | 'list';
  required?: boolean;
  message: string;
  default?: unknown;
  options?: Array<{ value: string; label: string; description?: string }>;
  min?: number;
  max?: number;
  group: string;
  hint?: string;
  placeholder?: string;
}

export interface GroupDefinition {
  id: string;
  label: string;
  description?: string;
}

export interface ModuleDefinition {
  label: string;
  paths: string[];
  partials?: string[];
  commands?: string[];
  agents?: string[];
  bases?: string[];
  removable: boolean;
}

export interface SignalDefinition {
  id: string;
  description: string;
  routes_to: string;
  core?: boolean;
  module?: string;
}

export interface FrontmatterRule {
  required?: string[];
  path_match?: string;
}

export interface Migration {
  from_version: string;
  changes: MigrationChange[];
}

export type MigrationChange =
  | { type: 'rename'; old: string; new: string }
  | { type: 'added'; key: string; default: unknown }
  | { type: 'removed'; key: string }
  | { type: 'type_changed'; key: string; from: string; to: string; transform: string };

export interface ShardState {
  schema_version: number;
  shard: string;
  source: string;
  version: string;
  installed_at: string;
  updated_at: string;
  values_hash: string;
  modules: Record<string, 'included' | 'excluded'>;
  files: Record<string, FileState>;
}

export interface FileState {
  template: string | null;
  rendered_hash: string;
  ownership: 'managed' | 'modified' | 'user';
  iterator_key?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: Array<{ path: string; message: string }>;
}

export interface FrontmatterValidationResult {
  valid: boolean;
  noteType: string | null;
  missing: string[];
  extra: string[];
}

export interface ResolvedShard {
  namespace: string;
  name: string;
  version: string;
  source: string;
  tarballUrl: string;
}

export interface TempShard {
  tempDir: string;
  manifest: string;
  schema: string;
  cleanup: () => Promise<void>;
}

export interface ModuleResolution {
  render: FileEntry[];
  copy: FileEntry[];
  skip: FileEntry[];
}

export interface FileEntry {
  sourcePath: string;
  outputPath: string;
  module: string | null;
  volatile: boolean;
  iterator: string | null;
}

export interface RenderedFile {
  outputPath: string;
  content: string;
  hash: string;
  volatile: boolean;
}

export interface RenderContext {
  values: Record<string, unknown>;
  included_modules: string[];
  shard: { name: string; version: string };
  install_date: string;
  year: string;
}

export interface DriftReport {
  managed: DriftEntry[];
  modified: DriftEntry[];
  volatile: DriftEntry[];
  missing: DriftEntry[];
  orphaned: string[];
}

export interface DriftEntry {
  path: string;
  template: string | null;
  renderedHash: string;
  actualHash: string | null;
  ownership: 'managed' | 'modified' | 'volatile';
}

export type MergeAction =
  | { type: 'skip'; reason: string }
  | { type: 'overwrite'; content: string }
  | { type: 'auto_merge'; content: string; stats: MergeStats }
  | { type: 'conflict'; result: MergeResult };

export interface MergeStats {
  linesUnchanged: number;
  linesAutoMerged: number;
}

export interface MergeResult {
  content: string;
  hasConflicts: boolean;
  conflicts: ConflictRegion[];
  stats: {
    linesUnchanged: number;
    linesAutoMerged: number;
    linesConflicted: number;
  };
}

export interface ConflictRegion {
  lineStart: number;
  lineEnd: number;
  base: string;
  theirs: string;
  ours: string;
}

export interface MigrationResult {
  values: Record<string, unknown>;
  applied: MigrationChange[];
  warnings: string[];
}

export interface HookContext {
  vaultRoot: string;
  values: Record<string, unknown>;
  modules: Record<string, 'included' | 'excluded'>;
  shard: { name: string; version: string };
  previousVersion?: string;
}

export class ShardMindError extends Error {
  constructor(
    message: string,
    public code: string,
    public hint?: string,
  ) {
    super(message);
    this.name = 'ShardMindError';
  }
}
