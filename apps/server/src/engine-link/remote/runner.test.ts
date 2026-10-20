import { describe, expect, it } from 'vitest';
import type { ProviderStatus } from '../../contracts';
import { withNanogptKeyFact } from './runner';

const status = (over: Partial<ProviderStatus> = {}): ProviderStatus => ({
  provider: 'nanogpt',
  loggedIn: true,
  method: 'api_key',
  checkedAt: '2026-10-19T10:00:00.000Z',
  cliVersion: '0.159.1',
  ...over,
});

describe('withNanogptKeyFact', () => {
  it('makes an engine that reported a missing key ready when the cloud holds the key', () => {
    const result = withNanogptKeyFact(status({ loggedIn: false, problem: 'no_key' }), true);
    expect(result).toEqual(status());
    expect(result).not.toHaveProperty('problem');
  });

  it('reports a missing key when the cloud holds none, for an engine whose CLI is ready', () => {
    expect(withNanogptKeyFact(status(), false)).toEqual(status({ loggedIn: false, problem: 'no_key' }));
  });

  it('keeps the status when the engine and the cloud agree', () => {
    expect(withNanogptKeyFact(status(), true)).toEqual(status());
    const missing = status({ loggedIn: false, problem: 'no_key' });
    expect(withNanogptKeyFact(missing, false)).toEqual(missing);
  });

  it.each([
    ['a missing CLI', status({ loggedIn: false, problem: 'cli_missing' })],
    ['an old CLI', status({ loggedIn: false, problem: 'cli_too_old' })],
    ['a ChatGPT login', status({ loggedIn: false, method: 'chatgpt', problem: 'chatgpt_login' })],
    ['an unknown state', status({ loggedIn: null, detail: 'The engine is not connected' })],
  ])('leaves %s as the engine reported it, whether or not the key is there', (_name, reported) => {
    expect(withNanogptKeyFact(reported, true)).toEqual(reported);
    expect(withNanogptKeyFact(reported, false)).toEqual(reported);
  });

  it('leaves the status of another provider alone', () => {
    const codex = status({ provider: 'codex' });
    expect(withNanogptKeyFact(codex, false)).toBe(codex);
    const missing = status({ provider: 'codex', loggedIn: false, problem: 'no_key' });
    expect(withNanogptKeyFact(missing, true)).toBe(missing);
  });
});
