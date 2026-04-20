/**
 * Unit tests for the pure update-machine entry points.
 *
 * The boot logic (`readState` → throw if null → `resolveRef` wrapped with
 * update-audience hints) is extracted from `use-update-machine.ts` as
 * `throwNoInstall`, `resolveRefForUpdate`, and `lookupUpdateTarget` so the
 * typed-error contract can be exercised without mounting an Ink tree. E2E
 * scenarios cover the same paths through the CLI subprocess; these tests
 * give refactor safety at the module layer — a logic-only regression that
 * happens to not surface end-to-end still trips here.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  lookupUpdateTarget,
  resolveRefForUpdate,
} from '../../source/commands/hooks/use-update-machine.js';
import { ShardMindError } from '../../source/runtime/types.js';
import { SHARDMIND_DIR, STATE_FILE } from '../../source/runtime/vault-paths.js';
import { makeShardState } from '../helpers/index.js';

describe('lookupUpdateTarget', () => {
  let vault: string;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    vault = path.join(os.tmpdir(), `shardmind-lookup-${crypto.randomUUID()}`);
    await fsp.mkdir(vault, { recursive: true });
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await fsp.rm(vault, { recursive: true, force: true });
  });

  it('throws UPDATE_NO_INSTALL when no .shardmind/state.json exists', async () => {
    const err = await lookupUpdateTarget(vault).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShardMindError);
    expect((err as ShardMindError).code).toBe('UPDATE_NO_INSTALL');
    expect((err as ShardMindError).hint).toContain('shardmind install');
  });

  it('throws UPDATE_SOURCE_MISMATCH when state.source is malformed', async () => {
    await fsp.mkdir(path.join(vault, SHARDMIND_DIR), { recursive: true });
    const state = makeShardState({ source: 'not-a-valid-ref-shape' });
    await fsp.writeFile(path.join(vault, STATE_FILE), JSON.stringify(state));

    const err = await lookupUpdateTarget(vault).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShardMindError);
    expect((err as ShardMindError).code).toBe('UPDATE_SOURCE_MISMATCH');
    // Hint embeds the malformed value + expected shape — both pieces matter.
    expect((err as ShardMindError).hint).toContain('not-a-valid-ref-shape');
    expect((err as ShardMindError).hint).toContain('namespace/name');
  });
});

describe('resolveRefForUpdate — error-hint rewriting', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('rewrites REGISTRY_INVALID_REF to UPDATE_SOURCE_MISMATCH with the source value in the hint', async () => {
    // resolveRef parses the ref before any network call, so fetch is unused.
    const err = await resolveRefForUpdate('BAD REF').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShardMindError);
    expect((err as ShardMindError).code).toBe('UPDATE_SOURCE_MISMATCH');
    expect((err as ShardMindError).hint).toContain('BAD REF');
  });

  it('keeps SHARD_NOT_FOUND but rewrites the hint for update audience', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ shards: {} }), { status: 200 }),
    ) as typeof fetch;

    const err = await resolveRefForUpdate('ghost/shard').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShardMindError);
    expect((err as ShardMindError).code).toBe('SHARD_NOT_FOUND');
    // Original install-path hint ("Check spelling...") must not surface.
    expect((err as ShardMindError).hint).not.toMatch(/check spelling/i);
    // Update-path hint points at state.json + the recorded source.
    expect((err as ShardMindError).hint).toContain('.shardmind/state.json');
    expect((err as ShardMindError).hint).toContain('ghost/shard');
  });

  it('VERSION_NOT_FOUND from a missing tarball gets the "transient / deleted tag" hint', async () => {
    // verifyTag branch: /releases/latest succeeds with a tag, then the
    // HEAD on the tarball 404s — the tag exists in the API but the
    // tarball is unreachable. "Retry in a minute" is the right hint.
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.endsWith('/releases/latest')) {
        return new Response(JSON.stringify({ tag_name: 'v1.0.0' }), { status: 200 });
      }
      if (init?.method === 'HEAD') return new Response(null, { status: 404 });
      throw new Error(`Unexpected fetch: ${u}`);
    }) as typeof fetch;

    const err = await resolveRefForUpdate('github:acme/widget').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShardMindError);
    expect((err as ShardMindError).code).toBe('VERSION_NOT_FOUND');
    // Original install-path hint ("Pick an available version...") must not surface.
    expect((err as ShardMindError).hint).not.toMatch(/pick an available version/i);
    // Update-path hint mentions transient GitHub state or deleted tag.
    expect((err as ShardMindError).hint).toMatch(/transient|deleted/i);
    // And NOT the "no published releases" hint — that's the other branch.
    expect((err as ShardMindError).hint).not.toMatch(/no published releases/i);
  });

  it('NO_RELEASES_PUBLISHED keeps its code but rewrites the install hint for update audience', async () => {
    // fetchLatestRelease branch: /releases/latest 404s — the upstream
    // repo has no releases at all. registry.ts emits NO_RELEASES_PUBLISHED
    // (a distinct code) so the update command can route on it reliably
    // without matching the message text. The update-audience hint avoids
    // the install-path "publish a GitHub release" wording (which assumes
    // the user controls the upstream) and the tarball-missing wording
    // (which doesn't fit — there is no tarball here).
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.endsWith('/releases/latest')) return new Response(null, { status: 404 });
      throw new Error(`Unexpected fetch: ${u}`);
    }) as typeof fetch;

    const err = await resolveRefForUpdate('github:acme/widget').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShardMindError);
    expect((err as ShardMindError).code).toBe('NO_RELEASES_PUBLISHED');
    // Install-path "publish a release" hint must not surface.
    expect((err as ShardMindError).hint).not.toMatch(/publish a GitHub release/i);
    // Update-path "no published releases" branch hint — and not the
    // tarball-missing hint.
    expect((err as ShardMindError).hint).toMatch(/no published releases/i);
    expect((err as ShardMindError).hint).not.toMatch(/transient/i);
  });

  it('passes REGISTRY_NETWORK through unchanged — hint is already context-agnostic', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('network offline');
    }) as typeof fetch;

    const err = await resolveRefForUpdate('breferrari/obsidian-mind').catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ShardMindError);
    expect((err as ShardMindError).code).toBe('REGISTRY_NETWORK');
    // Hint is the original from registry.ts — no update-path rewrite.
    expect((err as ShardMindError).hint).not.toContain('.shardmind/state.json');
  });

  it('returns the ResolvedShard when resolution succeeds', async () => {
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.endsWith('/releases/latest')) {
        return new Response(JSON.stringify({ tag_name: 'v3.5.0' }), { status: 200 });
      }
      if (init?.method === 'HEAD') return new Response(null, { status: 200 });
      throw new Error(`Unexpected fetch: ${u}`);
    }) as typeof fetch;

    const result = await resolveRefForUpdate('github:breferrari/obsidian-mind');
    expect(result.version).toBe('3.5.0');
    expect(result.source).toBe('github:breferrari/obsidian-mind');
  });
});
