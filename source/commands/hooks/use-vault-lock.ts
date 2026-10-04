/**
 * One shardmind run per vault (#253): the three writing commands' hold on
 * `<vault>/.shardmind.lock`. See docs/IMPLEMENTATION.md §4.25.
 *
 * `take()` at the start of the run effect (it throws `VAULT_LOCKED`, which
 * the machine renders as its error), `release()` in `finish`. Not on
 * unmount: a Ctrl+C unmounts the tree while its rollback still restores
 * files, and the lock must outlast that. The lock's own process `exit`
 * handler releases it once the rollback has exited 130, or after a crash.
 */

import { useCallback, useRef } from 'react';
import { useStderr } from 'ink';
import { acquireVaultLock, type VaultLock } from '../../core/vault-lock.js';
import { LOCK_FILE } from '../../runtime/vault-paths.js';

export function useVaultLock(
  vaultRoot: string,
  command: 'install' | 'update' | 'adopt',
  /** False under --dry-run, which writes nothing. */
  enabled: boolean,
): { take: () => void; release: () => void } {
  const lockRef = useRef<VaultLock | null>(null);
  // Through Ink, so the note does not tear the frame it is drawing.
  const { write: writeStderr } = useStderr();

  const take = useCallback(() => {
    if (!enabled || lockRef.current) return;
    const lock = acquireVaultLock(vaultRoot, command);
    lockRef.current = lock;
    if (lock.tookOver) {
      const { command: was, pid, startedAt } = lock.tookOver;
      writeStderr(
        `shardmind: took over ${LOCK_FILE} from a ${was} run (PID ${pid}, started ${startedAt}) that is no longer running.\n`,
      );
    }
  }, [vaultRoot, command, enabled, writeStderr]);

  const release = useCallback(() => {
    lockRef.current?.release();
    lockRef.current = null;
  }, []);

  return { take, release };
}
