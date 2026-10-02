import { afterEach, describe, expect, it } from 'vitest';
import { AutoCompactWindowTokens, DEFAULT_AUTO_COMPACT_WINDOW_TOKENS } from '@projectman/shared';
import { createAppHarness, createProject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';

/**
 * The compaction window (PM-212): the member's value, else the project's, else 200 000, handed to
 * the runner for every session of a Claude member, new or resumed.
 */

const general = { type: 'general' } as const;
const by = { actor: OWNER_ACTOR, author: OWNER };

describe('compaction window of a session', () => {
  let h: DomainHarness;
  afterEach(() => h.cleanup());

  const setProject = (tokens: number | undefined) =>
    h.domain.projects.update('AR', by, (config) => {
      if (tokens === undefined) delete config.team.limits.autoCompactWindowTokens;
      else config.team.limits.autoCompactWindowTokens = tokens;
      return 'Set the compaction window';
    });
  const startAndStop = async (handle: string) => {
    const { session } = await h.domain.sessions.ensureSession('AR', handle, general);
    const spec = h.runner.lastStarted();
    await h.domain.sessions.stop('AR', session.id);
    return spec;
  };

  it('is 200 000 when neither the project nor the member sets a value', async () => {
    h = await createDomainHarness();
    expect(DEFAULT_AUTO_COMPACT_WINDOW_TOKENS).toBe(200_000);
    expect((await startAndStop('dev-1')).autoCompactWindowTokens).toBe(200_000);
  });

  it('takes the project value, and the member value over it', async () => {
    h = await createDomainHarness();
    await setProject(300_000);
    expect((await startAndStop('dev-1')).autoCompactWindowTokens).toBe(300_000);

    const saved = await h.domain.members.update('AR', 'dev-1', { autoCompactWindowTokens: 150_000 }, by);
    expect(saved).toMatchObject({ autoCompactWindowTokens: 150_000 });
    expect((await startAndStop('dev-1')).autoCompactWindowTokens).toBe(150_000);
    // Another member without its own value still gets the project's.
    expect((await startAndStop('dev-2')).autoCompactWindowTokens).toBe(300_000);

    // Null removes the member's value: the project's applies again; then the default.
    const cleared = await h.domain.members.update('AR', 'dev-1', { autoCompactWindowTokens: null }, by);
    expect(cleared).not.toHaveProperty('autoCompactWindowTokens');
    expect((await startAndStop('dev-1')).autoCompactWindowTokens).toBe(300_000);
    await setProject(undefined);
    expect((await startAndStop('dev-1')).autoCompactWindowTokens).toBe(200_000);
  });

  it('is handed over on a resumed session as on a new one', async () => {
    h = await createDomainHarness();
    await h.domain.members.update('AR', 'dev-1', { autoCompactWindowTokens: 250_000 }, by);
    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', general);
    expect(h.runner.lastStarted()).toMatchObject({ resume: false, autoCompactWindowTokens: 250_000 });
    h.runner.emit({
      type: 'transcript_path',
      sessionId: session.id,
      path: '/tmp/fictional-transcript.jsonl',
    });
    h.runner.emit({ type: 'exit', sessionId: session.id, exitCode: 0, signal: null });
    await h.domain.members.update('AR', 'dev-1', { autoCompactWindowTokens: 120_000 }, by);
    await h.domain.messaging.sendToSession('AR', session.id, 'Fictional follow-up', 'owner');
    expect(h.runner.lastStarted()).toMatchObject({
      sessionId: session.id,
      resume: true,
      autoCompactWindowTokens: 120_000,
    });
  });
});

describe('compaction window limits', () => {
  it('accepts 100 000 to 1 000 000 tokens and nothing outside', () => {
    for (const ok of [100_000, 200_000, 1_000_000])
      expect(AutoCompactWindowTokens.safeParse(ok).success).toBe(true);
    for (const bad of [99_999, 1_000_001, 0, -1, 200_000.5, '200k'])
      expect(AutoCompactWindowTokens.safeParse(bad).success).toBe(false);
  });
});

describe('compaction window over the API', () => {
  let h: AppHarness;
  afterEach(async () => {
    await h.close();
  });

  it('refuses a member value below 100 000 and above 1 000 000, and saves one inside', async () => {
    h = await createAppHarness();
    const cookie = await setupOwner(h.app);
    await createProject(h, cookie);
    const patch = (payload: object) =>
      h.app.inject({ method: 'PATCH', url: '/api/projects/AR/members/dev-1', headers: { cookie }, payload });
    expect((await patch({ autoCompactWindowTokens: 99_999 })).statusCode).toBe(400);
    expect((await patch({ autoCompactWindowTokens: 1_000_001 })).statusCode).toBe(400);
    const saved = await patch({ autoCompactWindowTokens: 200_000 });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ autoCompactWindowTokens: 200_000 });
    expect((await patch({ autoCompactWindowTokens: null })).json()).not.toHaveProperty(
      'autoCompactWindowTokens',
    );
  });

  it('saves the project value through the configuration patch and refuses one outside the range', async () => {
    h = await createAppHarness();
    const cookie = await setupOwner(h.app);
    await createProject(h, cookie);
    const config = async () =>
      (await h.app.inject({ method: 'GET', url: '/api/projects/AR/config', headers: { cookie } })).json();
    const patch = async (limits: object) =>
      h.app.inject({
        method: 'PATCH',
        url: '/api/projects/AR/config',
        headers: { cookie },
        payload: { baseVersion: (await config()).version, limits },
      });
    expect((await patch({ autoCompactWindowTokens: 50_000 })).statusCode).toBe(400);
    expect((await patch({ autoCompactWindowTokens: 2_000_000 })).statusCode).toBe(400);
    expect((await patch({ autoCompactWindowTokens: 400_000 })).statusCode).toBe(200);
    expect((await config()).config.team.limits.autoCompactWindowTokens).toBe(400_000);
    expect((await patch({ autoCompactWindowTokens: null })).statusCode).toBe(200);
    expect((await config()).config.team.limits).not.toHaveProperty('autoCompactWindowTokens');
  });
});
