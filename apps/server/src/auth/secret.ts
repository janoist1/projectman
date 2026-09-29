import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Secret used to sign the login cookie, generated into `${PROJECTMAN_HOME}/secret` on the
 * first run (owner-readable only).
 */
export function loadOrCreateSecret(home: string): string {
  const path = join(home, 'secret');
  if (existsSync(path)) {
    const secret = readFileSync(path, 'utf8').trim();
    if (secret.length >= 32) return secret;
  }
  mkdirSync(home, { recursive: true });
  const secret = randomBytes(32).toString('hex');
  writeFileSync(path, `${secret}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return secret;
}
