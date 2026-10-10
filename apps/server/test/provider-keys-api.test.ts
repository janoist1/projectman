import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProvidersView } from '@projectman/shared';
import { addHumanAndLogin, createAppHarness, createProject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';

describe('provider key API', () => {
  let h: AppHarness;
  const logs: string[] = [];
  afterEach(async () => {
    await h?.close();
  });
  async function setup(result: 'accepted' | 'rejected' | 'unknown' = 'accepted') {
    const check = vi.fn(async () => result);
    logs.length = 0;
    h = await createAppHarness({
      nanogptKeyCheck: check,
      app: {
        logger: {
          level: 'trace',
          stream: {
            write: (line: string) => {
              logs.push(line);
            },
          },
        },
      },
    });
    const owner = await setupOwner(h.app);
    await createProject(h, owner);
    return { owner, check };
  }
  const call = (cookie: string, method: 'GET' | 'PUT' | 'DELETE', payload?: object) =>
    h.app.inject({
      method,
      url: method === 'GET' ? '/api/providers' : '/api/providers/nanogpt/key',
      headers: { cookie },
      ...(payload ? { payload } : {}),
    });
  it('returns missing key status for corrupt secret JSON without exposing its contents', async () => {
    const { owner } = await setup();
    await call(owner, 'PUT', { key: 'test-key' });
    writeFileSync(join(h.home, 'secrets', 'nanogpt.json'), '{invalid-private-sentinel');
    const response = await call(owner, 'GET');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ keys: { nanogpt: { set: false } } });
    expect(await h.app.projectman.domain.providerKeys!.nanogptKey()).toBeNull();
    expect(logs.join('')).not.toContain('invalid-private-sentinel');
    expect((await call(owner, 'PUT', { key: 'replacement' })).statusCode).toBe(200);
  });
  it('lets the installation owner save, replace and clear without leaking into responses, configuration or database bytes', async () => {
    const { owner, check } = await setup();
    const secret = 'pm328-unique-private-sentinel';
    const saved = await call(owner, 'PUT', { key: ` ${secret} ` });
    expect(saved.statusCode).toBe(200);
    expect(check).toHaveBeenCalledWith(secret);
    expect(ProvidersView.parse(saved.json())).toMatchObject({
      keys: { nanogpt: { set: true } },
      canManageKeys: true,
    });
    expect(saved.body).not.toContain(secret);
    expect((await call(owner, 'GET')).body).not.toContain(secret);
    expect(await h.app.projectman.domain.providerKeys!.nanogptKey()).toBe(secret);
    function scan(directory: string) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (directory === h.home && entry.name === 'secrets') continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) scan(path);
        else if (entry.isFile()) expect(readFileSync(path).includes(Buffer.from(secret)), path).toBe(false);
      }
    }
    scan(h.home);
    expect(logs.join('')).not.toContain(secret);
    expect((await call(owner, 'PUT', { key: 'replacement' })).statusCode).toBe(200);
    for (let i = 0; i < 2; i++)
      expect((await call(owner, 'DELETE')).json()).toMatchObject({
        keys: { nanogpt: { set: false, setAt: null } },
      });
  });
  it.each(['developer', 'client', 'viewer', 'admin'] as const)(
    'refuses a %s before checking or storing the key',
    async (access) => {
      const { check } = await setup();
      const cookie = await addHumanAndLogin(h.app, { handle: 'human', access });
      for (const method of ['PUT', 'DELETE'] as const) {
        expect((await call(cookie, method, { key: 'secret' })).statusCode).toBe(403);
      }
      expect((await call(cookie, 'GET')).json()).toMatchObject({ canManageKeys: false });
      expect(check).not.toHaveBeenCalled();
    },
  );
  it('refuses an owner of only one project', async () => {
    const { owner, check } = await setup();
    const partial = await addHumanAndLogin(h.app, { handle: 'partial', access: 'owner' });
    const second = await h.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie: owner },
      payload: {
        key: 'OTHER',
        name: 'Other',
        workspacePath: h.workspace,
        templateId: 'test',
        repos: [{ name: 'web', path: '.', github: 'acme/other' }],
      },
    });
    expect(second.statusCode).toBe(201);
    expect((await call(partial, 'PUT', { key: 'secret' })).statusCode).toBe(403);
    expect((await call(partial, 'DELETE')).statusCode).toBe(403);
    expect(check).not.toHaveBeenCalled();
    expect((await call(owner, 'PUT', { key: 'all-project-owner' })).statusCode).toBe(200);
  });
  it('rejects invalid keys without saving and accepts an unavailable check', async () => {
    const { owner, check } = await setup('rejected');
    const refused = await call(owner, 'PUT', { key: 'rejected-secret' });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.code).toBe('nanogpt_key_rejected');
    expect(refused.body).not.toContain('rejected-secret');
    expect(logs.join('')).not.toContain('rejected-secret');
    expect(h.app.projectman.domain.providerKeys!.status().set).toBe(false);
    check.mockResolvedValueOnce('unknown');
    expect((await call(owner, 'PUT', { key: 'unknown-secret' })).statusCode).toBe(200);
    expect(await h.app.projectman.domain.providerKeys!.nanogptKey()).toBe('unknown-secret');
    expect(logs.join('')).not.toContain('unknown-secret');
  });
  it('returns safe validation and JSON errors', async () => {
    const { owner, check } = await setup();
    for (const payload of [
      ...['abc\ndef', 'abc\0def', 'ő', 'inner space'].map((key) => ({ key })),
      { key: '' },
      { key: 'x'.repeat(1001) },
      { key: 'secret', 'sentinel-secret': true },
      { key: 42 },
    ]) {
      const response = await call(owner, 'PUT', payload);
      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain('sentinel-secret');
    }
    const malformed = await h.app.inject({
      method: 'PUT',
      url: '/api/providers/nanogpt/key',
      headers: { cookie: owner, 'content-type': 'application/json' },
      payload: '{"key":"sentinel-secret"',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.body).not.toContain('sentinel-secret');
    expect(logs.join('')).not.toContain('sentinel-secret');
    expect(check).not.toHaveBeenCalled();
  });
});
