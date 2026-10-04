import type { Session } from '@projectman/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDomainHarness, OWNER_ACTOR } from './helpers/domain-harness';
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

  it('does not give up a new conversation that exits before it is ready', async () => {
    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', task);
    exitsBeforeReady(session.id);

    expect(h.domain.sessions.get('AR', session.id).claudeSessionId).toBe(session.claudeSessionId);
  });
});
