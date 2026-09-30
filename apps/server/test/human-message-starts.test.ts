import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';

describe('human messages wake idle AI members', () => {
  let h: DomainHarness;
  beforeEach(async () => {
    h = await createDomainHarness();
    await h.domain.tasks.create('AR', { title: 'Acme checkout' }, OWNER_ACTOR);
  });
  afterEach(async () => {
    await h.domain.stop();
    vi.restoreAllMocks();
    h.cleanup();
  });
  const send = (taskKey?: string) =>
    h.domain.sessions.sendTeamMessage('AR', 'owner', {
      to: ['cr'],
      text: 'Please check Acme.',
      ...(taskKey ? { taskKey } : {}),
    });

  it.each([undefined, 'AR-1'])(
    'starts the correct work item for task %s and delivers once',
    async (taskKey) => {
      const message = await send(taskKey);
      await flush();
      const sessions = h.domain.sessions.list('AR', { member: 'cr' });
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.workItem).toEqual(taskKey ? { type: 'task', taskKey } : { type: 'general' });
      expect(h.runner.messages).toEqual([
        {
          sessionId: sessions[0]!.id,
          text: taskKey
            ? '[team message from owner about AR-1]\nPlease check Acme.'
            : '[team message from owner]\nPlease check Acme.',
        },
      ]);
      expect(h.repos.messages.get(message.id)?.deliveredAt).toBeTruthy();
      await send(taskKey);
      await flush();
      expect(h.runner.started).toHaveLength(1);
      expect(h.runner.messages).toHaveLength(2);
    },
  );

  it('resumes a task at capacity and avoids delivering to an unrelated live session', async () => {
    const { session } = await h.domain.sessions.ensureSession('AR', 'cr', { type: 'task', taskKey: 'AR-1' });
    h.runner.emit({ type: 'transcript_path', sessionId: session.id, path: '/tmp/acme-transcript.jsonl' });
    await h.domain.sessions.stop('AR', session.id);
    const message = await send('AR-1');
    await flush();
    expect(h.runner.lastStarted()).toMatchObject({ sessionId: session.id, resume: true });
    expect(h.repos.messages.get(message.id)?.deliveredAt).toBeTruthy();
    await h.domain.tasks.create('AR', { title: 'Acme second checkout' }, OWNER_ACTOR);
    const refused = await send('AR-2');
    await flush();
    expect(h.runner.started).toHaveLength(2);
    expect(h.repos.messages.pending('AR', 'cr').map((entry) => entry.id)).toContain(refused.id);
    expect(h.runner.messages).toHaveLength(1);
  });

  it.each(['capacity', 'concurrency', 'usage'] as const)(
    'leaves messages queued on %s refusal and logs at info level',
    async (reason) => {
      const info = vi.spyOn(h.log.logger, 'info');
      if (reason === 'capacity') {
        h.domain.tasks.assign('AR', 'AR-1', 'cr', OWNER_ACTOR);
      } else if (reason === 'concurrency') {
        await h.domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (draft) => {
          draft.team.limits.maxConcurrentAi = 1;
          return 'Limit concurrent AI work';
        });
        await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'general' });
      } else {
        h.runnerModule.planUsage.value = {
          fiveHourPercent: 90,
          weeklyPercent: null,
          fiveHourResetsAt: null,
          weeklyResetsAt: null,
          fetchedAt: new Date().toISOString(),
        };
      }
      const before = h.runner.started.length;
      const message = await send();
      await flush();
      expect(h.runner.started).toHaveLength(before);
      expect(h.repos.messages.pending('AR', 'cr').map((entry) => entry.id)).toContain(message.id);
      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({ member: 'cr', messageId: message.id }),
        'team message session start deferred',
      );
      await flush();
      expect(h.runner.started).toHaveLength(before);
    },
  );

  it('returns before PTY startup and stop waits for the pending start', async () => {
    let release!: () => void;
    const start = h.runner.start.bind(h.runner);
    const called = vi.spyOn(h.runner, 'start').mockImplementation(async (spec) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return start(spec);
    });
    const message = await send('AR-1');
    expect(message.body).toBe('Please check Acme.');
    await vi.waitFor(() => expect(called).toHaveBeenCalledOnce());
    let stopped = false;
    const stop = h.domain.stop().then(() => {
      stopped = true;
    });
    await flush();
    expect(stopped).toBe(false);
    release();
    await stop;
    expect(stopped).toBe(true);
    expect(h.runner.started).toHaveLength(1);
  });
});
