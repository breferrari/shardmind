/**
 * Platform-invariance guards for the vault-relative path helpers.
 *
 * These constants double as user-facing strings (the Summary prints the hook
 * log pointer verbatim), so they MUST be byte-identical on every OS — a Windows
 * `path.join` that leaked backslashes would show `.shardmind\logs\bootstrap.log`
 * to a Windows user while Linux/macOS users saw forward slashes. This suite runs
 * on the full ubuntu/windows/macos CI matrix and pins the forward-slash contract.
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { hookLogRelPath, HOOK_LOGS_DIR, SHARDMIND_DIR } from '../../source/runtime/vault-paths.js';

describe('hookLogRelPath — platform-invariant display path', () => {
  it('is always forward-slash, on every OS', () => {
    for (const slot of ['bootstrap', 'personalize', 'post-update', 'post-install']) {
      const rel = hookLogRelPath(slot);
      expect(rel).toBe(`.shardmind/logs/${slot}.log`);
      expect(rel).not.toContain('\\'); // never a backslash, even on win32
    }
  });

  it('resolves to a valid OS-native absolute path under the vault when joined', () => {
    // The display string is forward-slash; the on-disk location is whatever
    // path.join produces for the host OS — both must point at the same file.
    const vault = path.resolve('some-vault');
    const abs = path.join(vault, hookLogRelPath('bootstrap'));
    expect(abs.startsWith(vault)).toBe(true);
    expect(path.basename(abs)).toBe('bootstrap.log');
    expect(path.dirname(abs)).toBe(path.join(vault, HOOK_LOGS_DIR));
  });

  it('HOOK_LOGS_DIR lives under .shardmind/', () => {
    expect(HOOK_LOGS_DIR).toBe(path.join(SHARDMIND_DIR, 'logs'));
  });
});
