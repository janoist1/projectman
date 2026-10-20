import { describe, expect, it, vi } from 'vitest';
import type { MergeCheckRun, MergeTestReport } from '@projectman/shared';
import type { Viewer } from '../core/projects';
import type { MergeCheckRunQuery } from '../db';
import type { ToolCaller } from './caller';
import { MergeTools } from './merges';
import { TEAM_TOOLS } from './tools';
import { createFakeTeamToolsHandler, sampleTaskDetail } from './testing';

describe('merge_task', () => {
  it('refuses source overrides and delegates the caller identity to the domain', async () => {
    const tool = TEAM_TOOLS.find((tool) => tool.name === 'merge_task')!;
    expect(tool.inputSchema.safeParse({ task_key: 'AR-21', merger: 'owner' }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ task_key: 'AR-21', commit: 'override' }).success).toBe(false);
    const handler = createFakeTeamToolsHandler();
    const task = sampleTaskDetail().task;
    task.merge = {
      id: 'merge-1',
      repo: 'web',
      base: 'main',
      toStageId: 'done',
      merger: 'fe-1',
      requestedAt: 'now',
      state: 'queued',
      step: 'queued',
      landed: 'nowhere',
    };
    const start = vi.spyOn(handler, 'mergeTask').mockResolvedValue({ task });
    const ctx = { projectKey: 'AR', member: 'fe-1', taskKey: 'AR-21', sessionId: 'session-1' };
    const result = await tool.run({ ctx, handler, args: { task_key: 'AR-21' } });
    expect(start).toHaveBeenCalledWith(ctx, {
      taskKey: 'AR-21',
      fixConflict: undefined,
      resolution: undefined,
    });
    expect(result).toContain('queued');
    expect(result).toContain('merge-1');
    // The server runs the merge: the member does not wait for it (PM-552).
    expect(result).toContain('Do not wait for it: end your turn now.');
    expect(result).toContain('wakes you with a team message');
    task.merge = { ...task.merge, state: 'blocked' };
    expect(await tool.run({ ctx, handler, args: { task_key: 'AR-21' } })).toBe('blocked mergeId=merge-1');
  });
  it('bounds resolution notes and returns the restart and fix instructions', async () => {
    const tool = TEAM_TOOLS.find((tool) => tool.name === 'merge_task')!;
    expect(tool.inputSchema.safeParse({ task_key: 'AR-21', resolution: '' }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ task_key: 'AR-21', resolution: 'x'.repeat(2001) }).success).toBe(
      false,
    );
    const handler = createFakeTeamToolsHandler();
    const task = sampleTaskDetail().task;
    task.merge = {
      id: 'merge-1',
      repo: 'web',
      base: 'main',
      toStageId: 'done',
      merger: 'fe-1',
      requestedAt: 'now',
      landed: 'nowhere',
      state: 'fixing',
      fix: { by: 'fe-1', base: 'abc123', branch: 'merge-fix/AR-21', startedAt: 'now' },
    };
    const start = vi.spyOn(handler, 'mergeTask').mockResolvedValue({ task });
    const ctx = { projectKey: 'AR', member: 'fe-1', taskKey: 'AR-21', sessionId: 'session-1' };
    const result = await tool.run({ ctx, handler, args: { task_key: 'AR-21', fix_conflict: true } });
    expect(start).toHaveBeenCalledWith(ctx, { taskKey: 'AR-21', fixConflict: true, resolution: undefined });
    expect(result).toContain('End this turn');
    expect(result).toContain('git merge abc123');
    expect(result).toContain('resolution');
  });
});

