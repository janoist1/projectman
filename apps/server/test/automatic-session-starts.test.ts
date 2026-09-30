import type { ProjectConfig } from '@projectman/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../src/contracts';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush, planUsage } from './helpers/fakes';

const sender: ToolContext = {
  projectKey: 'AR',
  member: 'dev-1',
  sessionId: 'ses_fictional_sender',
  taskKey: 'AR-1',
};

const humanMessage = (h: DomainHarness, taskKey = 'AR-1') =>
  h.domain.messaging.send('AR', 'owner', {
    to: ['cr'],
    text: 'Please review the fictional checkout.',
    taskKey,
  });

/** The owner may also record code reviews, so the reviewer can be retired without orphaning the gate. */
const reviewersBesidesCr = (c: ProjectConfig) => {
  for (const label of c.pipeline.labels)
    if (label.group === 'code-review') label.setBy = { duties: ['code_review'], members: ['owner'] };
};

describe('automatic session admission and retries', () => {
  let h: DomainHarness;
  afterEach(async () => {
    await h.domain.stop();
    vi.restoreAllMocks();
    await h.cleanup();
  });

  it('defers AI messages on plan usage, retries periodically and delivers each message once', async () => {
    h = await createDomainHarness({ handOffRetryMs: 20 });
    await h.domain.tasks.create('AR', { title: 'Fictional checkout' }, OWNER_ACTOR);
    h.runnerModule.planUsage.value = planUsage(95);
    const first = await h.domain.teamTools.sendMessage(sender, { to: ['cr'], text: 'Review the checkout.' });
    const second = await h.domain.teamTools.sendMessage(sender, { to: ['cr'], text: 'Also check refunds.' });
    await flush();
    expect(h.runner.started).toHaveLength(0);
    expect(h.domain.tasks.get('AR', 'AR-1').startWaiting).toMatchObject({
      reason: 'plan_usage_paused',
      member: 'cr',
      provider: 'claude',
      threshold: 80,
      since: expect.any(String),
    });
    expect(h.repos.messages.pending('AR', 'cr').map((m) => m.id)).toEqual([
      first.messageId,
      second.messageId,
    ]);
    await h.domain.admission.retryDeferred();
    expect(h.runner.started).toHaveLength(0);

    h.runnerModule.planUsage.value = planUsage(30);
    await vi.waitFor(() => expect(h.runner.messages).toHaveLength(2));
    expect(h.runner.started).toHaveLength(1);
    expect(h.runner.messages.map((m) => m.text)).toEqual([
      '[team message from dev-1 about AR-1]\nReview the checkout.',
      '[team message from dev-1 about AR-1]\nAlso check refunds.',
    ]);
    expect(h.repos.messages.pending('AR', 'cr')).toEqual([]);
    expect(h.domain.tasks.get('AR', 'AR-1').startWaiting).toBeUndefined();
    await h.domain.admission.retryDeferred();
    expect(h.runner.started).toHaveLength(1);

    // A live recipient receives new messages even while new AI work is paused.
    h.runnerModule.planUsage.value = planUsage(99);
    await h.domain.teamTools.sendMessage(sender, { to: ['cr'], text: 'One more detail.' });
    await flush();
    expect(h.runner.started).toHaveLength(1);
    expect(h.runner.messages).toHaveLength(3);
  });

  it('defers human messages on the global AI limit and delivers after capacity frees', async () => {
    h = await createDomainHarness({ adjust: (c) => void (c.team.limits.maxConcurrentAi = 1) });
    await h.domain.tasks.create('AR', { title: 'Fictional checkout' }, OWNER_ACTOR);
    const busy = await h.domain.messageStarts.startConversation('AR', 'dev-1');
    const message = await humanMessage(h);
    await flush();
    await h.domain.admission.retryDeferred();
    expect(h.runner.started).toHaveLength(1);
    expect(h.repos.messages.get(message.id)?.deliveredAt).toBeNull();
    h.runner.setState(busy.id, 'idle');
    await h.domain.admission.retryDeferred();
    await flush();
    expect(h.runner.started).toHaveLength(2);
    expect(h.runner.messages).toEqual([
      {
        sessionId: h.runner.lastStarted().sessionId,
        text: '[team message from owner about AR-1]\nPlease review the fictional checkout.',
      },
    ]);
    expect(h.repos.messages.get(message.id)?.deliveredAt).toBeTruthy();
  });

  it('retries a message when the recipient is no longer at capacity', async () => {
    h = await createDomainHarness();
    await h.domain.tasks.create('AR', { title: 'Existing review' }, OWNER_ACTOR);
    h.domain.tasks.assign('AR', 'AR-1', 'cr', OWNER_ACTOR);
    await h.domain.tasks.create('AR', { title: 'Next review' }, OWNER_ACTOR);
    const message = await humanMessage(h, 'AR-2');
    await flush();
    expect(h.runner.started).toHaveLength(0);
    h.domain.tasks.assign('AR', 'AR-1', null, OWNER_ACTOR);
    await h.domain.admission.retryDeferred();
    await flush();
    expect(h.runner.started).toHaveLength(1);
    expect(h.repos.messages.get(message.id)?.deliveredAt).toBeTruthy();
  });

  it.each(['stage', 'done', 'cancelled', 'delivered', 'retired'] as const)(
    'drops deferred message starts when %s makes them obsolete',
    async (reason) => {
      h = await createDomainHarness({ adjust: reviewersBesidesCr });
      await h.domain.tasks.create('AR', { title: 'Fictional checkout' }, OWNER_ACTOR);
      h.runnerModule.planUsage.value = planUsage(95);
      const message = await humanMessage(h);
      await flush();
      if (reason === 'stage') {
        await h.domain.tasks.moveToStage('AR', 'AR-1', 'development', OWNER_ACTOR);
        await h.domain.tasks.moveToStage('AR', 'AR-1', 'backlog', OWNER_ACTOR);
      } else if (reason === 'done') {
        h.repos.tasks.update(h.domain.tasks.get('AR', 'AR-1').id, { status: 'done' });
      } else if (reason === 'cancelled') {
        await h.domain.tasks.cancel('AR', 'AR-1', { reason: 'Fictional scope changed.' }, OWNER_ACTOR);
      } else if (reason === 'delivered') {
        h.domain.messages.markRecipientDelivered(message.id, 'cr');
      } else {
        await h.domain.members.retire('AR', 'cr', {}, { actor: OWNER_ACTOR, author: OWNER });
      }
      await flush();
      h.runnerModule.planUsage.value = planUsage(30);
      await h.domain.admission.retryDeferred();
      expect(h.runner.started).toHaveLength(0);
      const retry = vi.spyOn(h.domain.messageStarts, 'wake');
      await h.domain.admission.retryDeferred();
      expect(retry).not.toHaveBeenCalled();
    },
  );

  it('does not retry a session startup failure', async () => {
    h = await createDomainHarness();
    await h.domain.tasks.create('AR', { title: 'Fictional checkout' }, OWNER_ACTOR);
    h.runner.failNextStart = new Error('Fictional runner failure');
    const message = await humanMessage(h);
    await flush();
    expect(h.repos.messages.get(message.id)?.deliveredAt).toBeNull();
    await h.domain.admission.retryDeferred();
    expect(h.runner.started).toHaveLength(0);
  });

  it('retries a resumed hand-over with its notice and waiting messages', async () => {
    h = await createDomainHarness();
    await h.domain.tasks.create('AR', { title: 'Fictional checkout' }, OWNER_ACTOR);
    const { session } = await h.domain.sessions.ensureSession('AR', 'cr', {
      type: 'task',
      taskKey: 'AR-1',
    });
    h.runner.emit({ type: 'transcript_path', sessionId: session.id, path: '/tmp/fictional-review.jsonl' });
    await h.domain.sessions.stop('AR', session.id);
    h.runnerModule.planUsage.value = planUsage(95);
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', OWNER_ACTOR);
    await humanMessage(h);
    await flush();
    expect(h.runner.started).toHaveLength(1);
    h.runnerModule.planUsage.value = planUsage(30);
    await h.domain.admission.retryDeferred();
    await flush();
    // No message caused this resume, so the session starts with the continue message; the
    // waiting message and the notice follow it.
    expect(h.runner.lastStarted()).toMatchObject({
      sessionId: session.id,
      resume: true,
      initialMessage: 'Continue AR-1: Fictional checkout',
    });
    expect(h.runner.messages.map((m) => m.text)).toEqual([
      '[team message from owner about AR-1]\nPlease review the fictional checkout.',
      expect.stringContaining('Task AR-1 is now in stage Code review'),
    ]);
    await h.domain.admission.retryDeferred();
    expect(h.runner.started).toHaveLength(2);
    expect(h.runner.messages).toHaveLength(2);
  });

  it('retries a hand-over when an owner becomes free, sending its brief', async () => {
    h = await createDomainHarness();
    await h.domain.tasks.create('AR', { title: 'Existing review' }, OWNER_ACTOR);
    h.domain.tasks.assign('AR', 'AR-1', 'cr', OWNER_ACTOR);
    await h.domain.tasks.create('AR', { title: 'Next review' }, OWNER_ACTOR);
    await h.domain.tasks.moveToStage('AR', 'AR-2', 'code_review', OWNER_ACTOR);
    await flush();
    expect(h.runner.started).toHaveLength(0);
    h.domain.tasks.assign('AR', 'AR-1', null, OWNER_ACTOR);
    await h.domain.admission.retryDeferred();
    expect(h.runner.lastStarted()).toMatchObject({ initialMessage: 'Brief for AR-2: Next review' });
  });

  it.each(['done', 'cancelled', 'retired'] as const)('drops a deferred hand-over when %s', async (reason) => {
    h = await createDomainHarness({ adjust: reviewersBesidesCr });
    await h.domain.tasks.create('AR', { title: 'Fictional checkout' }, OWNER_ACTOR);
    h.runnerModule.planUsage.value = planUsage(95);
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', OWNER_ACTOR);
    await flush();
    if (reason === 'done') {
      h.repos.tasks.update(h.domain.tasks.get('AR', 'AR-1').id, { status: 'done' });
    } else if (reason === 'cancelled') {
      await h.domain.tasks.cancel('AR', 'AR-1', { reason: 'Fictional scope changed.' }, OWNER_ACTOR);
    } else {
      await h.domain.members.retire('AR', 'cr', {}, { actor: OWNER_ACTOR, author: OWNER });
    }
    h.runnerModule.planUsage.value = planUsage(30);
    await h.domain.admission.retryDeferred();
    expect(h.runner.started).toHaveLength(0);
    const retry = vi.spyOn(h.domain.handOver, 'handOff');
    await h.domain.admission.retryDeferred();
    expect(retry).not.toHaveBeenCalled();
  });

  it('drains pending AI message starts on stop and prevents later automatic starts', async () => {
    h = await createDomainHarness({ handOffRetryMs: 10 });
    await h.domain.tasks.create('AR', { title: 'Fictional checkout' }, OWNER_ACTOR);
    let release!: () => void;
    const original = h.runner.start.bind(h.runner);
    const called = vi.spyOn(h.runner, 'start').mockImplementation(async (spec) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return original(spec);
    });
    await h.domain.teamTools.sendMessage(sender, { to: ['cr'], text: 'Review the checkout.' });
    await vi.waitFor(() => expect(called).toHaveBeenCalledOnce());
    h.runnerModule.planUsage.value = planUsage(95);
    await h.domain.teamTools.sendMessage(sender, { to: ['dev-2'], text: 'Check the checkout.' });
    let stopped = false;
    const stopping = h.domain.stop().then(() => {
      stopped = true;
    });
    await flush();
    expect(stopped).toBe(false);
    await h.domain.teamTools.sendMessage(sender, { to: ['dev-2'], text: 'Also check refunds.' });
    release();
    await stopping;
    expect(stopped).toBe(true);
    h.runnerModule.planUsage.value = planUsage(30);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.runner.started).toHaveLength(1);
    expect(h.repos.messages.pending('AR', 'dev-2')).toHaveLength(2);
  });
});
