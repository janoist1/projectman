import type { HandoffSummary, Session } from '@projectman/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';

/**
 * PM-340: a session is resumed only when its conversation exists. The transcript path is reported
 * before the CLI writes the file (it does after the first message), so the path is no proof; and a
 * resume whose CLI exits before it is ready is given up once: the next start is a new conversation.
 */

const task = { type: 'task', taskKey: 'AR-1' } as const;

describe('resuming a session only when its conversation exists', () => {
  let h: DomainHarness;
  beforeEach(async () => {
    h = await createDomainHarness();
    await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
  });
  afterEach(async () => {
    await h.domain.stop();
    await h.cleanup();
  });

  /** A session that reported its transcript path and stopped. */
  async function stopped(): Promise<Session> {
    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', task);
    h.runner.emit({ type: 'transcript_path', sessionId: session.id, path: `/tmp/${session.id}.jsonl` });
    await h.domain.sessions.stop('AR', session.id);
    return session;
  }

  /** The CLI of a resumed session exits with code 1 before it is ready. */
  function exitsBeforeReady(sessionId: string): void {
    h.runner.setState(sessionId, 'failed');
    h.runner.emit({ type: 'exit', sessionId, exitCode: 1, signal: null });
  }

  it('starts a new conversation with the full brief when the transcript does not exist or is empty', async () => {
    const session = await stopped();
    h.runnerModule.emptyTranscripts.add(`/tmp/${session.id}.jsonl`);

    const again = await h.domain.sessions.ensureSession('AR', 'dev-1', task);

    expect(again).toMatchObject({ resumed: false, started: true });
    const spec = h.runner.lastStarted();
    expect(spec).toMatchObject({ resume: false, initialMessage: 'Brief for AR-1: Login page' });
    const row = h.domain.sessions.get('AR', session.id);
    expect(row.transcriptPath).toBeNull();
    // The missing conversation's id is not reused for the new one.
    expect(spec.claudeSessionId).not.toBe(session.claudeSessionId);
    expect(row.claudeSessionId).toBe(spec.claudeSessionId);
  });

  it('still resumes a conversation whose transcript has content', async () => {
    const session = await stopped();

    const again = await h.domain.sessions.ensureSession('AR', 'dev-1', task);

    expect(again).toMatchObject({ resumed: true, started: true });
    expect(h.runner.lastStarted()).toMatchObject({
      resume: true,
      claudeSessionId: session.claudeSessionId,
      initialMessage: 'Continue AR-1: Login page',
    });
  });

  it('starts a new conversation after a resume exited before it was ready, and tries a resume only once', async () => {
    const session = await stopped();

    await h.domain.sessions.ensureSession('AR', 'dev-1', task);
    expect(h.runner.lastStarted()).toMatchObject({ resume: true });
    exitsBeforeReady(session.id);
    const failed = h.domain.sessions.get('AR', session.id);
    expect(failed).toMatchObject({ state: 'failed', transcriptPath: null });
    expect(failed.claudeSessionId).not.toBe(session.claudeSessionId);

    const next = await h.domain.sessions.ensureSession('AR', 'dev-1', task);

    expect(next).toMatchObject({ resumed: false, started: true });
    expect(h.runner.lastStarted()).toMatchObject({
      resume: false,
      claudeSessionId: failed.claudeSessionId,
      initialMessage: 'Brief for AR-1: Login page',
    });
  });

  it('keeps the conversation when a resume fails after it was ready', async () => {
    const session = await stopped();
    await h.domain.sessions.ensureSession('AR', 'dev-1', task);
    h.runner.setState(session.id, 'idle');
    exitsBeforeReady(session.id);

    expect(h.domain.sessions.get('AR', session.id)).toMatchObject({
      state: 'failed',
      claudeSessionId: session.claudeSessionId,
      transcriptPath: `/tmp/${session.id}.jsonl`,
    });
  });

  it('keeps the conversation when a resume that is still starting is stopped', async () => {
    const session = await stopped();
    await h.domain.sessions.ensureSession('AR', 'dev-1', task);
    await h.domain.sessions.stop('AR', session.id);

    expect(h.domain.sessions.get('AR', session.id)).toMatchObject({
      claudeSessionId: session.claudeSessionId,
      transcriptPath: `/tmp/${session.id}.jsonl`,
    });
  });

  describe('the new conversation tells what happened to the old one (PM-342)', () => {
    const restarts = () =>
      h.domain.timeline
        .list('AR', { taskKey: 'AR-1' })
        .filter((e) => e.type === 'session_conversation_restarted');
    const lastInput = () => h.contextBuilder.inputs[h.contextBuilder.inputs.length - 1]!;
    const oldSummary: HandoffSummary = { source: 'last_replies', text: 'Login form is done.', at: null };

    it('after a provider change: the summary of the old transcript and an event', async () => {
      const session = await stopped();
      const path = `/tmp/${session.id}.jsonl`;
      h.runnerModule.summaries.set(path, oldSummary);
      await h.domain.members.update(
        'AR',
        'dev-1',
        { provider: 'codex' },
        { actor: OWNER_ACTOR, author: OWNER },
      );

      const again = await h.domain.sessions.ensureSession('AR', 'dev-1', task);

      expect(again).toMatchObject({ resumed: false, started: true });
      expect(h.runnerModule.summaryReads).toEqual([{ path, opts: { provider: 'claude' } }]);
      expect(lastInput().previousConversation).toEqual({
        reason: 'provider_changed',
        fromProvider: 'claude',
        summary: oldSummary,
        lastNote: null,
      });
      expect(restarts().map((e) => ({ actor: e.actor, data: e.data }))).toEqual([
        {
          actor: { kind: 'system', handle: null },
          data: {
            member: 'dev-1',
            reason: 'provider_changed',
            fromProvider: 'claude',
            toProvider: 'codex',
            summary: true,
          },
        },
      ]);
    });

    it('after a provider change without a readable transcript: no summary, still told', async () => {
      await stopped();
      await h.domain.members.update(
        'AR',
        'dev-1',
        { provider: 'codex' },
        { actor: OWNER_ACTOR, author: OWNER },
      );

      await h.domain.sessions.ensureSession('AR', 'dev-1', task);

      expect(lastInput().previousConversation).toMatchObject({ reason: 'provider_changed', summary: null });
      expect(restarts()[0]?.data).toMatchObject({ reason: 'provider_changed', summary: false });
    });

    it('for a lost conversation: the lost part and an event, and no transcript read', async () => {
      const session = await stopped();
      h.runnerModule.emptyTranscripts.add(`/tmp/${session.id}.jsonl`);

      await h.domain.sessions.ensureSession('AR', 'dev-1', task);

      expect(lastInput().previousConversation).toEqual({
        reason: 'lost',
        fromProvider: null,
        summary: null,
        lastNote: null,
      });
      expect(h.runnerModule.summaryReads).toEqual([]);
      expect(restarts().map((e) => e.data)).toEqual([{ member: 'dev-1', reason: 'lost', summary: false }]);
    });

    it('not for a new session, nor for a resumed conversation', async () => {
      await stopped();
      expect(lastInput().previousConversation).toBeUndefined();

      await h.domain.sessions.ensureSession('AR', 'dev-1', task);

      expect(h.runner.lastStarted()).toMatchObject({ resume: true });
      expect(lastInput().previousConversation).toBeUndefined();
      expect(restarts()).toEqual([]);
    });
  });

  it('does not give up a new conversation that exits before it is ready', async () => {
    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', task);
    exitsBeforeReady(session.id);

    expect(h.domain.sessions.get('AR', session.id).claudeSessionId).toBe(session.claudeSessionId);
  });
});
