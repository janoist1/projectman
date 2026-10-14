import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from '@projectman/shared';
import type { InboxItem } from '@projectman/shared';
import { createAppHarness, createProject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import type { Domain } from '../src/assembly';
import { OWNER, OWNER_ACTOR } from './helpers/domain-harness';

describe('inbox asker admission preview', () => {
  let h: AppHarness;
  let domain: Domain;
  let cookie: string;
  beforeEach(async () => {
    h = await createAppHarness({ app: { claudeTmpRoots: [] } });
    domain = h.app.projectman.domain;
    cookie = await setupOwner(h.app);
    await createProject(h, cookie);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await h?.close();
  });
  const question = (source = 'dev-1', assignees = ['owner']) =>
    domain.inbox.create({
      projectKey: 'AR',
      kind: 'question',
      source,
      assignees,
      title: 'Which layout?',
      payload: { question: 'Which layout?' },
      options: [{ id: 'answer', label: 'answer', style: 'primary' }],
    });
  const get = async (query = '') => {
    const response = await h.app.inject({
      method: 'GET',
      url: routes.inbox('AR') + query,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    return response.json<{ items: InboxItem[] }>().items;
  };
  const update = (patch: { onLeave?: boolean; capacity?: number }) =>
    domain.members.update('AR', 'dev-1', patch, { actor: OWNER_ACTOR, author: OWNER });

  it('previews leave and capacity, but stores no preview and returns delivery on resolve', async () => {
    const item = question();
    expect((await get())[0]?.askerStart).toBeUndefined();
    await update({ onLeave: true });
    expect((await get())[0]?.askerStart).toEqual({ reason: 'member_on_leave' });
    expect(domain.inbox.get('AR', item.id).askerStart).toBeUndefined();
    await update({ onLeave: false, capacity: 1 });
    await domain.tasks.create('AR', { title: 'Other work' }, OWNER_ACTOR);
    await domain.sessions.ensureSession('AR', 'dev-1', { type: 'task', taskKey: 'AR-1' });
    expect((await get())[0]?.askerStart).toEqual({ reason: 'member_at_capacity' });
    const response = await h.app.inject({
      method: 'POST',
      url: routes.resolveInbox('AR', item.id),
      headers: { cookie },
      payload: { optionId: 'answer', note: 'First' },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<InboxItem>().payload.answerDelivery).toMatchObject({
      state: 'waiting',
      reason: 'member_at_capacity',
    });
  });

  it('checks each visible asker and work item once and skips non-AI questions', async () => {
    question();
    question();
    question('owner');
    question('dev-2', ['other']);
    const preview = vi.spyOn(domain.messageStarts, 'waitingReason');
    expect(await get('?mine=true')).toHaveLength(3);
    expect(preview).toHaveBeenCalledTimes(1);
    expect(preview).toHaveBeenCalledWith('AR', 'dev-1', { type: 'general' });
  });

  it('omits unsupported refusals and tolerates preview errors', async () => {
    question();
    vi.spyOn(domain.admission, 'check').mockRejectedValueOnce(new Error('Unavailable probe'));
    expect((await get())[0]?.askerStart).toBeUndefined();
    vi.spyOn(domain.admission, 'check').mockRejectedValueOnce({ code: 'disk_low' });
    expect((await get())[0]?.askerStart).toBeUndefined();
  });
});
