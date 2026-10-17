import { realpathSync } from 'node:fs';
import path from 'node:path';

/** The executing host's per-user queue directory; no sandbox runtime is needed to resolve it. */
export function defaultHeavyLockDir(): string {
  return path.join(realpathSync('/tmp'), `projectman-${process.getuid?.() ?? 'user'}`, 'heavy');
}
