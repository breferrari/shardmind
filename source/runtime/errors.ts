/**
 * Typed registry of every `ShardMindError.code` the engine can emit.
 *
 * Adding a new code: add a string literal to the union below, group it
 * under the right domain comment. The compiler will then refuse any
 * `new ShardMindError(msg, 'TYPO', hint)` across the whole codebase.
 *
 * Duplicate-looking codes (e.g. VALUES_NOT_FOUND vs VALUES_MISSING) are
 * intentional: one fires from the runtime layer (hook scripts), the
 * other from the commands layer (install machine). They're different
 * surfaces with different recovery hints. Unification is a separate
 * concern — see the design audit.
 */

export type ErrorCode =
  // Vault resolution
  | 'VAULT_NOT_FOUND'

  // Shard manifest (shard.yaml)
  | 'MANIFEST_NOT_FOUND'
  | 'MANIFEST_READ_FAILED'
  | 'MANIFEST_INVALID_YAML'
  | 'MANIFEST_VALIDATION_FAILED'

  // Shard schema (shard-schema.yaml)
  | 'SCHEMA_NOT_FOUND'
  | 'SCHEMA_READ_FAILED'
  | 'SCHEMA_INVALID_YAML'
  | 'SCHEMA_VALIDATION_FAILED'
  | 'SCHEMA_RESERVED_NAME'

  // Values file (shard-values.yaml)
  | 'VALUES_NOT_FOUND'
  | 'VALUES_READ_FAILED'
  | 'VALUES_INVALID'
  | 'VALUES_MISSING'
  | 'VALUES_FILE_READ_FAILED'
  | 'VALUES_FILE_INVALID'
  | 'VALUES_FILE_COLLISION'

  // Engine state (.shardmind/state.json)
  | 'STATE_READ_FAILED'
  | 'STATE_CORRUPT'
  | 'STATE_UNSUPPORTED_VERSION'
  | 'STATE_CACHE_MISSING_TEMPLATES'

  // Registry / download
  | 'SHARD_NOT_FOUND'
  | 'VERSION_NOT_FOUND'
  | 'REGISTRY_NETWORK'
  | 'REGISTRY_INVALID_REF'
  | 'REGISTRY_RATE_LIMITED'
  | 'DOWNLOAD_HTTP_ERROR'
  | 'DOWNLOAD_INVALID_TARBALL'
  | 'DOWNLOAD_MISSING_MANIFEST'
  | 'DOWNLOAD_MISSING_SCHEMA'

  // Templating / rendering
  | 'RENDER_TEMPLATE_ERROR'
  | 'RENDER_FRONTMATTER_ERROR'
  | 'RENDER_ITERATOR_ERROR'
  | 'RENDER_FAILED'

  // Install planner / executor
  | 'COMPUTED_DEFAULT_FAILED'
  | 'COMPUTED_DEFAULT_INVALID'
  | 'COLLISION_CHECK_FAILED'
  | 'BACKUP_FAILED'

  // Update / merge
  | 'MERGE_FAILED'
  | 'UPDATE_NO_INSTALL'
  | 'UPDATE_SOURCE_MISMATCH'
  | 'UPDATE_CACHE_MISSING'
  | 'UPDATE_WRITE_FAILED'
  | 'MIGRATION_INVALID_VERSION'
  | 'MIGRATION_TRANSFORM_FAILED'

  // Update-check cache (status command + update command share this)
  | 'UPDATE_CHECK_FAILED'
  | 'UPDATE_CHECK_CACHE_CORRUPT';
