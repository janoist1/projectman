import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OPERATOR_START_FETCH_FAILED_MINUTES,
  questionPayloadOf,
  START_BLOCKED_REASONS,
} from '@projectman/shared';
import type { OperatorWatch, ProjectConfig, ServerEvent, StartBlockedReason } from '@projectman/shared';
import { TeamToolError } from '../src/contracts';
import type { ToolContext } from '../src/contracts';
import { conflict } from '../src/kernel';
import { createDomainHarness, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { rejection } from './helpers/errors';
import { flush } from './helpers/fakes';

/** PM-455: the `start_blocked` signal for a start that waits on a repository choice or a stuck workspace. */
let h: DomainHarness;
let now: Date;
afterEach(async () => {
  await h?.cleanup();
});

const later = (minutes: number) => {
  now = new Date(now.getTime() + minutes * 60_000);
};
const sweep = async () => {
  await h.domain.operatorSignals.sweep('AR');
  await flush();
};
const signals = (state: 'open' | 'all' = 'open') =>
  h.repos.operatorSignals
    .list('AR')
    .filter((s) => s.kind === 'start_blocked' && (state === 'all' || !s.resolvedAt));
const twoRepos = (config: ProjectConfig): void => {
  config.project.repos.push({ name: 'api', path: 'api', github: 'acme/api', defaultBranch: 'main' });
};

let problem: { code: StartBlockedReason; branch: string } | null = null;

/** The question the project manager asks about a delivered signal. */
async function askAbout(signalId: string): Promise<string> {
  h.repos.operatorSignals.delivered([signalId], now.toISOString(), 'pm');
  const pm: ToolContext = {
    projectKey: 'AR',
    member: 'pm',
    sessionId: h.domain.sessions.list('AR', { member: 'pm' })[0]!.id,
    taskKey: null,
  };
  const { inboxItemId } = await h.domain.teamTools.askHuman(pm, {
    question: 'What now?',
    options: ['Yes', 'No'],
    signalId,
  });
  return inboxItemId;
}

/**
 * A development card with an AI assignee whose start waits for `reason`. The two workspace reasons come from the
 * session start, as in production; `repo_required` from a project with two repositories and a card without one.
 */
async function blocked(reason: StartBlockedReason, level?: OperatorWatch): Promise<string> {
  now = new Date('2026-10-28T10:00:00Z');
  h = await createDomainHarness({
    now: () => now,
    adjust: (config) => {
      const pm = config.team.members.find((m) => m.handle === 'pm')!;
      if (pm.kind === 'ai') pm.onLeave = false;
      if (level) config.team.operatorWatch = level;
      if (reason === 'repo_required') twoRepos(config);
      // A failed fetch is handed to the deployment duty.
      config.team.roleOverrides = {
        ...config.team.roleOverrides,
        developer: { duties: ['implementation', 'deployment'], instructions: '' },
      };
    },
  });
  problem = reason === 'repo_required' ? null : { code: reason, branch: 'task/AR-9' };
  const ensure = h.domain.sessions.ensureSession.bind(h.domain.sessions);
  // Only the assignee's start is stuck; the project manager's and other members' sessions start as usual.
  vi.spyOn(h.domain.sessions, 'ensureSession').mockImplementation(async (...args) => {
    if (problem && args[1] === 'dev-1')
      throw conflict(problem.code, 'the workspace cannot start', { branch: problem.branch });
    return ensure(...args);
  });
  const card = await h.domain.tasks.create(
    'AR',
    { title: 'Card', ...(reason === 'repo_required' ? {} : { repo: 'web' }) },
    OWNER_ACTOR,
  );
  h.domain.tasks.assign('AR', card.key, 'dev-1', OWNER_ACTOR);
  await h.domain.tasks.moveToStage('AR', card.key, 'development', OWNER_ACTOR);
  await vi.waitFor(() => expect(h.domain.tasks.get('AR', card.key).startWaiting?.reason).toBe(reason));
  return card.key;
}

/** The facts and the step the project manager reads on the signal, as its notice carries them. */
function noticeOf(signalId: string): { facts: unknown; step: unknown } {
  const text = h.domain.operatorSignals.noticeText('AR', [signalId]);
  return JSON.parse(text.split('\n').at(-1)!);
}

describe('start_blocked signal', () => {
  it.each(START_BLOCKED_REASONS)(
    'opens one signal for %s and none more on the next sweep',
    async (reason) => {
      const key = await blocked(reason);
      await sweep();
      await sweep();
      expect(signals()).toMatchObject([
        { caseKey: `start_blocked:${key}:${reason}`, taskKey: key, subject: reason },
      ]);
    },
  );

  it('closes the signal when the reason ends and the question asked about it with the rule signal_resolved', async () => {
    const key = await blocked('repo_required');
    await sweep();
    const [signal] = signals();
    h.repos.operatorSignals.delivered([signal!.id], now.toISOString(), 'pm');
    const pm: ToolContext = {
      projectKey: 'AR',
      member: 'pm',
      sessionId: h.domain.sessions.list('AR', { member: 'pm' })[0]!.id,
      taskKey: null,
    };
    const { inboxItemId } = await h.domain.teamTools.askHuman(pm, {
      question: 'Which repository?',
      options: ['web', 'api'],
      signalId: signal!.id,
    });
    const asked = h.domain.inbox.get('AR', inboxItemId);
    expect(questionPayloadOf(asked)?.signalId).toBe(signal!.id);
    // The card is the signal's card without naming it.
    expect(asked.taskKey).toBe(key);

    await h.domain.tasks.update('AR', key, { repo: 'api' }, OWNER_ACTOR);
    await sweep();
    expect(signals()).toEqual([]);
    expect(h.domain.inbox.get('AR', inboxItemId)).toMatchObject({
      state: 'cancelled',
      resolution: { rule: 'signal_resolved' },
    });
  });

  it('keeps the signal and its question open while a retry of the start is under attempt', async () => {
    await blocked('workspace_dirty');
    await sweep();
    const [signal] = signals();
    const asked = await askAbout(signal!.id);
    // A deferral kept in the legacy store is taken by the attempt: the card reads as not waiting until it settles.
    const waiting = vi.spyOn(h.domain.tasks, 'startWaitingOf').mockReturnValue(undefined);
    const attempting = vi.spyOn(h.domain.tasks, 'startAttempting').mockReturnValue(true);
    await sweep();
    expect(signals()).toMatchObject([{ id: signal!.id }]);
    expect(h.domain.inbox.get('AR', asked).state).not.toBe('cancelled');
    waiting.mockRestore();
    attempting.mockReturnValue(false);
    await sweep();
    expect(signals('all')).toMatchObject([{ id: signal!.id, resolvedAt: null }]);
  });

  it('closes the signal when the wait is gone and no attempt is under way', async () => {
    await blocked('workspace_dirty');
    await sweep();
    vi.spyOn(h.domain.tasks, 'startWaitingOf').mockReturnValue(undefined);
    vi.spyOn(h.domain.tasks, 'startAttempting').mockReturnValue(false);
    await sweep();
    expect(signals()).toEqual([]);
  });

  it('closes the old signal and opens a new one when the reason changes', async () => {
    const key = await blocked('workspace_dirty');
    await sweep();
    problem = { code: 'workspace_fetch_failed', branch: 'main' };
    await h.domain.admission.retryDeferred();
    await vi.waitFor(() =>
      expect(h.domain.tasks.get('AR', key).startWaiting?.reason).toBe('workspace_fetch_failed'),
    );
    await sweep();
    expect(signals('all').map((s) => [s.subject, !!s.resolvedAt])).toEqual([
      ['workspace_dirty', true],
      ['workspace_fetch_failed', false],
    ]);
  });

  describe('a failed fetch', () => {
    it('is not told before the system retried it for ten minutes', async () => {
      await blocked('workspace_fetch_failed');
      await sweep();
      const [signal] = signals();
      expect(signal!.deliveredAt).toBeNull();
      later(OPERATOR_START_FETCH_FAILED_MINUTES - 1);
      await sweep();
      expect(signals()[0]!.deliveredAt).toBeNull();
      later(1);
      await sweep();
      expect(signals()[0]!.deliveredAt).not.toBeNull();
    });

    it('that mends within ten minutes closes without ever reaching the project manager', async () => {
      await blocked('workspace_fetch_failed');
      const events: ServerEvent[] = [];
      h.domain.bus.subscribe((event) => events.push(event));
      await sweep();
      later(3);
      problem = null;
      await h.domain.admission.retryDeferred();
      await sweep();
      expect(signals('all')).toMatchObject([{ resolvedAt: expect.any(String), deliveredAt: null }]);
      expect(events.filter((event) => event.type === 'operator_signal')).toEqual([]);
    });
  });

  describe('the step and the facts at the unblock level', () => {
    it('starts the member on the card that holds the branch of a dirty workspace', async () => {
      const key = await blocked('workspace_dirty', 'unblock');
      // The other card's branch link is what the workspace stands on.
      const holder = await h.domain.tasks.create('AR', { title: 'Holder', repo: 'web' }, OWNER_ACTOR);
      h.repos.tasks.upsertLink(
        holder.id,
        { kind: 'branch', ref: 'task/AR-9', repo: 'acme/web' },
        now.toISOString(),
      );
      await sweep();
      const { facts, step } = noticeOf(signals()[0]!.id);
      expect(facts).toMatchObject({
        reason: 'workspace_dirty',
        member: 'dev-1',
        branch: 'task/AR-9',
        heldBy: holder.key,
      });
      expect(step).toEqual({ tool: 'start_member', task_key: holder.key, members: ['dev-1'] });
      expect(key).not.toBe(holder.key);
    });

    it('has no step for a dirty workspace nobody holds', async () => {
      await blocked('workspace_dirty', 'unblock');
      await sweep();
      const { facts, step } = noticeOf(signals()[0]!.id);
      expect(facts).toMatchObject({ heldBy: null });
      expect(step).toBeNull();
    });

    it('starts the deployment duty on the waiting card for a failed fetch', async () => {
      const key = await blocked('workspace_fetch_failed', 'unblock');
      await sweep();
      later(OPERATOR_START_FETCH_FAILED_MINUTES);
      await sweep();
      const { step } = noticeOf(signals()[0]!.id);
      expect(step).toMatchObject({ tool: 'start_member', task_key: key, members: expect.any(Array) });
      expect((step as { members: string[] }).members.length).toBeGreaterThan(0);
    });

    it('has no step for a repository choice, and tells the repositories', async () => {
      await blocked('repo_required', 'unblock');
      await sweep();
      const { facts, step } = noticeOf(signals()[0]!.id);
      expect(facts).toMatchObject({ reason: 'repo_required', repos: ['web', 'api'], branch: null });
      expect(step).toBeNull();
    });

    it('has no step at the report level', async () => {
      await blocked('workspace_fetch_failed', 'report');
      await sweep();
      later(OPERATOR_START_FETCH_FAILED_MINUTES);
      await sweep();
      expect(noticeOf(signals()[0]!.id).step).toBeNull();
    });
  });

  describe('ask_human with a signal_id', () => {
    it('is refused for anyone but the coordinator the signal was delivered to', async () => {
      await blocked('repo_required');
      await sweep();
      const [signal] = signals();
      h.repos.operatorSignals.delivered([signal!.id], now.toISOString(), 'pm');
      const other = await h.domain.tasks.create('AR', { title: 'Other', repo: 'web' }, OWNER_ACTOR);
      const session = await h.domain.sessions.ensureSession('AR', 'dev-2', {
        type: 'task',
        taskKey: other.key,
      });
      const dev: ToolContext = {
        projectKey: 'AR',
        member: 'dev-2',
        sessionId: session.session.id,
        taskKey: other.key,
      };
      const err = await rejection(
        h.domain.teamTools.askHuman(dev, { question: 'Which?', options: ['web'], signalId: signal!.id }),
        TeamToolError,
      );
      expect(err.message).toContain('signal_not_open');
    });
  });
});
