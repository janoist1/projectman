import { afterEach, describe, expect, it } from 'vitest';
import type { UpdateMemberRequest } from '@projectman/shared';
import { createAppHarness, createProject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { rejection } from './helpers/errors';

/** The cheap subagent (PM-179): a member setting that starts its sessions with a reader on a cheaper model. */

const general = { type: 'general' } as const;
const by = { actor: OWNER_ACTOR, author: OWNER };

describe('cheap subagent', () => {
  let h: DomainHarness;
  afterEach(() => h.cleanup());

  const update = (handle: string, body: UpdateMemberRequest) =>
    h.domain.members.update('AR', handle, body, by);
  const memberConfig = async (handle: string) =>
    (await h.domain.projects.config('AR')).team.members.find((m) => m.handle === handle);
  const startAndStop = async (handle: string) => {
    const { session } = await h.domain.sessions.ensureSession('AR', handle, general);
    const spec = h.runner.lastStarted();
    await h.domain.sessions.stop('AR', session.id);
    return spec;
  };

  it('is off for a configuration without it, and the session starts as before', async () => {
    h = await createDomainHarness();
    expect(await memberConfig('dev-1')).not.toHaveProperty('cheapSubagent');
    expect((await h.domain.members.roster('AR')).find((m) => m.handle === 'dev-1')).not.toHaveProperty(
      'cheapSubagent',
    );
    await h.domain.sessions.ensureSession('AR', 'dev-1', general);
    expect(h.runner.lastStarted()).not.toHaveProperty('subagents');
  });

  it('is saved in the configuration and starts the next session with the reader on its model', async () => {
    h = await createDomainHarness();
    expect(await update('dev-1', { cheapSubagent: 'haiku' })).toMatchObject({ cheapSubagent: 'haiku' });
    expect(await memberConfig('dev-1')).toMatchObject({ cheapSubagent: 'haiku' });
    expect((await startAndStop('dev-1')).subagents).toEqual([
      expect.objectContaining({
        name: 'reader-haiku',
        model: 'haiku',
        tools: ['Read', 'Bash'],
      }),
    ]);

    await update('dev-1', { cheapSubagent: 'sonnet' });
    expect((await startAndStop('dev-1')).subagents).toEqual([
      expect.objectContaining({ name: 'reader-sonnet', model: 'sonnet' }),
    ]);

    // Null switches it off: the field leaves the configuration and the session has no subagent.
    const off = await update('dev-1', { cheapSubagent: null });
    expect(off).not.toHaveProperty('cheapSubagent');
    expect(await memberConfig('dev-1')).not.toHaveProperty('cheapSubagent');
    expect(await startAndStop('dev-1')).not.toHaveProperty('subagents');
  });

  it('gives a Codex member no subagent, and keeps the setting for a switch back to Claude Code', async () => {
    h = await createDomainHarness();
    await update('dev-2', { cheapSubagent: 'haiku', provider: 'codex' });
    expect(await memberConfig('dev-2')).toMatchObject({ provider: 'codex', cheapSubagent: 'haiku' });
    const codex = await startAndStop('dev-2');
    expect(codex.provider).toBe('codex');
    expect(codex).not.toHaveProperty('subagents');

    await update('dev-2', { provider: 'claude' });
    expect((await startAndStop('dev-2')).subagents).toEqual([expect.objectContaining({ model: 'haiku' })]);
  });

  it('is set on hiring, and is for AI members only', async () => {
    h = await createDomainHarness();
    const hired = await h.domain.members.hire(
      'AR',
      { role: 'developer', cheapSubagent: 'sonnet' },
      { ...by, sponsor: 'owner' },
    );
    expect(hired).toMatchObject({ cheapSubagent: 'sonnet' });
    expect(
      await rejection(h.domain.members.update('AR', 'owner', { cheapSubagent: 'haiku' }, by)),
    ).toMatchObject({ code: 'not_ai_member' });
  });
});

describe('cheap subagent over the API', () => {
  let h: AppHarness;
  afterEach(async () => {
    await h.close();
  });

  it('saves the setting and refuses a model that is not offered', async () => {
    h = await createAppHarness();
    const cookie = await setupOwner(h.app);
    await createProject(h, cookie);
    const patch = (payload: object) =>
      h.app.inject({ method: 'PATCH', url: '/api/projects/AR/members/dev-1', headers: { cookie }, payload });
    const saved = await patch({ cheapSubagent: 'haiku' });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ cheapSubagent: 'haiku' });
    expect((await patch({ cheapSubagent: 'opus' })).statusCode).toBe(400);
    const cleared = await patch({ cheapSubagent: null });
    expect(cleared.json()).not.toHaveProperty('cheapSubagent');
  });
});
