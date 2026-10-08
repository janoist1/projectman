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
    await h.cleanup();
  });
  const send = (taskKey?: string) =>
    h.domain.messaging.send('AR', 'owner', {
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
      // The new session takes the message in its first input (behind its brief, for a task):
      // nothing is typed after it.
      const text = taskKey
        ? '[team message from owner about AR-1]\nPlease check Acme.'
        : '[team message from owner]\nPlease check Acme.';
      const { initialMessage } = h.runner.lastStarted();
      expect(initialMessage).toContain(taskKey ? '[team messages about AR-1]' : '[team messages]');
      expect(initialMessage).toContain('Please check Acme.');
      expect(h.runner.messages).toEqual([]);
      expect(h.repos.messages.get(message.id)?.deliveredAt).toBeTruthy();
      await send(taskKey);
      await flush();
      expect(h.runner.started).toHaveLength(1);
      expect(h.runner.messages).toEqual([{ sessionId: sessions[0]!.id, text }]);
    },
  );

  it('resumes a task at capacity and avoids delivering to an unrelated live session', async () => {
    const { session } = await h.domain.sessions.ensureSession('AR', 'cr', { type: 'task', taskKey: 'AR-1' });
    h.runner.emit({ type: 'transcript_path', sessionId: session.id, path: '/tmp/acme-transcript.jsonl' });
    await h.domain.sessions.stop('AR', session.id);
    const message = await send('AR-1');
    await flush();
    // The resumed session takes the message as its first input: nothing is typed after it.
    expect(h.runner.lastStarted()).toMatchObject({
      sessionId: session.id,
      resume: true,
      initialMessage: expect.stringContaining('Please check Acme.'),
    });
    expect(h.repos.messages.get(message.id)?.deliveredAt).toBeTruthy();
    expect(h.runner.messages).toEqual([]);
    await h.domain.tasks.create('AR', { title: 'Acme second checkout' }, OWNER_ACTOR);
    const refused = await send('AR-2');
    await flush();
    expect(h.runner.started).toHaveLength(2);
    expect(h.repos.messages.pending('AR', 'cr').map((entry) => entry.id)).toContain(refused.id);
    expect(h.runner.messages).toEqual([]);
  });

  it.each(['capacity', 'concurrency', 'usage'] as const)(
    'leaves messages queued on %s refusal and logs at info level',
    async (reason) => {
      const info = vi.spyOn(h.log.logger, 'info');
      if (reason === 'capacity') {
        await h.domain.sessions.ensureSession('AR', 'cr', { type: 'task', taskKey: 'AR-1' });
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
        expect.objectContaining({
          member: 'cr',
          reason: {
            capacity: 'member_at_capacity',
            concurrency: 'ai_limit_reached',
            usage: 'plan_usage_paused',
          }[reason],
        }),
        'team message start deferred',
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
