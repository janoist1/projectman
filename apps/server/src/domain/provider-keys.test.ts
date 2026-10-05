import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
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
      logger: pino(
        { level: 'trace' },
        {
          write: (line: string) => {
            lines.push(line);
          },
        },
      ),
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
