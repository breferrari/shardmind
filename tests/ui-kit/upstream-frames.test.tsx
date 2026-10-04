/**
 * Golden frames for the components ShardMind took from @inkjs/ui 2.0.0
 * (#273): what each variant ShardMind uses drew under @inkjs/ui, captured
 * with chalk at level 1 so colour is compared too. The glyphs that fall
 * back on a terminal without Unicode come from the code under test.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { render } from 'ink-testing-library';
import { Box } from 'ink';
import chalk from 'chalk';
import type { ReactNode } from 'react';
import g from 'figures';
import { Alert, Badge, ProgressBar, Spinner, StatusMessage } from '@inkjs/ui';

const narrow = (node: ReactNode) => render(<Box width={24}>{node}</Box>).lastFrame();
const bar = (value: number) => render(<Box width={10}><ProgressBar value={value} /></Box>).lastFrame();

const FRAMES: Array<[string, string]> = [
  ["Alert error", `\u001b[31m╭──────────────────────╮\u001b[39m\n\u001b[31m│\u001b[39m \u001b[31m${g.cross}\u001b[39m Boom               \u001b[31m│\u001b[39m\n\u001b[31m╰──────────────────────╯\u001b[39m`],
  ["Alert info", `\u001b[34m╭──────────────────────╮\u001b[39m\n\u001b[34m│\u001b[39m \u001b[34m${g.info}\u001b[39m Note               \u001b[34m│\u001b[39m\n\u001b[34m╰──────────────────────╯\u001b[39m`],
  ["Alert warning", `\u001b[33m╭──────────────────────╮\u001b[39m\n\u001b[33m│\u001b[39m \u001b[33m${g.warning}\u001b[39m Careful            \u001b[33m│\u001b[39m\n\u001b[33m╰──────────────────────╯\u001b[39m`],
  ["StatusMessage success", `\u001b[32m${g.tick}\u001b[39m Done`],
  ["StatusMessage warning", `\u001b[33m${g.warning}\u001b[39m Hmm`],
  ["StatusMessage error", `\u001b[31m${g.cross}\u001b[39m Failed`],
  ["Badge blue", `\u001b[44m \u001b[30mV1.2.3\u001b[39m \u001b[49m`],
  ["ProgressBar 0", `\u001b[2m░░░░░░░░░░\u001b[22m`],
  ["ProgressBar 50", `\u001b[35m█████\u001b[39m\u001b[2m░░░░░\u001b[22m`],
  ["ProgressBar 100", `\u001b[35m██████████\u001b[39m`],
  ["Spinner", `\u001b[34m⠋\u001b[39m Working`],
];

const RENDER: Record<string, () => string | undefined> = {
  'Alert error': () => narrow(<Alert variant="error">Boom</Alert>),
  'Alert info': () => narrow(<Alert variant="info">Note</Alert>),
  'Alert warning': () => narrow(<Alert variant="warning">Careful</Alert>),
  'StatusMessage success': () => narrow(<StatusMessage variant="success">Done</StatusMessage>),
  'StatusMessage warning': () => narrow(<StatusMessage variant="warning">Hmm</StatusMessage>),
  'StatusMessage error': () => narrow(<StatusMessage variant="error">Failed</StatusMessage>),
  'Badge blue': () => narrow(<Badge color="blue">v1.2.3</Badge>),
  'ProgressBar 0': () => bar(0),
  'ProgressBar 50': () => bar(50),
  'ProgressBar 100': () => bar(100),
  'Spinner': () => narrow(<Spinner label="Working" />),
};

let level: typeof chalk.level;
beforeAll(() => {
  level = chalk.level;
  chalk.level = 1;
});
afterAll(() => {
  chalk.level = level;
});

describe('frames as @inkjs/ui 2.0.0 drew them (#273)', () => {
  it.each(FRAMES)('%s', (name, frame) => {
    expect(RENDER[name]!()).toBe(frame);
  });
});
