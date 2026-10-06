/**
 * The one owner of SIGINT, the exit code and the startup order (#303).
 * Spec: docs/IMPLEMENTATION.md §4.32.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  onSigint,
  emitSigint,
  withSigintHeld,
  setExitCode,
  exitProcess,
  exitOnSigint,
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

  it('a handler that throws does not stop the next, and its throw still surfaces after them', () => {
    const ran: string[] = [];
    onSigint(() => {
      throw new Error('sync');
    });
    onSigint(() => void ran.push('after'));
    expect(() => emitSigint()).toThrow('sync');
    expect(ran).toEqual(['after']);
  });

  it('exitOnSigint runs the cleanup, then exits 130, once', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const order: string[] = [];
    exitOnSigint(() => async () => void order.push('cleanup'));
    emitSigint();
    await tick();
    expect(order).toEqual(['cleanup']);
    expect(exit).toHaveBeenCalledWith(130);
    expect(emitSigint()).toBe(process.listenerCount('SIGINT') > 0);
  });

  it('exitOnSigint still exits 130 when the cleanup throws or there is none', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    exitOnSigint(() => () => {
      throw new Error('cleanup broke');
    });
    exitOnSigint(() => undefined);
    emitSigint();
    await tick();
    expect(exit.mock.calls).toEqual([[130], [130]]);
  });
});

describe('withSigintHeld (#50, #282)', () => {
  it('a handler removed during the hold leaves no listener behind: with none left, emitSigint is false', async () => {
    const before = process.listenerCount('SIGINT');
    const off = onSigint(() => {});
    withSigintHeld(() => off());
    await tick();
    expect(process.listenerCount('SIGINT')).toBe(before);
  });

  it('a handler added during the hold is held too, and runs once after it', async () => {
    const ran: string[] = [];
    withSigintHeld(() => {
      onSigint(() => void ran.push('added'));
      process.emit('SIGINT');
    });
    // The queued signal lands before the restore: still held.
    process.emit('SIGINT');
    expect(ran).toEqual([]);
    await tick();
    process.emit('SIGINT');
    expect(ran).toEqual(['added']);
  });

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
  // The calls as they run in cli.ts, read from its syntax tree: comments
  // and strings cannot stand in for them.
  const STEPS = ['applyNoColor', 'exitQuietlyWhenStdoutCloses', 'installCrashHandlers', 'installStdinCancellation'];
  const file = path.join(ROOT, 'source', 'cli.ts');
  const tree = ts.createSourceFile(file, fs.readFileSync(file, 'utf-8'), ts.ScriptTarget.Latest, true);
  const calls: Array<{ name: string; at: number }> = [];
  const imports: Array<{ spec: string; at: number }> = [];
  let headlessRun = -1;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression)) calls.push({ name: node.expression.text, at: node.getStart() });
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(node.arguments[0]!)) {
        imports.push({ spec: node.arguments[0].text, at: node.getStart() });
      }
    }
    // The headless runner picked: `HEADLESS_JSON[...]`.
    if (ts.isElementAccessExpression(node) && node.expression.getText() === 'HEADLESS_JSON' && headlessRun === -1) headlessRun = node.getStart();
    ts.forEachChild(node, visit);
  };
  visit(tree);

  it('each step runs once, in order', () => {
    const steps = calls.filter((c) => STEPS.includes(c.name));
    expect(steps.map((c) => c.name)).toEqual(STEPS);
  });

  it('colour and the closed-stdout handler come before any dynamic import (#37, #252)', () => {
    const firstImport = Math.min(...imports.map((i) => i.at));
    for (const name of ['applyNoColor', 'exitQuietlyWhenStdoutCloses']) {
      expect(calls.find((c) => c.name === name)!.at, name).toBeLessThan(firstImport);
    }
  });

  it('the crash handlers are installed before any import but their own module (#225)', () => {
    const installed = calls.find((c) => c.name === 'installCrashHandlers')!.at;
    const others = imports.filter((i) => i.spec !== './core/bug-report.js' && i.spec !== './commands/hooks/cli-version.js');
    expect(Math.min(...others.map((i) => i.at))).toBeGreaterThan(installed);
  });

  it('the stdin bridge is installed before a headless runner or the cli-kit loads (#155, #302)', () => {
    const bridge = calls.find((c) => c.name === 'installStdinCancellation')!.at;
    expect(headlessRun).toBeGreaterThan(bridge);
    expect(imports.find((i) => i.spec === './cli-kit/index.js')!.at).toBeGreaterThan(bridge);
  });
});

describe('no module but the owner touches SIGINT or the exit code (#303)', () => {
  // internal/: child processes with their own exit. cli-kit/: vendored Pastel.
  // The scan reads the literal `process.` receiver: an alias (`const p =
  // process`) or a destructured `exit` would pass it, so review keeps to the
  // literal form, and modules that take a process-like object (stdout-closed,
  // bug-report) take the owner's writers too.
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
