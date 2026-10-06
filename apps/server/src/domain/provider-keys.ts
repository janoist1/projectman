import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { FastifyBaseLogger as Logger } from 'fastify';
import { z } from 'zod';
import { ProviderKeyValue } from '@projectman/shared';
import { invalid } from './errors';

export interface ProviderKeyStatus {
  set: boolean;
  setAt: string | null;
}
export type NanogptKeyCheck = (key: string) => Promise<'accepted' | 'rejected' | 'unknown'>;
const StoredKey = z.strictObject({
  version: z.literal(1),
  key: ProviderKeyValue,
  setAt: z.iso.datetime(),
  setBy: z.string(),
});

/** Installation secrets stay outside configuration, SQLite and public provider status. */
export class ProviderKeys {
  private readonly deps: { home: string; now: () => Date; logger: Logger; check: NanogptKeyCheck };
  private readonly directory: string;
  private readonly path: string;
  private readonly listeners = new Set<() => void>();
  constructor(deps: { home: string; now: () => Date; logger: Logger; check: NanogptKeyCheck }) {
    this.deps = deps;
    this.directory = join(deps.home, 'secrets');
    this.path = join(this.directory, 'nanogpt.json');
  }
  private read(): z.infer<typeof StoredKey> | null {
    try {
      const stat = lstatSync(this.path);
      if (!stat.isFile()) {
        this.deps.logger.warn('nanogpt key store is not a regular file');
        return null;
      }
      const mode = stat.mode & 0o777;
      chmodSync(this.directory, 0o700);
      if (mode !== 0o600) {
        chmodSync(this.path, 0o600);
        this.deps.logger.warn('nanogpt key file permissions repaired');
      }
      const stored = StoredKey.safeParse(JSON.parse(readFileSync(this.path, 'utf8')));
      if (!stored.success) {
        this.deps.logger.warn('nanogpt key store is invalid');
        return null;
      }
      return stored.data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      if (error instanceof SyntaxError) this.deps.logger.warn('nanogpt key store is invalid');
      else
        this.deps.logger.warn(
          { code: (error as NodeJS.ErrnoException).code },
          'nanogpt key store unreadable',
        );
      return null;
    }
  }
  status(): ProviderKeyStatus {
    const stored = this.read();
    return { set: stored !== null, setAt: stored?.setAt ?? null };
  }
  async nanogptKey(): Promise<string | null> {
    return this.read()?.key ?? null;
  }
  async setNanogpt(key: string, by: string): Promise<ProviderKeyStatus> {
    const parsed = ProviderKeyValue.safeParse(key);
    if (!parsed.success) throw invalid('invalid_request', 'the request is invalid');
    key = parsed.data;
    let result: Awaited<ReturnType<NanogptKeyCheck>>;
    try {
      result = await this.deps.check(key);
    } catch {
      result = 'unknown';
    }
    if (result === 'rejected') throw invalid('nanogpt_key_rejected', 'NanoGPT refused the key');
    if (result === 'unknown') this.deps.logger.warn('nanogpt key check unavailable');
    const setAt = this.deps.now().toISOString();
    const temporary = join(this.directory, `.nanogpt-${randomUUID()}.tmp`);
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      chmodSync(this.directory, 0o700);
      writeFileSync(temporary, JSON.stringify({ version: 1, key, setAt, setBy: by }), {
        mode: 0o600,
        flag: 'wx',
      });
      renameSync(temporary, this.path);
    } catch {
      throw new Error('Could not write NanoGPT key store');
    } finally {
      try {
        unlinkSync(temporary);
      } catch {
        /* Already renamed or never created. */
      }
    }
    this.deps.logger.info({ by }, 'nanogpt key set');
    this.changed();
    return { set: true, setAt };
  }
  async clearNanogpt(by: string): Promise<ProviderKeyStatus> {
    try {
      unlinkSync(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error('Could not clear NanoGPT key store');
    }
    this.deps.logger.info({ by }, 'nanogpt key cleared');
    this.changed();
    return { set: false, setAt: null };
  }
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private changed(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        this.deps.logger.warn('nanogpt key change listener failed');
      }
    }
  }
}
