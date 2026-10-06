/**
 * Run by editor.test.ts in its own process (POSIX only): a real SIGINT,
 * queued while withSigintHeld's call blocks in spawnSync, must be swallowed;
 * one sent after the restore must reach the original listener. Prints the
 * listener's call count after each phase as JSON.
 */
import { spawnSync } from 'node:child_process';
import { withSigintHeld } from '../../../source/core/process-control.js';

let calls = 0;
process.on('SIGINT', () => {
  calls++;
});

const during = await new Promise<number>((done) => {
  withSigintHeld(
    () => {
      process.kill(process.pid, 'SIGINT');
      // Block as the editor does, so the signal waits in libuv.
      spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 200)']);
    },
    () => done(calls),
  );
});
// Let any late delivery land before reading.
await new Promise((r) => setTimeout(r, 100));
const afterHold = calls;
process.kill(process.pid, 'SIGINT');
await new Promise((r) => setTimeout(r, 100));
process.stdout.write(JSON.stringify({ during, afterHold, afterRestore: calls }));
