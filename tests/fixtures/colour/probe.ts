// Child-process probe for tests/integration/hook-output-colour.test.ts.
// Mirrors source/cli.ts: NO_COLOR is applied before chalk loads. Then it
// reports whether our output is coloured and whether hook output keeps its
// colour, so the test can assert the two agree.
import { applyNoColor } from '../../../source/core/color-env.js';

applyNoColor(process.env);

const { default: chalk } = await import('chalk');
const { hookOutputForDisplay } = await import('../../../source/components/hook-output.js');

const ours = chalk.green('x') !== 'x';
const hook = hookOutputForDisplay('\x1b[32mx\x1b[0m') !== 'x';
process.stdout.write(JSON.stringify({ ours, hook }));
