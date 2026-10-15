import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { npmDependencyKey } from './npm-dependency-key';
import type { NpmDependencyKeyInput } from './npm-dependency-key';

const bytes = (text: string) => new TextEncoder().encode(text);
const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

const base = (): NpmDependencyKeyInput => ({
  lock: bytes('{"lockfileVersion":3}'),
  manifests: [
    { path: 'package.json', content: bytes('{"name":"root"}') },
    { path: 'apps/server/package.json', content: bytes('{"name":"server"}') },
    { path: 'packages/shared/package.json', content: bytes('{"name":"shared"}') },
  ],
  platform: 'darwin',
  arch: 'arm64',
  nodeVersion: 'v23.11.0',
  npmVersion: '10.9.2',
});

describe('npmDependencyKey', () => {
  it('is 64 lowercase hex characters, the same on every call', () => {
    const key = npmDependencyKey(base());
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(npmDependencyKey(base())).toBe(key);
  });

  it('hashes the documented identity document', () => {
    const input = base();
    const manifests = [
      { path: 'apps/server/package.json', sha256: sha256(bytes('{"name":"server"}')) },
      { path: 'package.json', sha256: sha256(bytes('{"name":"root"}')) },
      { path: 'packages/shared/package.json', sha256: sha256(bytes('{"name":"shared"}')) },
    ];
    const identity = JSON.stringify({
      version: 1,
      lock: sha256(input.lock),
      manifests,
      platform: 'darwin',
      arch: 'arm64',
      nodeVersion: 'v23.11.0',
      npmVersion: '10.9.2',
    });
    expect(npmDependencyKey(input)).toBe(createHash('sha256').update(identity).digest('hex'));
  });

  it('does not depend on the order of the manifests', () => {
    const input = base();
    expect(npmDependencyKey({ ...input, manifests: [...input.manifests].reverse() })).toBe(
      npmDependencyKey(input),
    );
  });

  it('orders manifests by code point, not by UTF-16 unit', () => {
    const manifests = [
      { path: '\u{1F600}/package.json', content: bytes('a') },
      { path: '～/package.json', content: bytes('b') },
    ];
    const input = { ...base(), manifests };
    expect(npmDependencyKey({ ...input, manifests: [...manifests].reverse() })).toBe(npmDependencyKey(input));
    const identity = JSON.stringify({
      version: 1,
      lock: sha256(input.lock),
      manifests: [
        { path: '～/package.json', sha256: sha256(bytes('b')) },
        { path: '\u{1F600}/package.json', sha256: sha256(bytes('a')) },
      ],
      platform: input.platform,
      arch: input.arch,
      nodeVersion: input.nodeVersion,
      npmVersion: input.npmVersion,
    });
    expect(npmDependencyKey(input)).toBe(createHash('sha256').update(identity).digest('hex'));
  });

  it('changes with the lock, with any manifest and with every runtime field', () => {
    const input = base();
    const key = npmDependencyKey(input);
    const changed: NpmDependencyKeyInput[] = [
      { ...input, lock: bytes('{"lockfileVersion":2}') },
      { ...input, manifests: input.manifests.map((m, i) => (i === 1 ? { ...m, content: bytes('{}') } : m)) },
      { ...input, manifests: input.manifests.slice(0, 2) },
      { ...input, manifests: input.manifests.map((m, i) => (i === 0 ? { ...m, path: 'other.json' } : m)) },
      { ...input, platform: 'linux' },
      { ...input, arch: 'x64' },
      { ...input, nodeVersion: 'v22.0.0' },
      { ...input, npmVersion: '11.0.0' },
    ];
    const keys = changed.map(npmDependencyKey);
    expect(keys.every((other) => other !== key)).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('refuses a path that is not a relative path inside the repository', () => {
    const input = base();
    for (const path of ['', '/abs/package.json', '../package.json', 'a//b.json', './package.json', 'a\\b']) {
      expect(() => npmDependencyKey({ ...input, manifests: [{ path, content: bytes('{}') }] })).toThrow(
        TypeError,
      );
    }
  });

  it('refuses a duplicated manifest path', () => {
    const input = base();
    expect(() =>
      npmDependencyKey({
        ...input,
        manifests: [...input.manifests, { path: 'package.json', content: bytes('other') }],
      }),
    ).toThrow(TypeError);
  });
});
