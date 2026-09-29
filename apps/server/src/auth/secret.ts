import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Secret used to sign the login cookie, generated into `${PROJECTMAN_HOME}/secret` on the
 * first run (owner-readable only). Publish a complete file without replacing another
 * process's key; changing the key would invalidate every saved login cookie.
 */
export function loadOrCreateSecret(home: string): string {
  const path = join(home, 'secret');
  if (existsSync(path)) {
    const secret = readFileSync(path, 'utf8').trim();
    if (secret.length < 32) {
      throw new Error(`Invalid cookie signing secret at ${path}; restore it to preserve existing logins.`);
    }
    chmodSync(path, 0o600);
    return secret;
  }
  mkdirSync(home, { recursive: true });
  const secret = randomBytes(32).toString('hex');
  const temporary = join(home, `.secret-${randomBytes(16).toString('hex')}`);
  writeFileSync(temporary, `${secret}\n`, { mode: 0o600, flag: 'wx' });
  try {
    try {
      // A hard link atomically publishes the complete key, and fails if a key exists.
      linkSync(temporary, path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  } finally {
    unlinkSync(temporary);
  }
  return loadOrCreateSecret(home);
}
