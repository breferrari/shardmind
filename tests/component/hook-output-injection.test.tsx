/**
 * Hook output is shard code, often third-party. Terminal control sequences it
 * prints must not reach the user's terminal through our components (#204).
 *
 * Ink 7 already drops some of them: its Text sanitizer strips non-SGR CSI
 * (cursor movement), and its output stage drops non-link OSC (OSC 52
 * clipboard writes, OSC 0 titles). Those stay here as regression cases, so a
 * change in Ink cannot reopen them. What reached the frame before #204: OSC 8
 * hyperlinks (link text pointing anywhere), a lone CR (overwrites the line),
 * BEL, BS, FF and VT.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import chalk from 'chalk';
import HookProgress from '../../source/components/HookProgress.js';
import HookSummarySection from '../../source/components/HookSummarySection.js';

const SEQUENCES = {
  'OSC 52 clipboard write': '\x1b]52;c;aGk=\x07',
  'OSC 0 title': '\x1b]0;pwned\x1b\\',
  'cursor-up': '\x1b[1A',
  'OSC 8 hyperlink open': '\x1b]8;;https://evil.example\x07',
  'OSC 8 hyperlink close': '\x1b]8;;\x07',
  BEL: '\x07',
  BS: '\x08',
  FF: '\x0c',
  VT: '\x0b',
};
const HOSTILE =
  `before ${SEQUENCES['OSC 52 clipboard write']}${SEQUENCES['OSC 0 title']}${SEQUENCES['cursor-up']}` +
  `${SEQUENCES['OSC 8 hyperlink open']}click${SEQUENCES['OSC 8 hyperlink close']}` +
  ` bell${SEQUENCES.BEL} bs${SEQUENCES.BS} ff${SEQUENCES.FF} vt${SEQUENCES.VT} after\n` +
  'progress 10%\rprogress 100%\n';

const saved = chalk.level;
afterEach(() => {
  chalk.level = saved;
  cleanup();
});

function expectClean(frame: string): void {
  expect(frame).toContain('before');
  expect(frame).toContain('click');
  expect(frame).toContain('after');
  for (const [name, bytes] of Object.entries(SEQUENCES)) {
    expect(frame, name).not.toContain(bytes);
  }
  expect(frame, 'a lone CR').not.toContain('\r');
  // CR rewrites the line, as a terminal shows a progress bar.
  expect(frame).toContain('progress 100%');
  expect(frame).not.toContain('progress 10%');
}

describe.each([0, 1] as const)('hook output control sequences, chalk level %i', (level) => {
  it('HookProgress shows the text and none of the sequences', () => {
    chalk.level = level;
    const frame = render(<HookProgress stage="bootstrap" output={HOSTILE} shardLabel="acme/demo" />).lastFrame() ?? '';
    expectClean(frame);
  });

  it('HookSummarySection shows the text and none of the sequences', () => {
    chalk.level = level;
    const frame =
      render(
        <HookSummarySection outcomes={[{ slot: 'bootstrap', summary: { stdout: HOSTILE, stderr: HOSTILE, exitCode: 0 } }]} />,
      ).lastFrame() ?? '';
    expectClean(frame);
  });

  it('the write-boundary warning shows hook-created paths without their sequences', () => {
    chalk.level = level;
    const hostilePath = `${SEQUENCES['OSC 52 clipboard write']}${SEQUENCES['OSC 8 hyperlink open']}notes.md${SEQUENCES['OSC 8 hyperlink close']}`;
    const frame =
      render(
        <HookSummarySection
          outcomes={[{ slot: 'personalize', summary: { exitCode: 0, violation: { kind: 'unmanaged-create', paths: [hostilePath] } } }]}
        />,
      ).lastFrame() ?? '';
    expect(frame).toContain('notes.md');
    expect(frame).not.toContain(SEQUENCES['OSC 52 clipboard write']);
    expect(frame).not.toContain(SEQUENCES['OSC 8 hyperlink open']);
  });

  it('the write-boundary warning cannot hide a path behind a CR or forge a line with an LF', () => {
    chalk.level = level;
    const frame =
      render(
        <HookSummarySection
          outcomes={[
            {
              slot: 'personalize',
              summary: {
                exitCode: 0,
                violation: { kind: 'unmanaged-create', paths: ['secrets-dump.sh\rnotes.md', 'x.md\nForged line'] },
              },
            },
          ]}
        />,
      ).lastFrame() ?? '';
    expect(frame).toContain('secrets-dump.sh\\rnotes.md');
    expect(frame).toContain('x.md\\nForged line');
    expect(frame).not.toMatch(/^Forged line/m);
  });

  it('the live tail skips a line that is only colour codes', () => {
    chalk.level = level;
    const frame = render(<HookProgress stage="bootstrap" output={'one\n\x1b[0m\ntwo\n'} shardLabel="acme/demo" />).lastFrame() ?? '';
    const lines = frame.split('\n').slice(2);
    expect(lines.filter((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trim() === '')).toHaveLength(0);
  });
});
