/**
 * The fault injector's beforeWrite hook (#267, #186): a hook may hold the
 * write it runs before, and the write it counts can be limited to one folder.
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { injectFaults } from '../helpers/fault-fs.js';

let uninstall: (() => void) | undefined;
let root: string | undefined;

afterEach(async () => {
  uninstall?.();
  uninstall = undefined;
  if (root) await fs.rm(root, { recursive: true, force: true });
  root = undefined;
});

async function tempRoot(): Promise<string> {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'shardmind-fault-fs-'));
  return root;
}

describe('injectFaults beforeWrite', () => {
  it('holds the write until an async hook settles', async () => {
    const dir = await tempRoot();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const fault = injectFaults({ beforeWrite: { nth: 1, hook: () => held } });
    uninstall = fault.uninstall;

    const file = path.join(dir, 'held.txt');
    const write = fs.writeFile(file, 'x');
    await new Promise((r) => setTimeout(r, 30));
    // The hook fired and the write has not happened yet.
    expect(fault.fired.hook).toBe(true);
    await expect(fs.stat(file)).rejects.toThrow();
    release();
    await write;
    expect(await fs.readFile(file, 'utf-8')).toBe('x');
  });

  it('counts only writes inside `under` when it is given', async () => {
    const dir = await tempRoot();
    const vault = path.join(dir, 'vault');
    const elsewhere = path.join(dir, 'temp');
    await fs.mkdir(vault);
    await fs.mkdir(elsewhere);
    const seen: string[] = [];
    const fault = injectFaults({
      beforeWrite: { nth: 2, under: vault, hook: () => void seen.push('hook') },
    });
    uninstall = fault.uninstall;

    await fs.writeFile(path.join(elsewhere, 'a'), '1');
    await fs.writeFile(path.join(vault, 'b'), '2');
    await fs.writeFile(path.join(elsewhere, 'c'), '3');
    expect(seen).toEqual([]);
    await fs.writeFile(path.join(vault, 'd'), '4');
    expect(seen).toEqual(['hook']);
    // `counts` still counts every write.
    expect(fault.counts.write).toBe(4);
  });

  it('keeps counting every write when `under` is absent', async () => {
    const dir = await tempRoot();
    const seen: number[] = [];
    const fault = injectFaults({ beforeWrite: { nth: 2, hook: () => void seen.push(fault.counts.write) } });
    uninstall = fault.uninstall;
    await fs.writeFile(path.join(dir, 'a'), '1');
    await fs.writeFile(path.join(dir, 'b'), '2');
    expect(seen).toEqual([2]);
  });
});

describe('injectFaults in the rollback (#292)', () => {
  it('fails the nth remove or read made after the main fault, and counts them apart', async () => {
    const dir = await tempRoot();
    const a = path.join(dir, 'a.txt');
    const b = path.join(dir, 'b.txt');
    await fs.writeFile(a, 'a');
    await fs.writeFile(b, 'b');
    const fault = injectFaults({ fail: { kind: 'write', nth: 1 }, inRollback: { kind: 'remove', nth: 2 } });
    uninstall = fault.uninstall;

    // Before the main fault, removes are not the rollback's: none fails.
    await expect(fs.writeFile(path.join(dir, 'c.txt'), 'c')).rejects.toThrow(/injected EIO at write #1/);
    await fs.rm(a);
    await expect(fs.rm(b)).rejects.toThrow(/injected EIO at remove #2/);
    expect(fault.fired.rollback).toBe(true);
    expect(fault.afterFail.remove).toBe(2);
    expect(fault.counts.remove).toBe(2);
  });

  it('never fails a rollback call when the main fault did not fire', async () => {
    const dir = await tempRoot();
    const file = path.join(dir, 'a.txt');
    await fs.writeFile(file, 'a');
    const fault = injectFaults({ fail: { kind: 'write', nth: 5 }, inRollback: { kind: 'read', nth: 1 } });
    uninstall = fault.uninstall;
    expect(await fs.readFile(file, 'utf-8')).toBe('a');
    expect(fault.fired.rollback).toBe(false);
    expect(fault.counts.read).toBe(1);
    expect(fault.afterFail.read).toBe(0);
  });

  it('runs onFail just before the main fault throws', async () => {
    const dir = await tempRoot();
    const order: string[] = [];
    const fault = injectFaults({ fail: { kind: 'mkdir', nth: 1 }, onFail: () => void order.push('onFail') });
    uninstall = fault.uninstall;
    await fs.mkdir(path.join(dir, 'x')).catch(() => order.push('threw'));
    expect(order).toEqual(['onFail', 'threw']);
  });
});
