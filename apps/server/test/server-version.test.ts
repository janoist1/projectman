import { afterEach, describe, expect, it } from 'vitest';
import { routes, ServerVersionView } from '@projectman/shared';
import type { Release } from '@projectman/shared';
import { createAppHarness, inject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';

const COMMIT = 'abcdef0123456789'.repeat(2) + 'abcdef01';

function release(id: string, state: Release['state'], tag: string, publishedAt: string): Release {
  return {
    id,
    state,
    tag,
    publishedAt,
    projectKey: 'AR',
    repo: 'web',
    taskKey: 'AR-1',
    commit: COMMIT,
    baseCommit: null,
    tasks: [],
    summary: 'Release',
    proposedBy: 'owner',
    proposedAt: publishedAt,
    decidedBy: null,
    decidedAt: null,
    deployStartedAt: null,
    previousCommit: null,
    liveAt: publishedAt,
    url: null,
    failure: null,
    publishError: null,
  };
}

describe('server version API', () => {
  let h: AppHarness | undefined;
  afterEach(async () => {
    await h?.close();
  });

  async function start(version = COMMIT, appTag?: () => Promise<string | null>) {
    h = await createAppHarness({ app: { appVersion: version, ...(appTag ? { appTag } : {}) } });
    const cookie = await setupOwner(h.app);
    return {
      ...h.app.projectman,
      read: () => inject(h!.app, 'GET', routes.serverVersion(), cookie),
    };
  }

  it('reads a published tag without a release target or project membership', async () => {
    const { repos, read } = await start();
    repos.releases.insert(
      release('rel_legacy', 'published', 'v2026.10.23.2', '2026-10-23T09:00:00Z'),
      '2026-10-23T09:00:00Z',
    );
    repos.releasePublications.insert({
      id: 'rpub_version',
      projectKey: 'AR',
      repo: 'web',
      commit: COMMIT,
      baseCommit: null,
      tag: 'v2026.10.23',
      tasks: [],
      summary: 'Release',
      publishedBy: 'owner',
      taggedAt: '2026-10-23T08:00:00Z',
      url: 'https://github.com/acme/web/releases/tag/v2026.10.23',
      publishedAt: '2026-10-23T08:00:00Z',
    });
    const response = await read();
    expect(response.statusCode).toBe(200);
    expect(ServerVersionView.parse(response.json())).toEqual({
      version: COMMIT,
      commit: COMMIT,
      tag: 'v2026.10.23',
    });
  });

  it('falls back to the newest published legacy release for the running commit', async () => {
    const { repos, read } = await start();
    const at = '2026-10-23T08:00:00Z';
    repos.releases.insert(release('rel_old', 'published', 'v2026.10.22', '2026-10-22T08:00:00Z'), at);
    repos.releases.insert(release('rel_new', 'published', 'v2026.10.23', at), at);
    repos.releases.insert(release('rel_live', 'live', 'v2026.10.24', '2026-10-24T08:00:00Z'), at);
    repos.releases.insert(
      { ...release('rel_other', 'published', 'v2026.10.25', '2026-10-25T08:00:00Z'), commit: 'b'.repeat(40) },
      at,
    );
    expect((await read()).json().tag).toBe('v2026.10.23');
  });

  it.each([COMMIT, 'a'.repeat(64)])('returns an unpublished commit: %s', async (commit) => {
    const { read } = await start(commit);
    expect((await read()).json()).toEqual({ version: commit, commit, tag: null });
  });

  it.each(['dev', 'custom-build'])('keeps a non-commit version: %s', async (version) => {
    const { read } = await start(version);
    expect((await read()).json()).toEqual({ version, commit: null, tag: null });
  });

  it('falls back to the running build tag', async () => {
    const { read } = await start(COMMIT, async () => 'v2026.10.22');
    expect((await read()).json().tag).toBe('v2026.10.22');
  });

  it('keeps the version when the tag reader fails', async () => {
    const { read } = await start(COMMIT, async () => {
      throw new Error('Unavailable');
    });
    expect((await read()).json()).toEqual({ version: COMMIT, commit: COMMIT, tag: null });
  });

  it('requires authentication', async () => {
    await start();
    expect((await inject(h!.app, 'GET', routes.serverVersion())).statusCode).toBe(401);
  });

  it.each(['legacy', 'read', 'super'] as const)('allows an integrator in %s mode', async (mode) => {
    const { auth, repos } = await start();
    const userId = repos.users.list()[0]!.id;
    const key =
      mode === 'legacy'
        ? auth.createIntegratorKey(userId, null)
        : auth.createIntegratorAccessKey(userId, { mode, expiresInDays: 7 });
    const response = await h!.app.inject({
      method: 'GET',
      url: routes.serverVersion(),
      headers: { authorization: `Bearer ${key.secret}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().commit).toBe(COMMIT);
  });
});
