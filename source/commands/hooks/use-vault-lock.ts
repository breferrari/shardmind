/**
 * One shardmind run per vault (#253): the three writing commands' hold on
 * `<vault>/.shardmind.lock`. See docs/IMPLEMENTATION.md §4.24.
 *
 * `take()` at the start of the run effect (it throws `VAULT_LOCKED`, which
 * the machine renders as its error), `release()` in `finish`. Unmount
 * releases too; the lock's own process `exit` handler covers a Ctrl+C or a
 * crash that exits without either.
 */

import { useCallback, useEffect, useRef } from 'react';
import { acquireVaultLock, type VaultLock } from '../../core/vault-lock.js';
import { LOCK_FILE } from '../../runtime/vault-paths.js';

export function useVaultLock(
  vaultRoot: string,
  command: 'install' | 'update' | 'adopt',
  /** False under --dry-run, which writes nothing. */
  enabled: boolean,
): { take: () => void; release: () => void } {
  const lockRef = useRef<VaultLock | null>(null);

  const take = useCallback(() => {
    if (!enabled || lockRef.current) return;
    const lock = acquireVaultLock(vaultRoot, command);
    lockRef.current = lock;
    if (lock.tookOver) {
      const { command: was, pid, startedAt } = lock.tookOver;
      process.stderr.write(
        `shardmind: took over ${LOCK_FILE} from a ${was} run (PID ${pid}, started ${startedAt}) that is no longer running.\n`,
      );
    }
  }, [vaultRoot, command, enabled]);

  const release = useCallback(() => {
    lockRef.current?.release();
    lockRef.current = null;
  }, []);

  useEffect(() => release, [release]);

  return { take, release };
}
