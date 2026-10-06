/**
 * `shardmind adopt --json` runs headless (#302): its failure documents,
 * which need no shard. The plan document is covered end to end by the
 * json e2e suites.
 */

import { describe, it, expect } from 'vitest';
import { runAdoptJson } from '../../source/commands/headless/adopt.js';

async function run(argv: string[]) {
  let out = '';
  const code = await runAdoptJson(argv, '0.0.0-test', (chunk) => {
    out += chunk;
  });
  return { code, doc: JSON.parse(out) as Record<string, unknown> };
}

describe('runAdoptJson (#302)', () => {
  it('a flag adopt does not take is ARGS_INVALID, exit 1', async () => {
    const { code, doc } = await run(['github:a/b', '--json', '--dry-run', '--nope']);
    expect(code).toBe(1);
    // Commander's own message, suggestion included, as the run without --json prints.
    expect(doc).toMatchObject({ ok: false, command: 'adopt', error: { code: 'ARGS_INVALID', message: expect.stringMatching(/^error: unknown option '--nope'/) } });
  });

  it('a value outside --mode’s choices is ARGS_INVALID, as without --json', async () => {
    const { doc } = await run(['github:a/b', '--json', '--dry-run', '--mode', 'sideways']);
    expect(doc).toMatchObject({ ok: false, error: { code: 'ARGS_INVALID' } });
  });

  it('--json without --dry-run is JSON_REQUIRES_DRY_RUN, before any network', async () => {
    const { code, doc } = await run(['github:a/b', '--json']);
    expect(code).toBe(1);
    expect(doc).toMatchObject({ ok: false, command: 'adopt', error: { code: 'JSON_REQUIRES_DRY_RUN' } });
  });
});
