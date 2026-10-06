import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderKeys } from './provider-keys';

describe('provider key store', () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });
  function harness() {
    const home = mkdtempSync(join(tmpdir(), 'pm-keys-'));
    homes.push(home);
    const lines: string[] = [];
    const check = vi.fn(async (_key: string): Promise<'accepted' | 'rejected' | 'unknown'> => 'accepted');
    const deps = {
      home,
      check,
      now: () => new Date('2026-10-05T08:00:00Z'),
      logger: fastify({
        logger: {
          level: 'trace',
          stream: {
            write: (line: string) => {
              lines.push(line);
            },
          },
        },
      }).log,
    };
    return {
      home,
      lines,
      check,
      deps,
      store: new ProviderKeys(deps),
      path: join(home, 'secrets', 'nanogpt.json'),
    };
  }
  it('publishes complete private files atomically, persists after restart and clears idempotently', async () => {
    const h = harness();
    const listener = vi.fn();
    const stop = h.store.onChange(listener);
    expect(h.store.status()).toEqual({ set: false, setAt: null });
    await h.store.setNanogpt('unique-secret-first', 'owner');
    const previous = statSync(h.path).ino;
    await h.store.setNanogpt('unique-secret-second', 'owner');
    expect(statSync(h.path).ino).not.toBe(previous);
    expect(statSync(join(h.home, 'secrets')).mode & 0o777).toBe(0o700);
    expect(statSync(h.path).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(h.home, 'secrets'))).toEqual(['nanogpt.json']);
    expect(JSON.parse(readFileSync(h.path, 'utf8'))).toEqual({
      version: 1,
      key: 'unique-secret-second',
      setAt: '2026-10-05T08:00:00.000Z',
      setBy: 'owner',
    });
    const restarted = new ProviderKeys(h.deps);
    expect(await restarted.nanogptKey()).toBe('unique-secret-second');
    expect(JSON.stringify(restarted.status())).not.toContain('unique-secret');
    await h.store.clearNanogpt('owner');
    stop();
    await h.store.clearNanogpt('owner');
    expect(listener).toHaveBeenCalledTimes(3);
    expect(await restarted.nanogptKey()).toBeNull();
    expect(readdirSync(join(h.home, 'secrets'))).toEqual([]);
    expect(h.lines.join('')).not.toContain('unique-secret');
  });
  it('repairs loose permissions on read without exposing the key', async () => {
    const h = harness();
    await h.store.setNanogpt('private-key', 'owner');
    chmodSync(h.path, 0o644);
    chmodSync(join(h.home, 'secrets'), 0o755);
    expect(await h.store.nanogptKey()).toBe('private-key');
    expect(statSync(h.path).mode & 0o777).toBe(0o600);
    expect(statSync(join(h.home, 'secrets')).mode & 0o777).toBe(0o700);
    expect(h.lines.join('')).toContain('permissions repaired');
    expect(h.lines.join('')).not.toContain('private-key');
  });
  it('treats invalid JSON as a missing key and repairs it on save without logging contents', async () => {
    const h = harness();
    await h.store.setNanogpt('previous-key', 'owner');
    writeFileSync(h.path, '{private-invalid-sentinel');
    expect(h.store.status()).toEqual({ set: false, setAt: null });
    expect(await h.store.nanogptKey()).toBeNull();
    expect(h.lines.join('')).toContain('nanogpt key store is invalid');
    expect(h.lines.join('')).not.toContain('private-invalid-sentinel');
    await h.store.setNanogpt('replacement-key', 'owner');
    expect(await h.store.nanogptKey()).toBe('replacement-key');
  });
  it('logs only the error code when the secret cannot be read', async () => {
    const h = harness();
    await h.store.setNanogpt('unreadable-sentinel', 'owner');
    chmodSync(join(h.home, 'secrets'), 0o000);
    try {
      expect(await h.store.nanogptKey()).toBeNull();
    } finally {
      chmodSync(join(h.home, 'secrets'), 0o700);
    }
    expect(h.lines.join('')).toContain('nanogpt key store unreadable');
    expect(h.lines.join('')).toContain('EACCES');
    expect(h.lines.join('')).not.toContain('unreadable-sentinel');
  });
  it.each(['abc\ndef', 'abc\rdef', 'abc\0def', 'ő', 'inner space'])(
    'refuses invalid key characters before checking or storing (%j)',
    async (key) => {
      const h = harness();
      await expect(h.store.setNanogpt(key, 'owner')).rejects.toMatchObject({ code: 'invalid_request' });
      expect(h.check).not.toHaveBeenCalled();
      expect(h.store.status()).toEqual({ set: false, setAt: null });
      expect(readdirSync(h.home)).toEqual([]);
    },
  );
  it('normalizes direct writes and refuses invalid stored values and symbolic links on read', async () => {
    const h = harness();
    await h.store.setNanogpt('  valid-key  ', 'owner');
    expect(h.check).toHaveBeenCalledWith('valid-key');
    expect(await h.store.nanogptKey()).toBe('valid-key');
    writeFileSync(
      h.path,
      JSON.stringify({
        version: 1,
        key: 'invalid\nsecret',
        setAt: h.deps.now().toISOString(),
        setBy: 'owner',
      }),
    );
    expect(await h.store.nanogptKey()).toBeNull();
    expect(h.store.status().set).toBe(false);
    expect(h.lines.join('')).not.toContain('invalid\nsecret');
    unlinkSync(h.path);
    const target = join(h.home, 'target');
    writeFileSync(
      target,
      JSON.stringify({ version: 1, key: 'linked-secret', setAt: h.deps.now().toISOString(), setBy: 'owner' }),
      { mode: 0o644 },
    );
    symlinkSync(target, h.path);
    expect(await h.store.nanogptKey()).toBeNull();
    expect(statSync(target).mode & 0o777).toBe(0o644);
    expect(h.lines.join('')).not.toContain('linked-secret');
  });
  it('preserves the previous key on rejection and stores unknown checks without logging their errors', async () => {
    const h = harness();
    await h.store.setNanogpt('previous-key', 'owner');
    h.check.mockResolvedValueOnce('rejected');
    await expect(h.store.setNanogpt('rejected-secret', 'owner')).rejects.toMatchObject({
      code: 'nanogpt_key_rejected',
    });
    expect(await h.store.nanogptKey()).toBe('previous-key');
    h.check.mockRejectedValueOnce(new Error('unknown-secret'));
    await h.store.setNanogpt('unknown-secret', 'owner');
    expect(await h.store.nanogptKey()).toBe('unknown-secret');
    expect(h.lines.join('')).toContain('check unavailable');
    expect(h.lines.join('')).not.toContain('secret');
  });
});
