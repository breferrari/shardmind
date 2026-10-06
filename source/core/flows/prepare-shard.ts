/**
 * A command's shard, fetched and parsed: the boot every command that
 * installs from a shard runs first (#302). Spec: docs/IMPLEMENTATION.md
 * §4.30 step 1.
 */

import type { ResolvedShard, ShardManifest, ShardSchema } from '../../runtime/types.js';
import { resolve as resolveRef } from '../registry.js';
import { downloadShard } from '../download.js';
import { parseManifest, assertEngineCompatible } from '../manifest.js';
import { parseSchema } from '../schema.js';

export interface PreparedShard {
  resolved: ResolvedShard;
  manifest: ShardManifest;
  schema: ShardSchema;
  tempDir: string;
  tarballSha256: string;
  /** Removes the downloaded shard; safe to call more than once. */
  cleanup: () => Promise<void>;
}

export interface PrepareShardOptions {
  command: 'install' | 'adopt';
  engineVersion: string | undefined;
  /** Each step's message ("Resolving …", "Downloading …", …). */
  onLoading: (message: string) => void;
  /** The temp dir's cleanup, handed over before the fetch (#57). */
  onCleanup: (cleanup: () => Promise<void>) => void;
}

/** Resolve, download, parse the manifest, check the engine range (#121), parse the schema. */
export async function prepareShard(ref: string, opts: PrepareShardOptions): Promise<PreparedShard> {
  opts.onLoading(`Resolving ${ref}…`);
  const resolved = await resolveRef(ref, { command: opts.command });

  opts.onLoading(`Downloading ${resolved.namespace}/${resolved.name}@${resolved.version}…`);
  // The cleanup is handed over before the fetch, so a Ctrl+C during the
  // download removes the temp dir too (#57).
  const temp = await downloadShard(resolved.tarballUrl, opts.onCleanup);

  opts.onLoading('Parsing manifest and schema…');
  const manifest = await parseManifest(temp.manifest);
  // Refused before any vault write if this engine can't satisfy the shard's
  // declared requires.shardmind range (#121).
  assertEngineCompatible(manifest, opts.engineVersion);
  const schema = await parseSchema(temp.schema);

  return {
    resolved,
    manifest,
    schema,
    tempDir: temp.tempDir,
    tarballSha256: temp.tarball_sha256,
    cleanup: temp.cleanup,
  };
}
