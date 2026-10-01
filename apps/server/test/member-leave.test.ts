import { afterEach, describe, expect, it } from 'vitest';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { waitFor } from '../src/runner/test-helpers';

const onLeave = { code: 'member_on_leave', status: 409 };

describe('members on leave (decision 23)', () => {
  let h: DomainHarness;
  afterEach(() => h?.cleanup());

  const by = () => ({ actor: OWNER_ACTOR, author: OWNER });
  const setLeave = (handle: string, leave: boolean) =>
    h.domain.members.update('AR', handle, { onLeave: leave }, by());
  const taskItem = (taskKey: string) => ({ type: 'task', taskKey }) as const;

  it('shows the leave on the member and reverts it when the member is called back', async () => {
    h = await createDomainHarness();
    expect((await setLeave('dev-1', true)).onLeave).toBe(true);
    expect(
      (await h.domain.projects.config('AR')).team.members.find((m) => m.handle === 'dev-1'),
    ).toMatchObject({
      onLeave: true,
    });
    const view = await setLeave('dev-1', false);
    expect(view.onLeave).toBeUndefined();
    const stored = (await h.domain.projects.config('AR')).team.members.find((m) => m.handle === 'dev-1');
    expect(stored).not.toHaveProperty('onLeave');
  });

  it('applies to AI members only', async () => {
    h = await createDomainHarness();
    await expect(setLeave('owner', true)).rejects.toMatchObject({ code: 'not_ai_member' });
  });

  it('stops the running sessions of a member sent on leave and resumes them after the call-back', async () => {
    h = await createDomainHarness();
    const task = await h.domain.tasks.create('AR', { title: 'Fictional feature' }, OWNER_ACTOR);
    const { session } = await h.domain.taskStarts
      .start('AR', task.key, {
        assignee: 'dev-1',
        actor: OWNER_ACTOR,
        author: OWNER,
      })
      .then((result) => ({ session: result.session! }));
    // The conversation exists, so that the session can be resumed later.
    h.runner.emit({
      type: 'transcript_path',
      sessionId: session.id,
      path: '/tmp/fictional-transcript.jsonl',
    });
    expect(h.runner.isRunning(session.id)).toBe(true);

    await setLeave('dev-1', true);
    await waitFor(() => !h.runner.isRunning(session.id));
    expect(h.domain.sessions.get('AR', session.id).state).toBe('exited');

    await setLeave('dev-1', false);
    await h.domain.sessions.ensureSession('AR', 'dev-1', taskItem(task.key));
    expect(h.runner.lastStarted()).toMatchObject({ sessionId: session.id, resume: true });
  });

  it('starts no session for a member on leave, whoever asks', async () => {
    h = await createDomainHarness();
    const task = await h.domain.tasks.create('AR', { title: 'Fictional feature' }, OWNER_ACTOR);
    await setLeave('dev-1', true);
    await expect(
      h.domain.taskStarts.start('AR', task.key, { assignee: 'dev-1', actor: OWNER_ACTOR, author: OWNER }),
    ).rejects.toMatchObject(onLeave);
    await expect(h.domain.messageStarts.startConversation('AR', 'dev-1')).rejects.toMatchObject(onLeave);
    await expect(h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'general' })).rejects.toMatchObject(
      onLeave,
    );
    expect(h.domain.tasks.get('AR', task.key).assignee).toBeNull();
    expect(h.runner.started).toHaveLength(0);
  });

  it('refuses a person writing into the stopped session of a member on leave', async () => {
    h = await createDomainHarness();
    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'general' });
    h.runner.emit({
      type: 'transcript_path',
      sessionId: session.id,
      path: '/tmp/fictional-transcript.jsonl',
    });
    await setLeave('dev-1', true);
    await waitFor(() => !h.runner.isRunning(session.id));
    const messages = h.repos.messages.list('AR').length;
    await expect(
      h.domain.messaging.sendToSession('AR', session.id, 'Fictional follow-up', 'owner'),
    ).rejects.toMatchObject(onLeave);
    expect(h.repos.messages.list('AR')).toHaveLength(messages);
    expect(h.runner.started).toHaveLength(1);
  });

  it('picks another developer when a task starts without an assignee', async () => {
    h = await createDomainHarness();
    await setLeave('dev-1', true);
    const task = await h.domain.tasks.create('AR', { title: 'Fictional feature' }, OWNER_ACTOR);
    const result = await h.domain.taskStarts.start('AR', task.key, { actor: OWNER_ACTOR, author: OWNER });
    expect(result.task.assignee).toBe('dev-2');
  });

  it('refuses a current assignee on leave instead of replacing it', async () => {
    h = await createDomainHarness();
    const task = await h.domain.tasks.create('AR', { title: 'Fictional feature' }, OWNER_ACTOR);
    h.domain.tasks.assign('AR', task.key, 'dev-1', OWNER_ACTOR);
    await setLeave('dev-1', true);
    await expect(
      h.domain.taskStarts.start('AR', task.key, { actor: OWNER_ACTOR, author: OWNER }),
    ).rejects.toMatchObject(onLeave);
    expect(h.domain.tasks.get('AR', task.key).assignee).toBe('dev-1');
  });

  it('does not let a member on leave be named the assignee, but keeps one it already has', async () => {
    h = await createDomainHarness();
    const task = await h.domain.tasks.create('AR', { title: 'Fictional feature' }, OWNER_ACTOR);
    await setLeave('dev-1', true);
    await expect(
      h.domain.tasks.update('AR', task.key, { assignee: 'dev-1' }, OWNER_ACTOR),
    ).rejects.toMatchObject(onLeave);
    expect(h.domain.tasks.get('AR', task.key).assignee).toBeNull();

    await setLeave('dev-1', false);
    await h.domain.tasks.update('AR', task.key, { assignee: 'dev-1' }, OWNER_ACTOR);
    await setLeave('dev-1', true);
    await expect(
      h.domain.tasks.update('AR', task.key, { assignee: 'dev-1', title: 'Fictional rename' }, OWNER_ACTOR),
    ).resolves.toMatchObject({ assignee: 'dev-1', title: 'Fictional rename' });
  });

  it('defers a hand-over to a reviewer on leave and starts it after the call-back', async () => {
    h = await createDomainHarness();
    await setLeave('cr', true);
    const task = await h.domain.tasks.create('AR', { title: 'Fictional review' }, OWNER_ACTOR);
    await h.domain.tasks.moveToStage('AR', task.key, 'code_review', OWNER_ACTOR);
    const waiting = await waitFor(() => h.domain.tasks.get('AR', task.key).startWaiting);
    expect(waiting).toMatchObject({ reason: 'member_on_leave', member: 'cr' });
    await h.domain.admission.retryDeferred();
    expect(h.runner.started).toHaveLength(0);

    await setLeave('cr', false);
    await waitFor(() => h.domain.sessions.findRunning('AR', 'cr', taskItem(task.key)));
    expect(h.domain.tasks.get('AR', task.key).startWaiting).toBeUndefined();
  });

  it('hands a review to another owner of the stage while one is on leave', async () => {
    h = await createDomainHarness({
      adjust: (config) => {
        config.team.members.push({
          kind: 'ai',
          handle: 'cr-2',
          displayName: 'Second reviewer',
          role: 'code_review',
          sponsor: 'owner',
          capacity: 1,
          model: 'opus',
          permissionMode: 'default',
          instructions: '',
          temp: false,
        });
        config.pipeline.stages.find((stage) => stage.id === 'code_review')!.owners!.push('cr-2');
      },
    });
    await setLeave('cr', true);
    const task = await h.domain.tasks.create('AR', { title: 'Fictional review' }, OWNER_ACTOR);
    await h.domain.tasks.moveToStage('AR', task.key, 'code_review', OWNER_ACTOR);
    await waitFor(() => h.domain.sessions.findRunning('AR', 'cr-2', taskItem(task.key)));
    expect(h.domain.sessions.findRunning('AR', 'cr', taskItem(task.key))).toBeNull();
    expect(h.domain.tasks.get('AR', task.key).startWaiting).toBeUndefined();
  });

  it('keeps messages for a member on leave and delivers them after the call-back', async () => {
    h = await createDomainHarness();
    await setLeave('dev-1', true);
    const task = await h.domain.tasks.create('AR', { title: 'Fictional question' }, OWNER_ACTOR);
    const message = await h.domain.messaging.send('AR', 'owner', {
      to: ['dev-1'],
      text: 'Inspect this fictional task.',
      taskKey: task.key,
    });
    const waiting = await waitFor(() => h.domain.tasks.get('AR', task.key).startWaiting);
    expect(waiting).toMatchObject({ reason: 'member_on_leave', member: 'dev-1' });
    expect(h.repos.messages.get(message.id)?.deliveredAt).toBeNull();
    expect(h.runner.started).toHaveLength(0);

    await setLeave('dev-1', false);
    await waitFor(() => h.repos.messages.get(message.id)?.deliveredAt);
    expect(h.runner.started).toHaveLength(1);
    expect(h.runner.messages.some((m) => m.text.includes(message.body))).toBe(true);
    expect(h.domain.tasks.get('AR', task.key).startWaiting).toBeUndefined();
  });

  it('skips the scheduled run of a member on leave and says why', async () => {
    h = await createDomainHarness({
      adjust: (config) => {
        const dev = config.team.members.find((m) => m.handle === 'dev-1');
        if (dev?.kind === 'ai') dev.schedule = { cron: '0 9 * * *', prompt: 'Check the fictional board.' };
      },
    });
    await setLeave('dev-1', true);
    const run = await h.domain.schedules.runNow('AR', 'dev-1');
    expect(run).toMatchObject({ status: 'skipped', reason: 'member_on_leave' });
    expect(h.runner.started).toHaveLength(0);
  });
});
