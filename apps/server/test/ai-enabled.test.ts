import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TeamLimits } from '@projectman/shared';
import { DEFAULT_LIMITS } from '../../../packages/templates/src/templates/draft';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { createAppHarness, createProject, setupOwner } from './helpers/app-harness';
import { waitFor } from '../src/runner/test-helpers';

const disabled = { code: 'ai_disabled', status: 409 };

describe('project AI switch', () => {
  let h: DomainHarness;
  afterEach(() => h?.cleanup());

  async function setEnabled(aiEnabled: boolean) {
    await h.domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (config) => {
      config.team.limits.aiEnabled = aiEnabled;
      return 'Set AI admission';
    });
  }

  it('refuses manual AI starts before moving or assigning the task', async () => {
    h = await createDomainHarness({ adjust: (c) => void (c.team.limits.aiEnabled = false) });
    const task = await h.domain.tasks.create('AR', { title: 'Fictional feature' }, OWNER_ACTOR);
    await expect(
      h.domain.taskStarts.start('AR', task.key, { actor: OWNER_ACTOR, author: OWNER }),
    ).rejects.toMatchObject(disabled);
    expect(h.domain.tasks.get('AR', task.key)).toEqual(task);
    expect(h.runner.started).toHaveLength(0);
  });

  it('keeps the switch local to its project and allows human task starts', async () => {
    h = await createDomainHarness({
      adjust: (config) => {
        config.team.limits.aiEnabled = false;
        config.pipeline.stages.find((stage) => stage.kind === 'work')!.owners!.push('owner');
      },
    });
    await h.domain.projects.create(
      { key: 'BR', name: 'Fictional enabled project', workspacePath: h.workspace, templateId: 'test' },
      OWNER,
    );
    expect((await h.domain.sessions.ensureSession('BR', 'dev-1', { type: 'general' })).started).toBe(true);
    const task = await h.domain.tasks.create('AR', { title: 'Fictional human work' }, OWNER_ACTOR);
    const result = await h.domain.taskStarts.start('AR', task.key, {
      assignee: 'owner',
      actor: OWNER_ACTOR,
      author: OWNER,
    });
    expect(result.session).toBeNull();
    expect(result.task.assignee).toBe('owner');
    expect(h.runner.started).toHaveLength(1);
  });

  it('checks the switch before concurrency and plan usage', async () => {
    h = await createDomainHarness();
    await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'general' });
    const config = await h.domain.projects.config('AR');
    config.team.limits.aiEnabled = false;
    config.team.limits.maxConcurrentAi = 1;
    let usageRequested = false;
    h.domain.runnerModule.planUsageFor = () => ({
      get: async () => {
        usageRequested = true;
        return null;
      },
    });
    await expect(h.domain.admission.check({ config })).rejects.toMatchObject(disabled);
    expect(usageRequested).toBe(false);
  });

  it('defers a hand-over and starts it once the switch is turned on', async () => {
    h = await createDomainHarness({ adjust: (c) => void (c.team.limits.aiEnabled = false) });
    const task = await h.domain.tasks.create('AR', { title: 'Fictional review' }, OWNER_ACTOR);
    await h.domain.tasks.moveToStage('AR', task.key, 'code_review', OWNER_ACTOR);
    const waiting = await waitFor(() => h.domain.tasks.get('AR', task.key).startWaiting);
    expect(waiting).toMatchObject({ reason: 'ai_disabled', member: 'cr' });
    expect(h.runner.started).toHaveLength(0);
    await h.domain.admission.retryDeferred();
    expect(h.domain.tasks.get('AR', task.key).startWaiting).toEqual(waiting);
    await setEnabled(true);
    await waitFor(() => h.domain.sessions.findRunning('AR', 'cr', { type: 'task', taskKey: task.key }));
    expect(h.domain.tasks.get('AR', task.key).startWaiting).toBeUndefined();
    await h.domain.admission.retryDeferred();
    expect(h.runner.started).toHaveLength(1);
  });

  it('retains queued task messages and delivers them after re-enabling AI', async () => {
    h = await createDomainHarness({ adjust: (c) => void (c.team.limits.aiEnabled = false) });
    const task = await h.domain.tasks.create('AR', { title: 'Fictional question' }, OWNER_ACTOR);
    const message = await h.domain.messaging.send('AR', 'owner', {
      to: ['dev-1'],
      text: 'Inspect this fictional task.',
      taskKey: task.key,
    });
    await waitFor(() => h.domain.tasks.get('AR', task.key).startWaiting);
    expect(h.domain.tasks.get('AR', task.key).startWaiting?.reason).toBe('ai_disabled');
    expect(h.repos.messages.get(message.id)?.deliveredAt).toBeNull();
    await setEnabled(true);
    await waitFor(() => h.repos.messages.get(message.id)?.deliveredAt);
    expect(h.runner.started).toHaveLength(1);
    expect(h.runner.messages.some((m) => m.text.includes(message.body))).toBe(true);
  });

  it('allows running sessions and human messages, but refuses stopped-session resumes and direct starts', async () => {
    h = await createDomainHarness();
    const workItem = { type: 'general' } as const;
    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', workItem);
    await setEnabled(false);
    expect(h.runner.isRunning(session.id)).toBe(true);
    expect((await h.domain.sessions.ensureSession('AR', 'dev-1', workItem)).started).toBe(false);
    expect((await h.domain.messageStarts.startConversation('AR', 'dev-1')).id).toBe(session.id);
    await h.domain.messaging.sendToSession('AR', session.id, 'Fictional follow-up', 'owner');
    h.runner.emit({
      type: 'transcript_path',
      sessionId: session.id,
      path: '/tmp/fictional-transcript.jsonl',
    });
    h.runner.emit({ type: 'exit', sessionId: session.id, exitCode: 0, signal: null });
    const messageCount = h.repos.messages.list('AR').length;
    await expect(
      h.domain.messaging.sendToSession('AR', session.id, 'Resume please', 'owner'),
    ).rejects.toMatchObject(disabled);
    await expect(h.domain.sessions.ensureSession('AR', 'dev-1', workItem)).rejects.toMatchObject(disabled);
    await expect(h.domain.sessions.ensureSession('AR', 'dev-2', workItem)).rejects.toMatchObject(disabled);
    await expect(h.domain.messageStarts.startConversation('AR', 'dev-2')).rejects.toMatchObject(disabled);
    expect(h.domain.sessions.get('AR', session.id).state).toBe('exited');
    expect(h.repos.messages.list('AR')).toHaveLength(messageCount);
    expect(h.runner.started).toHaveLength(1);
    await setEnabled(true);
    await h.domain.messaging.sendToSession('AR', session.id, 'Resume please', 'owner');
    expect(h.runner.lastStarted()).toMatchObject({ sessionId: session.id, resume: true });
  });

  it('refuses a start if AI is disabled during asynchronous preparation', async () => {
    h = await createDomainHarness();
    let release!: () => void;
    const prepared = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reading = false;
    h.memory.read = async () => {
      reading = true;
      await prepared;
      return '';
    };
    const start = h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'general' });
    await waitFor(() => reading);
    await setEnabled(false);
    release();
    await expect(start).rejects.toMatchObject(disabled);
    expect(h.runner.started).toHaveLength(0);
    expect(h.domain.sessions.list('AR')).toHaveLength(0);
  });

  it('skips a scheduled occurrence while AI is disabled', async () => {
    const at = new Date('2026-09-30T08:29:00Z');
    h = await createDomainHarness({
      now: () => at,
      adjust: (config) => {
        config.team.limits.aiEnabled = false;
        const member = config.team.members.find((m) => m.handle === 'dev-1')!;
        if (member.kind === 'ai')
          member.schedule = { cron: '30 8 * * *', prompt: 'Inspect fictional maintenance.' };
      },
    });
    at.setUTCMinutes(30);
    await h.domain.schedules.check();
    expect(h.repos.schedules.list('AR')[0]).toMatchObject({
      status: 'skipped',
      reason: 'ai_disabled',
      sessionId: null,
    });
    expect(h.domain.timeline.list('AR').find((e) => e.type === 'schedule_skipped')?.data.reason).toBe(
      'ai_disabled',
    );
    expect(h.runner.started).toHaveLength(0);
    await setEnabled(true);
    await h.domain.schedules.check();
    expect(h.runner.started).toHaveLength(0);
    const running = await h.domain.schedules.runNow('AR', 'dev-1');
    await setEnabled(false);
    expect(await h.domain.schedules.runNow('AR', 'dev-1')).toMatchObject({
      status: 'skipped',
      reason: 'ai_disabled',
    });
    expect(h.runner.isRunning(running.sessionId!)).toBe(true);
  });

  it('loads legacy YAML as enabled and preserves a disabled switch through YAML saves', async () => {
    h = await createDomainHarness();
    expect(TeamLimits.parse(DEFAULT_LIMITS).aiEnabled).toBe(true);
    expect(TeamLimits.parse({}).aiEnabled).toBe(true);
    const file = join(h.configStore.rootDir, 'projects/AR/project.yaml');
    const legacy = readFileSync(file, 'utf8').replace(/^\s*aiEnabled: true\n/m, '');
    writeFileSync(file, legacy);
    expect((await h.configStore.load('AR')).config.team.limits.aiEnabled).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(legacy);
    await setEnabled(false);
    expect(readFileSync(file, 'utf8')).toContain('aiEnabled: false');
    expect((await h.configStore.load('AR')).config.team.limits.aiEnabled).toBe(false);
  });
});

it('returns HTTP 409 ai_disabled for a manual task start without moving the task', async () => {
  const h = await createAppHarness();
  try {
    const cookie = await setupOwner(h.app);
    await createProject(h, cookie);
    const current = await h.app.projectman.domain.projects.load('AR');
    const patch = await h.app.inject({
      method: 'PATCH',
      url: '/api/projects/AR/config',
      headers: { cookie },
      payload: { baseVersion: current.version, limits: { aiEnabled: false } },
    });
    expect(patch.statusCode).toBe(200);
    const created = await h.app.inject({
      method: 'POST',
      url: '/api/projects/AR/tasks',
      headers: { cookie },
      payload: { title: 'Fictional manual task' },
    });
    const task = created.json();
    const result = await h.app.inject({
      method: 'POST',
      url: `/api/projects/AR/tasks/${task.key}/start`,
      headers: { cookie },
      payload: {},
    });
    expect(result.statusCode).toBe(409);
    expect(result.json()).toMatchObject({ error: { code: 'ai_disabled' } });
    expect(h.app.projectman.domain.tasks.get('AR', task.key)).toEqual(task);
    expect(h.runner.started).toHaveLength(0);
  } finally {
    await h.close();
  }
});
