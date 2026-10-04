// Child-process probe for tests/integration/hook-output-colour.test.ts.
// Mirrors source/cli.ts: NO_COLOR is applied before chalk loads. Then it
// reports whether Ink's output is coloured (through the chalk instance
// resolved from Ink's own package, the one Ink renders with) and whether hook
// output keeps its colour, so the test can assert the two agree.
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyNoColor } from '../../../source/core/color-env.js';

applyNoColor(process.env);

const inkEntry = fileURLToPath(import.meta.resolve('ink'));
const inkChalkPath = createRequire(inkEntry).resolve('chalk');
const { default: inkChalk } = (await import(pathToFileURL(inkChalkPath).href)) as typeof import('chalk');
const { hookOutputForDisplay } = await import('../../../source/components/hook-output.js');

const ours = inkChalk.green('x') !== 'x';
const hook = hookOutputForDisplay('\x1b[32mx\x1b[0m') !== 'x';
process.stdout.write(JSON.stringify({ ours, hook }));
