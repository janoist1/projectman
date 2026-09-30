import type { AgentProvider, ProjectConfig, Session } from '@projectman/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_FIRST_INPUT_CHARS } from '../src/domain';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';

/**
 * A task session that starts again resumes its conversation. What it gets as its first input, so
 * that it does not sit at its prompt: the message that caused the resume, else a short message
 * that it was restarted (the context pack's continue message; the fake builder's here). The
 * runner gives the adapters the text as `initialMessage`: Codex takes it on its command line,
 * Claude Code has it typed once it reports SessionStart.
 */

const CODEX_ID = '019a0b1c-2d3e-7f40-8a5b-6c7d8e9f0a1b';
const task = { type: 'task', taskKey: 'AR-1' } as const;
const general = { type: 'general' } as const;

/** dev-1 runs on Claude Code (the default), dev-2 on Codex. */
function codexDev2(config: ProjectConfig): void {
  const dev2 = config.team.members.find((m) => m.handle === 'dev-2');
  if (dev2?.kind === 'ai') dev2.provider = 'codex';
}

const PROVIDERS: Array<[AgentProvider, string]> = [
  ['claude', 'dev-1'],
  ['codex', 'dev-2'],
];

describe('the first input of a resumed session', () => {
  let h: DomainHarness;
  beforeEach(async () => {
    h = await createDomainHarness({ adjust: codexDev2 });
    await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
  });
  afterEach(async () => {
    await h.domain.stop();
    await h.cleanup();
  });

  /** A session that ran and stopped, leaving a conversation to resume. */
  async function stopped(member: string, workItem: typeof task | typeof general = task): Promise<Session> {
    const { session } = await h.domain.sessions.ensureSession('AR', member, workItem);
    if (session.provider === 'codex') {
      h.runner.emit({ type: 'provider_session_id', sessionId: session.id, providerSessionId: CODEX_ID });
      h.runner.emit({
        type: 'transcript_path',
        sessionId: session.id,
        path: `/home/anna/.codex/sessions/2026/01/01/rollout-2026-01-01T00-00-00-${CODEX_ID}.jsonl`,
      });
    } else {
      h.runner.emit({ type: 'transcript_path', sessionId: session.id, path: `/tmp/${session.id}.jsonl` });
    }
    await h.domain.sessions.stop('AR', session.id);
    return session;
  }

  it.each(PROVIDERS)(
    'gives a resumed %s task session the continue message when no message caused the resume',
    async (provider, member) => {
      const session = await stopped(member);
      const resumed = await h.domain.sessions.ensureSession('AR', member, task);
      expect(resumed).toMatchObject({ resumed: true, started: true, messageSent: false });
      expect(h.runner.lastStarted()).toMatchObject({
        sessionId: session.id,
        provider,
        resume: true,
        initialMessage: 'Continue AR-1: Login page',
      });
      // Nothing is typed in behind it.
      expect(h.runner.messages).toEqual([]);
    },
  );

  it.each(PROVIDERS)(
    'gives a %s session that resumes for a manual start or a stage hand-over the same message',
    async (_provider, member) => {
      await stopped(member);
      await h.domain.taskStarts.start('AR', 'AR-1', {
        assignee: member,
        actor: OWNER_ACTOR,
        author: OWNER,
      });
      expect(h.runner.lastStarted()).toMatchObject({
        resume: true,
        initialMessage: 'Continue AR-1: Login page',
      });
    },
  );

  it('starts a new conversation with its brief, and a general chat resumes without a first input', async () => {
    const fresh = await h.domain.sessions.ensureSession('AR', 'dev-1', task);
    expect(fresh).toMatchObject({ resumed: false, messageSent: false });
    expect(h.runner.lastStarted()).toMatchObject({
      resume: false,
      initialMessage: 'Brief for AR-1: Login page',
    });

    await stopped('cr', general);
    await h.domain.sessions.ensureSession('AR', 'cr', general);
    expect(h.runner.lastStarted()).toMatchObject({ resume: true, initialMessage: null });
  });

  it.each(PROVIDERS)(
    'gives a %s session a human message as its first input, not the continue message, and types nothing after it',
    async (provider, member) => {
      const session = await stopped(member);
      const message = await h.domain.messaging.sendToSession('AR', session.id, 'Please rename it.', 'owner');
      await flush();
      expect(h.runner.lastStarted()).toMatchObject({
        sessionId: session.id,
        provider,
        resume: true,
        initialMessage: 'Please rename it.',
      });
      expect(h.runner.messages).toEqual([]);
      // Recorded, and delivered: it is not waiting for the session's next start.
      expect(h.repos.messages.get(message.id)).toMatchObject({ body: 'Please rename it.', to: [member] });
      expect(h.repos.messages.get(message.id)?.deliveredAt).toBeTruthy();
      expect(h.repos.messages.pending('AR', member)).toEqual([]);
    },
  );

  it('types a human message after the brief when its session starts a new conversation', async () => {
    // A session row without a conversation (it never reported a transcript): the brief goes first.
    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', task);
    await h.domain.sessions.stop('AR', session.id);
    await h.domain.messaging.sendToSession('AR', session.id, 'Please rename it.', 'owner');
    expect(h.runner.lastStarted()).toMatchObject({
      resume: false,
      initialMessage: 'Brief for AR-1: Login page',
    });
    await flush();
    expect(h.runner.messages).toEqual([{ sessionId: session.id, text: 'Please rename it.' }]);
  });

  it('types a message that is too long for a command line after the continue message', async () => {
    const session = await stopped('dev-2');
    const long = `Please read this log:\n${'x'.repeat(MAX_FIRST_INPUT_CHARS)}`;
    await h.domain.messaging.sendToSession('AR', session.id, long, 'owner');
    await flush();
    expect(h.runner.lastStarted()).toMatchObject({
      sessionId: session.id,
      resume: true,
      initialMessage: 'Continue AR-1: Login page',
    });
    expect(h.runner.messages).toEqual([{ sessionId: session.id, text: long }]);
  });

  it('types a human message into a running session as before', async () => {
    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', task);
    await h.domain.messaging.sendToSession('AR', session.id, 'Please rename it.', 'owner');
    await flush();
    expect(h.runner.started).toHaveLength(1);
    expect(h.runner.messages).toEqual([{ sessionId: session.id, text: 'Please rename it.' }]);
  });

  it.each(PROVIDERS)(
    'wakes a stopped %s recipient with its first waiting message, and types the rest in order',
    async (provider, member) => {
      const session = await stopped(member);
      const first = await h.domain.messaging.send('AR', 'owner', {
        to: [member],
        text: 'First: check the title.',
        taskKey: 'AR-1',
      });
      await h.domain.messaging.send('AR', 'owner', {
        to: [member],
        text: 'Second: and the label.',
        taskKey: 'AR-1',
      });
      await flush();
      expect(h.runner.started).toHaveLength(2);
      expect(h.runner.lastStarted()).toMatchObject({
        sessionId: session.id,
        provider,
        resume: true,
        initialMessage: '[team message from owner about AR-1]\nFirst: check the title.',
      });
      expect(h.runner.messages.map((m) => m.text)).toEqual([
        '[team message from owner about AR-1]\nSecond: and the label.',
      ]);
      expect(h.repos.messages.get(first.id)?.deliveredAt).toBeTruthy();
      expect(h.repos.messages.pending('AR', member)).toEqual([]);
    },
  );

  it('keeps waiting messages in order when a start that is not for them resumes the session', async () => {
    const session = await stopped('dev-1');
    // A start that no message caused resumes the session: the continue message goes first, then
    // the messages that wait for the session, in the order they were written.
    h.repos.messages.insert({
      id: 'msg_1',
      projectKey: 'AR',
      from: 'owner',
      to: ['dev-1'],
      taskKey: 'AR-1',
      body: 'Waiting one.',
      createdAt: '2026-09-30T10:00:00.000Z',
      deliveredAt: null,
    });
    h.repos.messages.insert({
      id: 'msg_2',
      projectKey: 'AR',
      from: 'owner',
      to: ['dev-1'],
      taskKey: 'AR-1',
      body: 'Waiting two.',
      createdAt: '2026-09-30T10:00:01.000Z',
      deliveredAt: null,
    });
    await h.domain.sessions.ensureSession('AR', 'dev-1', task);
    await flush();
    expect(h.runner.lastStarted()).toMatchObject({
      sessionId: session.id,
      initialMessage: 'Continue AR-1: Login page',
    });
    expect(h.runner.messages.map((m) => m.text)).toEqual([
      '[team message from owner about AR-1]\nWaiting one.',
      '[team message from owner about AR-1]\nWaiting two.',
    ]);
  });

  it('leaves the message waiting when the start that would carry it fails', async () => {
    await stopped('dev-1');
    h.runner.failNextStart = new Error('Fictional runner failure');
    const message = await h.domain.messaging.send('AR', 'owner', {
      to: ['dev-1'],
      text: 'Please review.',
      taskKey: 'AR-1',
    });
    await flush();
    expect(h.repos.messages.get(message.id)?.deliveredAt).toBeNull();
    expect(h.repos.messages.pending('AR', 'dev-1').map((m) => m.id)).toEqual([message.id]);
    // The next start (by anyone) delivers it, typed as usual or as the first input.
    await h.domain.messageStarts.wake('AR', 'dev-1', task);
    expect(h.runner.lastStarted()).toMatchObject({
      resume: true,
      initialMessage: '[team message from owner about AR-1]\nPlease review.',
    });
    expect(h.repos.messages.get(message.id)?.deliveredAt).toBeTruthy();
  });
});