describe('prioritize_merge', () => {
  it('requires a reason and tells whether the merge moved', async () => {
    const tool = TEAM_TOOLS.find((tool) => tool.name === 'prioritize_merge')!;
    expect(tool.inputSchema.safeParse({ task_key: 'AR-21' }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ task_key: 'AR-21', reason: '  ' }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ task_key: 'AR-21', reason: 'x'.repeat(501) }).success).toBe(false);
    const handler = createFakeTeamToolsHandler();
    const task = sampleTaskDetail().task;
    const move = vi.spyOn(handler, 'prioritizeMerge').mockResolvedValue({ task, moved: true });
    const ctx = { projectKey: 'AR', member: 'fe-1', taskKey: 'AR-21', sessionId: 'session-1' };
    const args = { task_key: 'AR-21', reason: 'AR-22 and AR-23 test against its fix' };
    expect(await tool.run({ ctx, handler, args })).toContain('AR-21 merges next');
    expect(move).toHaveBeenCalledWith(ctx, { taskKey: 'AR-21', reason: args.reason });
    move.mockResolvedValue({ task, moved: false });
    expect(await tool.run({ ctx, handler, args })).toContain('first in the queue already');
  });
});

describe('list_merge_checks (PM-876)', () => {
  const ctx = { projectKey: 'AR', member: 'fe-1', taskKey: 'AR-21', sessionId: 'session-1' };
  const report: MergeTestReport = {
    scope: 'modules',
    workers: 4,
    commandMs: 90_000,
    steps: [
      { index: 0, kind: 'typecheck', workspace: 'packages/shared', result: 'cached', durationMs: null },
      { index: 1, kind: 'test', workspace: 'apps/server', result: 'passed', durationMs: 80_500 },
    ],
  };
  const run = (id: string, patch: Partial<MergeCheckRun> = {}): MergeCheckRun => ({
    id,
    projectKey: 'AR',
    repo: 'web',
    kind: 'merge',
    trainId: null,
    taskKeys: ['AR-21'],
    commit: 'a'.repeat(40),
    base: 'b'.repeat(40),
    status: 'passed',
    reason: null,
    maxWorkers: 4,
    requestedAt: '2026-10-20T10:00:00.000Z',
    startedAt: '2026-10-20T10:00:30.000Z',
    finishedAt: '2026-10-20T10:02:00.000Z',
    durationMs: 90_000,
    report,
    ...patch,
  });

  it('shows the worker count, the scope and every step, a cached step as not measured', async () => {
    const tool = TEAM_TOOLS.find((tool) => tool.name === 'list_merge_checks')!;
    const handler = createFakeTeamToolsHandler();
    const list = vi
      .spyOn(handler, 'listMergeChecks')
      .mockResolvedValue({ runs: [run('mc_1')], hasMore: false });
    const text = await tool.run({ ctx, handler, args: tool.inputSchema.parse({ task_key: 'AR-21' }) });
    expect(list).toHaveBeenCalledWith(ctx, {
      taskKey: 'AR-21',
      outcome: 'any',
      kind: 'checks',
      since: undefined,
      until: undefined,
      limit: 30,
    });
    expect(text).toContain('workers 4 (seen 4)');
    expect(text).toContain('scope modules');
    expect(text).toContain('queue wait 30 s');
    expect(text).toContain('typecheck packages/shared — cached (not measured)');
    expect(text).toContain('test apps/server — passed 80.5 s');
  });

  it('says a run without a report has unknown steps, not zero', async () => {
    const tool = TEAM_TOOLS.find((tool) => tool.name === 'list_merge_checks')!;
    const handler = createFakeTeamToolsHandler();
    vi.spyOn(handler, 'listMergeChecks').mockResolvedValue({
      runs: [run('mc_old', { report: null, durationMs: null, status: 'error' })],
      hasMore: true,
    });
    const text = await tool.run({ ctx, handler, args: tool.inputSchema.parse({}) });
    expect(text).toContain('steps: unknown');
    expect(text).toContain('duration unknown');
    expect(text).toContain('has_more: true');
  });

  it('refuses a period without a time zone and a limit above one hundred', () => {
    const tool = TEAM_TOOLS.find((tool) => tool.name === 'list_merge_checks')!;
    expect(tool.inputSchema.safeParse({ since: '2026-10-20' }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ until: '2026-10-20T10:00:00Z' }).success).toBe(true);
    expect(tool.inputSchema.safeParse({ limit: 101 }).success).toBe(false);
  });

  describe('handler', () => {
    const client: Viewer = { access: 'client', handle: 'acme' };
    const cards = new Map([
      ['AR-21', { key: 'AR-21', visibility: 'shared' }],
      ['AR-22', { key: 'AR-22', visibility: 'internal' }],
    ]);
    function tools(guest: { handle: string; viewer: Viewer } | null, all: MergeCheckRun[]) {
      const checkRuns = vi.fn((query: MergeCheckRunQuery) => {
        const rest = all.filter((item) => !query.kinds || query.kinds.includes(item.kind));
        const offset = query.offset ?? 0;
        return {
          runs: rest.slice(offset, offset + query.limit),
          hasMore: rest.length > offset + query.limit,
        };
      });
      const calls = {
        guard: (fn: () => Promise<unknown>) => fn(),
        callerWithRequest: async () => ({ guest }),
        visibleTaskKey: (_ctx: unknown, _guest: unknown, key: string) => key,
      } as unknown as ToolCaller;
      const handler = new MergeTools({
        calls,
        merges: { start: vi.fn(), prioritize: vi.fn(), checkRuns } as never,
        tasks: { find: (_project: string, key: string) => cards.get(key) } as never,
      });
      return { handler, checkRuns };
    }

    it('asks for the merge and train checks of the period, normalizing the times', async () => {
      const { handler, checkRuns } = tools(null, []);
      await handler.listMergeChecks(ctx, {
        outcome: 'not_passed',
        since: '2026-10-20T12:00:00+02:00',
        until: '2026-10-21T00:00:00Z',
      });
      expect(checkRuns).toHaveBeenCalledWith({
        projectKey: 'AR',
        outcome: 'not_passed',
        kinds: ['merge', 'train'],
        since: '2026-10-20T10:00:00.000Z',
        until: '2026-10-21T00:00:00.000Z',
        limit: 30,
        offset: 0,
      });
    });

    it('leaves the filter out for outcome and kind "any"', async () => {
      const { handler, checkRuns } = tools(null, []);
      await handler.listMergeChecks(ctx, { outcome: 'any', kind: 'any', limit: 5 });
      expect(checkRuns).toHaveBeenCalledWith({ projectKey: 'AR', limit: 5, offset: 0 });
    });

    it('hides from a client the runs with a card they cannot see, and keeps paging until the limit is full', async () => {
      const all = [
        run('mc_hidden_a', { taskKeys: ['AR-21', 'AR-22'] }),
        run('mc_hidden_b', { taskKeys: ['AR-22'] }),
        run('mc_seen_a'),
        run('mc_seen_b'),
        run('mc_seen_c'),
      ];
      const { handler } = tools({ handle: 'acme', viewer: client }, all);
      const page = await handler.listMergeChecks(ctx, { limit: 2 });
      expect(page.runs.map((item) => item.id)).toEqual(['mc_seen_a', 'mc_seen_b']);
      expect(page.hasMore).toBe(true);
      const everything = tools(null, all).handler;
      expect((await everything.listMergeChecks(ctx, { limit: 2 })).runs.map((item) => item.id)).toEqual([
        'mc_hidden_a',
        'mc_hidden_b',
      ]);
    });

    it('is not "has more" when only hidden runs remain', async () => {
      const { handler } = tools({ handle: 'acme', viewer: client }, [
        run('mc_seen'),
        run('mc_hidden', { taskKeys: ['AR-22'] }),
      ]);
      expect(await handler.listMergeChecks(ctx, { limit: 1 })).toEqual({
        runs: [run('mc_seen')],
        hasMore: false,
      });
    });
  });
});
