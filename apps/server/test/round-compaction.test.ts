import type { ProjectConfig } from '@projectman/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiActor } from '../src/domain';
import { COMPACT_MIN_CONTEXT_TOKENS } from '../src/domain/sessions';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';

/*
 * PM-213: when a card leaves the stage a member worked it in, the member's conversation is compacted
 * into a short summary, and the next round goes on from that. The domain decides when (the runner
 * types the command, runner/session.test.ts): at the member's next idle moment, never over a message
 * on its way in, and for a session that was not running, when it resumes and its conversation is big.
 */

const INSTRUCTION = 'Keep the card, the decisions and the open bugs.';
const task = { type: 'task', taskKey: 'AR-1' } as const;

describe('end-of-round compaction', () => {
  let h: DomainHarness;
  afterEach(async () => {
    await h.cleanup();
  });

  /**
   * dev-1 works AR-1; its session has run and has a conversation (a transcript) of `context` tokens
   * (big by default; null: never measured).
   */
  async function setup(adjust?: (config: ProjectConfig) => void, context: number | null = 150_000) {
    h = await createDomainHarness({ adjust });
    h.contextBuilder.compactInstruction = INSTRUCTION;
    await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
    await h.domain.taskStarts.start('AR', 'AR-1', { assignee: 'dev-1', actor: OWNER_ACTOR, author: OWNER });
    await vi.waitFor(() => expect(h.runner.started).toHaveLength(1));
    const session = h.repos.sessions.findByWorkItem('AR', 'dev-1', task)!;
    h.runner.emit({ type: 'transcript_path', sessionId: session.id, path: `/tmp/${session.id}.jsonl` });
    if (context !== null) measured(session.id, context);
    return session;
  }
  const handOver = () => h.domain.tasks.moveToStage('AR', 'AR-1', 'code_review', aiActor('dev-1'));
  const owed = (id: string) => h.repos.sessions.compaction(id).pending;
  const compactionsOf = (id: string) => h.runner.compactions.filter((c) => c.sessionId === id);
  const measured = (id: string, contextTokens: number) =>
    h.runner.emit({ type: 'usage', sessionId: id, entries: [], contextTokens });

  it('types the compaction into the idle session once the card is handed over', async () => {
    const dev = await setup();
    h.runner.setState(dev.id, 'idle');
    await handOver();
    await vi.waitFor(() =>
      expect(h.runner.compactions).toEqual([{ sessionId: dev.id, instruction: INSTRUCTION }]),
    );
    expect(owed(dev.id)).toBe(true);
    // The runner reports it started, worked and ended: nothing is owed any more, and the context is
    // measured again from the next step.
    measured(dev.id, 150_000);
    h.runner.emit({
      type: 'compaction',
      sessionId: dev.id,
      phase: 'started',
      trigger: 'manual',
      requested: true,
    });
    h.runner.setState(dev.id, 'working', 'Compacting the conversation');
    expect(owed(dev.id)).toBe(true);
    h.runner.emit({
      type: 'compaction',
      sessionId: dev.id,
      phase: 'finished',
      trigger: 'manual',
      requested: true,
    });
    h.runner.setState(dev.id, 'idle');
    expect(owed(dev.id)).toBe(false);
    expect(h.repos.sessions.compaction(dev.id).contextTokens).toBeNull();
    expect(compactionsOf(dev.id)).toHaveLength(1);
  });

  it('does not type the compaction while the team is paused, and does after the resume (PM-219)', async () => {
    const dev = await setup();
    const by = { userId: null, source: 'system' } as const;
    h.runner.setState(dev.id, 'idle');
    h.runner.pauseOutcomes.set(dev.id, { point: 'idle', tool: null });
    await h.domain.pauses.pause({ scope: 'project', projectKey: 'AR' }, by);
    await handOver();
    await vi.waitFor(() => expect(owed(dev.id)).toBe(true));
    // An idle moment of the session during the pause does not type it either.
    h.runner.setState(dev.id, 'working');
    h.runner.setState(dev.id, 'idle');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.runner.compactions).toEqual([]);

    await h.domain.pauses.resume({ scope: 'project', projectKey: 'AR' }, by);
    await vi.waitFor(() =>
      expect(h.runner.compactions).toEqual([{ sessionId: dev.id, instruction: INSTRUCTION }]),
    );
    expect(owed(dev.id)).toBe(true);
  });

  it('does not compact a small conversation, nor one that was never measured, and owes nothing for it', async () => {
    const dev = await setup(undefined, COMPACT_MIN_CONTEXT_TOKENS);
    h.runner.setState(dev.id, 'idle');
    await handOver();
    await vi.waitFor(() => expect(owed(dev.id)).toBe(false));
    expect(h.runner.compactions).toEqual([]);
    await h.cleanup();

    const unmeasured = await setup(undefined, null);
    h.runner.setState(unmeasured.id, 'idle');
    await handOver();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(h.runner.compactions).toEqual([]);
    expect(owed(unmeasured.id)).toBe(false);
  });

  it('waits for the end of the turn when the card is handed over from inside it', async () => {
    const dev = await setup();
    h.runner.setState(dev.id, 'working');
    await handOver();
    await vi.waitFor(() => expect(owed(dev.id)).toBe(true));
    // The reviewer's session is started by the hand-over, and works the card: it is not compacted.
    await vi.waitFor(() => expect(h.runner.started).toHaveLength(2));
    expect(h.runner.compactions).toEqual([]);

    h.runner.setState(dev.id, 'idle');
    await vi.waitFor(() => expect(compactionsOf(dev.id)).toHaveLength(1));
    expect(h.runner.compactions).toHaveLength(1);
  });

  it('puts the message that waits for the session first, and compacts at its next idle moment', async () => {
    const dev = await setup();
    h.runner.setState(dev.id, 'working');
    await handOver();
    await vi.waitFor(() => expect(owed(dev.id)).toBe(true));
    // A message is on its way into the session when it goes idle: it is typed first.
    h.runner.pendingInput.add(dev.id);
    h.runner.setState(dev.id, 'idle');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.runner.compactions).toEqual([]);
    expect(owed(dev.id)).toBe(true);

    // The message got through and was worked on; the session idles again: now it is compacted.
    h.runner.pendingInput.delete(dev.id);
    h.runner.setState(dev.id, 'working');
    h.runner.setState(dev.id, 'idle');
    await vi.waitFor(() => expect(compactionsOf(dev.id)).toHaveLength(1));
  });

  it('does not compact the conversation of a member who works the card in the next stage too', async () => {
    const dev = await setup((config) => {
      const merge = config.pipeline.stages.find((s) => s.id === 'merge')!;
      merge.owners = ['dev-1'];
      delete merge.gate;
    });
    h.runner.setState(dev.id, 'idle');
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'merge', OWNER_ACTOR);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(h.runner.compactions).toEqual([]);
    expect(owed(dev.id)).toBe(false);
  });

  it('drops the compaction of a card that is back in the stage when the session idles', async () => {
    const dev = await setup();
    h.runner.setState(dev.id, 'working');
    await handOver();
    await vi.waitFor(() => expect(owed(dev.id)).toBe(true));
    // Sent back to development before the turn ended: the round goes on in the same conversation.
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'development', OWNER_ACTOR);
    h.runner.setState(dev.id, 'idle');
    await vi.waitFor(() => expect(owed(dev.id)).toBe(false));
    expect(h.runner.compactions).toEqual([]);
  });

  it('gives it up for good when the runner could not do it', async () => {
    const dev = await setup();
    h.runner.setState(dev.id, 'idle');
    await handOver();
    await vi.waitFor(() => expect(compactionsOf(dev.id)).toHaveLength(1));
    h.runner.emit({
      type: 'compaction',
      sessionId: dev.id,
      phase: 'abandoned',
      trigger: null,
      requested: true,
    });
    expect(owed(dev.id)).toBe(false);
    h.runner.setState(dev.id, 'working');
    h.runner.setState(dev.id, 'idle');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.runner.compactions).toHaveLength(1);
  });

  it('is off without a compaction text', async () => {
    const dev = await setup();
    h.contextBuilder.compactInstruction = undefined;
    h.runner.setState(dev.id, 'idle');
    await handOver();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(h.runner.compactions).toEqual([]);
    expect(owed(dev.id)).toBe(false);
  });

  it('does not compact a conversation of a Codex member', async () => {
    h = await createDomainHarness({
      adjust: (config) => {
        const dev1 = config.team.members.find((m) => m.handle === 'dev-1');
        if (dev1?.kind === 'ai') dev1.provider = 'codex';
      },
    });
    h.contextBuilder.compactInstruction = INSTRUCTION;
    await h.domain.tasks.create('AR', { title: 'Login page' }, OWNER_ACTOR);
    await h.domain.taskStarts.start('AR', 'AR-1', { assignee: 'dev-1', actor: OWNER_ACTOR, author: OWNER });
    await vi.waitFor(() => expect(h.runner.started).toHaveLength(1));
    const dev = h.repos.sessions.findByWorkItem('AR', 'dev-1', task)!;
    h.runner.setState(dev.id, 'idle');
    await handOver();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(h.runner.compactions).toEqual([]);
    expect(owed(dev.id)).toBe(false);
  });

  describe('a session that did not run at the end of its round', () => {
    /** dev-1's session ended its round while stopped, with a conversation of `context` tokens. */
    async function stoppedAfterHandOver(context: number) {
      const dev = await setup();
      measured(dev.id, context);
      await h.domain.sessions.stop('AR', dev.id);
      await handOver();
      await vi.waitFor(() => expect(owed(dev.id)).toBe(true));
      // The reviewer's session starts in the background: let it finish before the test starts its own.
      await vi.waitFor(() => expect(h.runner.started.length).toBeGreaterThan(1));
      return dev;
    }
    const resume = (messages: string[] = []) =>
      h.domain.sessions.ensureSession('AR', 'dev-1', task, { messages });

    it('is compacted first when it resumes with a big conversation, and the message follows', async () => {
      const dev = await stoppedAfterHandOver(COMPACT_MIN_CONTEXT_TOKENS + 1);
      await h.domain.tasks.moveToStage('AR', 'AR-1', 'development', OWNER_ACTOR);
      const resumed = await resume(['Please fix the findings.']);
      expect(resumed).toMatchObject({ resumed: true, started: true });
      // The same conversation, compacted before the message that woke the session.
      expect(h.runner.lastStarted()).toMatchObject({
        sessionId: dev.id,
        claudeSessionId: dev.claudeSessionId,
        resume: true,
        compactFirst: INSTRUCTION,
        initialMessage: expect.stringContaining('Please fix the findings.'),
      });
      // It keeps owing it until the runner reports the compaction over.
      expect(owed(dev.id)).toBe(true);
      h.runner.emit({
        type: 'compaction',
        sessionId: dev.id,
        phase: 'finished',
        trigger: 'manual',
        requested: true,
      });
      expect(owed(dev.id)).toBe(false);
    });

    it('is compacted before the continue message too', async () => {
      await stoppedAfterHandOver(COMPACT_MIN_CONTEXT_TOKENS + 50_000);
      await resume();
      expect(h.runner.lastStarted()).toMatchObject({
        compactFirst: INSTRUCTION,
        initialMessage: 'Continue AR-1: Login page',
      });
    });

    it('is not compacted when its conversation is small', async () => {
      const dev = await stoppedAfterHandOver(COMPACT_MIN_CONTEXT_TOKENS);
      await resume(['Please fix the findings.']);
      expect(h.runner.lastStarted()).not.toHaveProperty('compactFirst');
      expect(h.runner.lastStarted()).toMatchObject({ resume: true });
      expect(owed(dev.id)).toBe(false);
    });

    it('is not compacted when its conversation was never measured', async () => {
      const dev = await setup(undefined, null);
      await h.domain.sessions.stop('AR', dev.id);
      await handOver();
      await vi.waitFor(() => expect(owed(dev.id)).toBe(true));
      await resume();
      expect(h.runner.lastStarted()).not.toHaveProperty('compactFirst');
    });

    it('owes nothing to a new conversation', async () => {
      const dev = await stoppedAfterHandOver(COMPACT_MIN_CONTEXT_TOKENS + 1);
      // Its transcript is gone: the conversation cannot be resumed, a new one starts.
      h.repos.sessions.update(dev.id, { transcriptPath: null });
      await resume();
      expect(h.runner.lastStarted()).toMatchObject({ resume: false });
      expect(h.runner.lastStarted()).not.toHaveProperty('compactFirst');
      expect(owed(dev.id)).toBe(false);
    });
  });

  it('tells a returning reviewer the commit it reviewed last, for its wake-up message', async () => {
    const dev = await setup();
    const worktree = h.worktrees.existing.get('AR/AR-1/web')!.path;
    const head = (commit: string) => ({
      commit,
      branch: 'task/AR-1',
      dirty: false,
      changes: 0,
      path: worktree,
      committedAt: null,
    });
    const reviewer = () => h.repos.sessions.findByWorkItem('AR', 'cr', task)!;
    h.worktrees.heads.set(worktree, head('c1'));
    await handOver();
    await vi.waitFor(() => expect(h.runner.started.some((s) => s.member === 'cr')).toBe(true));
    // The first round: the reviewer works at c1 and has nothing earlier to name.
    expect(h.contextBuilder.inputs.at(-1)).not.toHaveProperty('lastReviewedCommit');
    expect(h.repos.sessions.reviewedCommit(reviewer().id)).toBe('c1');
    h.runner.emit({ type: 'transcript_path', sessionId: reviewer().id, path: `/tmp/${reviewer().id}.jsonl` });
    await h.domain.sessions.stop('AR', reviewer().id);

    // Back to development, fixed, handed over again at c2: the reviewer resumes.
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'development', OWNER_ACTOR);
    h.worktrees.heads.set(worktree, head('c2'));
    h.runner.setState(dev.id, 'idle');
    await handOver();
    await vi.waitFor(() =>
      expect(h.contextBuilder.inputs.at(-1)).toMatchObject({ lastReviewedCommit: 'c1' }),
    );
    expect(h.contextBuilder.inputs.at(-1)?.task?.reviewPin).toMatchObject({ commit: 'c2' });
    expect(h.runner.lastStarted()).toMatchObject({ member: 'cr', resume: true });
    // From now on c2 is the one it reviewed last.
    expect(h.repos.sessions.reviewedCommit(reviewer().id)).toBe('c2');
  });

  it('keeps the context the conversation last measured', async () => {
    const dev = await setup();
    measured(dev.id, 80_000);
    measured(dev.id, 90_000);
    expect(h.repos.sessions.compaction(dev.id).contextTokens).toBe(90_000);
    // A usage event without a step leaves it alone.
    h.runner.emit({ type: 'usage', sessionId: dev.id, entries: [] });
    expect(h.repos.sessions.compaction(dev.id).contextTokens).toBe(90_000);
  });
});
