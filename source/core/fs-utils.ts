import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';

export async function pathExists(absolutePath: string): Promise<boolean> {
  try {
    await fsp.access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

export function sha256(input: string | Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function toPosix(from: string, to: string): string {
  return path.relative(from, to).replace(/\\/g, '/');
}
