/**
 * The one owner of SIGINT, the exit code and the startup order (#303).
 * Spec: docs/IMPLEMENTATION.md §4.32.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  onSigint,
  emitSigint,
  withSigintHeld,
  setExitCode,
  exitProcess,
  STARTUP_STEPS,
  resetSigintForTests,
} from '../../source/core/process-control.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tick = () => new Promise<void>((r) => setImmediate(() => setImmediate(() => setImmediate(r))));

afterEach(() => {
  resetSigintForTests();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('the SIGINT stack', () => {
  it('runs every handler in the order it was added', () => {
    const ran: string[] = [];
    onSigint(() => void ran.push('a'));
    onSigint(() => void ran.push('b'));
    expect(emitSigint()).toBe(true);
    expect(ran).toEqual(['a', 'b']);
  });

  it('a once handler runs once; a removed one never', () => {
    const ran: string[] = [];
    onSigint(() => void ran.push('once'), { once: true });
    const off = onSigint(() => void ran.push('off'));
    onSigint(() => void ran.push('kept'));
    off();
    emitSigint();
    emitSigint();
    expect(ran).toEqual(['once', 'kept', 'kept']);
  });

  it('one process listener, removed when no handler is left: emitSigint is then false (#155)', () => {
    const before = process.listenerCount('SIGINT');
    const offA = onSigint(() => {});
    const offB = onSigint(() => {});
    expect(process.listenerCount('SIGINT')).toBe(before + 1);
    offA();
    offB();
    expect(process.listenerCount('SIGINT')).toBe(before);
    if (before === 0) expect(emitSigint()).toBe(false);
  });

  it('a handler that throws or rejects does not stop the next', () => {
    const ran: string[] = [];
    onSigint(() => {
      throw new Error('sync');
    });
    onSigint(async () => Promise.reject(new Error('async')));
    onSigint(() => void ran.push('after'));
    emitSigint();
    expect(ran).toEqual(['after']);
  });
});

describe('withSigintHeld (#50, #282)', () => {
  it('takes every listener off while fn runs, a no-op takes the signal, and they come back after', async () => {
    const ran: string[] = [];
    onSigint(() => void ran.push('stack'));
    const foreign = () => void ran.push('foreign');
    process.on('SIGINT', foreign);
    try {
      withSigintHeld(() => {
        process.emit('SIGINT');
      });
      expect(ran).toEqual([]);
      await tick();
      process.emit('SIGINT');
      expect(ran).toEqual(['stack', 'foreign']);
    } finally {
      process.removeListener('SIGINT', foreign);
    }
  });
});

describe('the exit code', () => {
  it('setExitCode keeps the code; exitProcess exits with it', () => {
    setExitCode(3);
    expect(process.exitCode).toBe(3);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    exitProcess(130);
    expect(exit).toHaveBeenCalledWith(130);
  });

  it('exitProcess with no code passes no argument, so the code set so far stands (Node 22 counts arguments)', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    exitProcess();
    expect(exit.mock.calls[0]).toEqual([]);
  });
});

describe('the startup order (§4.32 step 4)', () => {
  it('cli.ts runs its process setup in STARTUP_STEPS order', () => {
    const source = fs.readFileSync(path.join(ROOT, 'source', 'cli.ts'), 'utf-8');
    const at = STARTUP_STEPS.map((step) => source.indexOf(`${step}(`));
    expect(at.every((i) => i >= 0), `every step is called: ${STARTUP_STEPS.join(', ')}`).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // ...all before the cli-kit (and so Ink) loads.
    expect(Math.max(...at)).toBeLessThan(source.indexOf("import('./cli-kit/index.js')"));
  });
});

describe('no module but the owner touches SIGINT or the exit code (#303)', () => {
  // internal/: child processes with their own exit. cli-kit/: vendored Pastel.
  const EXEMPT = [path.join('source', 'internal'), path.join('source', 'cli-kit'), path.join('source', 'core', 'process-control.ts')];
  const FORBIDDEN: Array<[string, RegExp]> = [
    ['a SIGINT listener', /process\.(?:on|once|off|removeListener|addListener|prependListener)\(\s*['"]SIGINT['"]/],
    ['the raw SIGINT listeners', /rawListeners\(\s*['"]SIGINT['"]/],
    ['an in-process SIGINT', /process\.emit\(\s*['"]SIGINT['"]/],
    ['the exit code', /process\.exitCode\s*=/],
    ['an exit', /process\.exit\(/],
  ];

  it('finds none outside process-control.ts', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of fs.readdirSync(dir)) {
        const abs = path.join(dir, name);
        const rel = path.relative(ROOT, abs);
        if (EXEMPT.some((e) => rel === e || rel.startsWith(e + path.sep))) continue;
        if (fs.statSync(abs).isDirectory()) walk(abs);
        else if (/\.tsx?$/.test(name)) {
          const lines = fs.readFileSync(abs, 'utf-8').split('\n');
          lines.forEach((line, i) => {
            if (/^\s*(\/\/|\/?\*)/.test(line)) return;
            for (const [what, re] of FORBIDDEN) if (re.test(line)) offenders.push(`${rel}:${i + 1} ${what}`);
          });
        }
      }
    };
    walk(path.join(ROOT, 'source'));
    expect(offenders).toEqual([]);
  });
});
