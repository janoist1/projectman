import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigHistoryView, routes } from '@projectman/shared';
import type { ConfigView } from '@projectman/shared';
import { addHumanAndLogin, createAppHarness, createProject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { ConfigStoreError } from '../src/config';

describe('configuration history page', () => {
  let h: AppHarness;
  let cookie: string;
  beforeEach(async () => {
    h = await createAppHarness();
    cookie = await setupOwner(h.app);
    await createProject(h, cookie);
  });
  afterEach(async () => h.close());

  const page = (query = '', session = cookie) =>
    h.app.inject({
      method: 'GET',
      url: `${routes.configHistory('AR')}${query}`,
      headers: { cookie: session },
    });
  const read = async (query = '') => ConfigHistoryView.parse((await page(query)).json());

  async function patch(payload: object) {
    const current = (
      await h.app.inject({ method: 'GET', url: routes.config('AR'), headers: { cookie } })
    ).json<ConfigView>();
    const response = await h.app.inject({
      method: 'PATCH',
      url: routes.patchConfig('AR'),
      headers: { cookie },
      payload: { baseVersion: current.version, ...payload },
    });
    expect(response.statusCode).toBe(200);
    return response.json<ConfigView>();
  }

  it('says what each saved version changed, the first one is the creation', async () => {
    await patch({ message: 'Rename', project: { name: 'Acme webshop' } });
    await patch({ message: 'Limit', limits: { maxConcurrentAi: 2 } });
    const { entries, total } = await read();
    expect(total).toBe(3);
    expect(entries.map((entry) => entry.changes)).toEqual([
      [{ kind: 'section_changed', section: 'limits' }],
      [{ kind: 'section_changed', section: 'project' }],
      [{ kind: 'created' }],
    ]);
    expect(entries[0]).toMatchObject({ message: 'Limit', version: expect.any(String) });
  });

  it('recognises a revert from its message, with no changes of its own to show', async () => {
    const created = (await patch({ message: 'Rename', project: { name: 'Acme webshop' } })).history[1]!;
    await patch({ message: 'Limit', limits: { maxConcurrentAi: 2 } });
    const reverted = await h.app.inject({
      method: 'POST',
      url: routes.revertConfig('AR'),
      headers: { cookie },
      payload: { version: created.version },
    });
    expect(reverted.statusCode).toBe(200);
    const { entries } = await read();
    expect(entries[0]!.restores).toMatchObject({ kind: 'revert', version: created.version.slice(0, 12) });
    expect(entries[1]!.restores).toBeUndefined();
  });

  it('returns the outdated-version error code through the restore endpoint', async () => {
    vi.spyOn(h.app.projectman.configStore, 'loadVersion').mockRejectedValueOnce(
      new ConfigStoreError('config_version_outdated', 'Unsupported version format'),
    );
    const response = await h.app.inject({
      method: 'POST',
      url: routes.revertConfig('AR'),
      headers: { cookie },
      payload: { version: 'abcd1234' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('config_version_outdated');
  });

  it('recognises an undo: a save that brings back the configuration of two versions before', async () => {
    await patch({ message: 'Rename', project: { name: 'Acme webshop' } });
    await patch({ message: 'Rename back', project: { name: 'acme' } });
    const { entries } = await read();
    expect(entries[0]!.restores).toEqual({
      kind: 'undo',
      version: entries[1]!.version,
      changes: [{ kind: 'section_changed', section: 'project' }],
    });
    expect(entries[1]!.restores).toBeUndefined();
  });

  it('pages with limit and offset', async () => {
    for (const name of ['One', 'Two', 'Three']) await patch({ message: name, project: { name } });
    const first = await read('?limit=2');
    expect(first.total).toBe(4);
    expect(first.entries.map((entry) => entry.message)).toEqual(['Three', 'Two']);
    const rest = await read('?limit=2&offset=2');
    expect(rest.entries.map((entry) => entry.message)).toEqual(['One', expect.any(String)]);
    expect(rest.entries[1]!.changes).toEqual([{ kind: 'created' }]);
    expect((await read('?offset=10')).entries).toEqual([]);
  });

  it.each(['limit=0', 'limit=51', 'limit=x', 'offset=-1'])('refuses the query %s', async (query) => {
    const response = await page(`?${query}`);
    expect(response.statusCode).toBe(400);
  });

  it('turns away the signed-out, and a signed-in person outside the project', async () => {
    const signedOut = await h.app.inject({ method: 'GET', url: routes.configHistory('AR') });
    expect(signedOut.statusCode).toBe(401);
    const stranger = await addHumanAndLogin(h.app, { handle: 'sam', projectKey: null });
    const outsider = await page('', stranger);
    expect(outsider.statusCode).toBe(403);
    expect(outsider.json<{ error: { code: string } }>().error.code).toBe('not_a_member');
  });
});
