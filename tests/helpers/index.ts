/**
 * Barrel export for test helpers. Import from `tests/helpers` — never
 * reach into individual files — so the surface area of shared scaffolding
 * stays small and discoverable.
 */

export { makeShardState, makeFileState } from './shard-state.js';
