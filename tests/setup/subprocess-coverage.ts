/**
 * Runs in every test worker (#293). In a coverage run, the global setup
 * provides the directory the spawned CLI writes its V8 coverage to; setting
 * NODE_V8_COVERAGE here, inside the worker, reaches the processes the worker
 * spawns but not the worker itself. Through `test.env` it would also reach
 * the worker's own fork, which would profile itself into the directory.
 */

import { inject } from 'vitest';
import { SUBPROCESS_COVERAGE_DIR_KEY } from '../coverage-run/coverage-run.js';

const dir = inject(SUBPROCESS_COVERAGE_DIR_KEY);
if (dir) process.env['NODE_V8_COVERAGE'] = dir;
