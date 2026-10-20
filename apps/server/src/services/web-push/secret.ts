import { createECDH, createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const KeyFile = z.object({
  version: z.literal(1),
  publicKey: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
  privateKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  createdAt: z.string().datetime(),
});
export type VapidKey = z.infer<typeof KeyFile>;
export const vapidKeyId = (publicKey: string): string =>
  createHash('sha256').update(publicKey).digest('hex').slice(0, 16);

/** Atomically publishes one installation key without replacing a concurrently created key. */
export function loadOrCreateVapidKey(home: string): VapidKey {
  const dir = join(home, 'secrets');
  const path = join(dir, 'web-push.json');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  if (existsSync(path)) {
    try {
      const key = KeyFile.parse(JSON.parse(readFileSync(path, 'utf8')));
      const curve = createECDH('prime256v1');
      curve.setPrivateKey(Buffer.from(key.privateKey, 'base64url'));
      if (curve.getPublicKey().toString('base64url') !== key.publicKey) throw new Error();
      chmodSync(path, 0o600);
      return key;
    } catch {
      throw new Error('Invalid web push key file; restore the installation key.');
    }
  }
  const curve = createECDH('prime256v1');
  curve.generateKeys();
  const key: VapidKey = {
    version: 1,
    publicKey: curve.getPublicKey().toString('base64url'),
    privateKey: Buffer.from(curve.getPrivateKey().toString('hex').padStart(64, '0'), 'hex').toString(
      'base64url',
    ),
    createdAt: new Date().toISOString(),
  };
  const temporary = join(dir, `.web-push-${randomBytes(16).toString('hex')}`);
  writeFileSync(temporary, JSON.stringify(key), { mode: 0o600, flag: 'wx' });
  try {
    try {
      linkSync(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  } finally {
    unlinkSync(temporary);
  }
  return loadOrCreateVapidKey(home);
}
