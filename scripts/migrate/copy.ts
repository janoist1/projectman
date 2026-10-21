import { chmodSync, cpSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Copy a stopped home without widening directory permissions on Node 22 (nodejs/node#65488). */
export function copyTree(from: string, to: string): void {
  cpSync(from, to, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
  restoreDirectoryModes(from, to);
}

function restoreDirectoryModes(from: string, to: string): void {
  const source = lstatSync(from);
  // Never follow a symlink out of the copied tree.
  if (!source.isDirectory()) return;
  for (const entry of readdirSync(from)) {
    restoreDirectoryModes(join(from, entry), join(to, entry));
  }
  chmodSync(to, source.mode & 0o7777);
}
