import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@projectman/shared';
import { createDomainHarness, OWNER, OWNER_ACTOR, type DomainHarness } from './helpers/domain-harness';
import { TEAM_TOOLS } from '../src/mcp';
import { createFakeTeamToolsHandler, devContext } from '../src/mcp/testing';
import { createLocalEngine } from '../src/engine-host';
import type { EngineDirectory } from '../src/contracts';
import { capturingLogger, FakeWorktreeManager } from './helpers/fakes';

let h: DomainHarness;
const at = (n = 0) => new Date(Date.UTC(2026, 9, 16, 10, 0, n)).toISOString();
const context = (member = 'pm') => ({
  sessionId: `ses_${member}`,
  projectKey: 'AR',
  member,
  taskKey: null,
});
const sentinel = 'SECRET_TOKEN_TRANSCRIPT_COMMAND';
function session(id: string, member: string, taskKey: string | null, seconds = 0): Session {
  return {
    id,
    projectKey: 'AR',
    member,
    workItem: taskKey ? { type: 'task', taskKey } : { type: 'general' },
    claudeSessionId: '00000000-0000-0000-0000-000000000000',
    cwd: sentinel,
    branch: sentinel,
    transcriptPath: sentinel,
    state: 'idle',
    activity: sentinel,
    startedAt: at(),
    lastActivityAt: at(seconds),
    endedAt: null,
  };
}
async function setup(extra: NonNullable<Parameters<typeof createDomainHarness>[0]> = {}) {
  h = await createDomainHarness({
    ...extra,
    now: () => new Date(at(30)),
    adjust(config) {
      const pm = config.team.members.find((m) => m.handle === 'pm')!;
      if (pm.kind === 'ai') pm.onLeave = false;
      config.team.members.push({
        kind: 'human',
        handle: 'guest',
        displayName: 'Guest',
        access: 'admin',
        roles: [],
      });
    },
  });
  await h.domain.tasks.create('AR', { title: 'Diagnose' }, OWNER_ACTOR);
  h.repos.sessions.insert(session('ses_pm', 'pm', null));
  vi.spyOn(h.domain.machine, 'view').mockResolvedValue({
    sampledAt: at(30),
    summary: { cpuPercent: 25, memoryUsedBytes: 100, memoryTotalBytes: 1000 },
  } as Awaited<ReturnType<typeof h.domain.machine.view>>);
}
afterEach(async () => {
  vi.restoreAllMocks();
  await h?.cleanup();
});
const read = (limit?: number) =>
  h.domain.teamTools.getOperatorDiagnostics(context(), { taskKey: 'AR-1', limit });

describe('filtered Operator diagnostics', () => {
  it('preserves percentage units and the actual sample time, and survives a measurement error', async () => {
    await setup({ freeDiskBytes: async () => 4096 });
    expect((await read()).machine).toBeNull();
    h.repos.sessions.insert(session('ses_card', 'dev-1', 'AR-1'));
    vi.mocked(h.domain.machine.view).mockResolvedValue({
      sampledAt: at(10),
      summary: { cpuPercent: 25, memoryUsedBytes: null, memoryTotalBytes: 1000 },
    } as Awaited<ReturnType<typeof h.domain.machine.view>>);
    expect((await read()).machine).toEqual({
      engineId: 'local',
      cpuLoad: 25,
      memoryUsedBytes: null,
      memoryTotalBytes: 1000,
      freeDiskBytes: 4096,
      measuredAt: at(10),
    });
    vi.mocked(h.domain.machine.view).mockRejectedValue(new Error(sentinel));
    const result = await read();
    expect(result.machine).toBeNull();
    expect(result.task.taskKey).toBe('AR-1');
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  it.each([false, true])('omits unproven remote engine metrics, cloud mode %s', async (cloud) => {
    const remoteId = 'eng_abcdefghijkl';
    let online = true;
    const host = {
      ...createLocalEngine(
        { worktrees: new FakeWorktreeManager('/unused'), workspacePath: () => null, claudeTmpRoots: [] },
        capturingLogger().logger,
      ),
      id: remoteId,
      freeDiskBytes: vi.fn(async () => 8192),
    };
    const engines: EngineDirectory = {
      ids: () => [remoteId],
      get: (id) => (online && id === remoteId ? host : null),
      engineFor: () => remoteId,
      projectEngine: () => remoteId,
      hostEngine: () => remoteId,
      onChange: () => () => {},
    };
    await setup({
      engines,
      ...(cloud
        ? {
            machineEngine: {
              available: () => online,
              identity: () => ({ pid: 10, uid: 1, instanceTag: 'engine' }),
            },
          }
        : {}),
    });
    h.repos.sessions.insert({ ...session('ses_remote', 'dev-1', 'AR-1'), engineId: remoteId });
    const result = await read();
    expect(result.machine).toBeNull();
    expect(result.task.taskKey).toBe('AR-1');
    expect(result.sessions[0]?.id).toBe('ses_remote');
    online = false;
    vi.mocked(h.domain.machine.view).mockClear();
    expect((await read()).machine).toBeNull();
    expect(h.domain.machine.view).not.toHaveBeenCalled();
  });
  it('includes merge checks without raw commands or failure output, and deduplicates reused checks', async () => {
    await setup();
    h.repos.fullTestRuns.queue({
      id: 'review_check',
      projectKey: 'AR',
      taskKey: 'AR-1',
      repo: 'web',
      branch: 'card',
      commit: 'abc',
      createdAt: at(1),
    });
    h.repos.fullTestRuns.finish('review_check', { status: 'passed', finishedAt: at(2) });
    const base = {
      projectKey: 'AR',
      taskKey: 'AR-1',
      repo: 'web',
      base: 'main',
      branch: 'card',
      fromStageId: 'code_review',
      toStageId: 'done',
      merger: 'cr',
      requestedAt: at(1),
      createdAt: at(1),
      updatedAt: at(5),
      landed: 'nowhere' as const,
    };
    h.repos.taskMerges.save({
      ...base,
      id: 'merge_old',
      state: 'merged',
      finishedAt: at(3),
      check: { command: sentinel, runId: 'review_check', status: 'passed', reused: true },
    });
    h.repos.taskMerges.save({
      ...base,
      id: 'merge_new',
      state: 'failed',
      check: { command: sentinel, runId: 'merge_check', status: 'failed' },
      failure: {
        reason: 'check_failed',
        at: at(5),
        base: 'abc',
        command: sentinel,
        outputTail: sentinel,
        files: ['example.test.ts'],
      },
    });
    const result = await read();
    expect(result.checks).toEqual([
      { runId: 'merge_check', outcome: 'failed', failedFiles: ['example.test.ts'], at: at(5) },
      { runId: 'review_check', outcome: 'passed', failedFiles: [], at: at(2) },
    ]);
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });
  it('projects only structured activity and receipts, with independent newest-first limits and fresh task state', async () => {
    await setup();
    await h.domain.tasks.create('AR', { title: 'Unrelated' }, OWNER_ACTOR);
    h.repos.sessions.insert(session('ses_unrelated', 'dev-1', 'AR-2', 20));
    h.repos.messages.insert({
      id: 'msg_unrelated',
      projectKey: 'AR',
      from: 'dev-1',
      to: ['dev-2'],
      taskKey: 'AR-2',
      body: sentinel,
      createdAt: at(20),
      deliveredAt: null,
    });
    for (let i = 1; i <= 3; i++) {
      const s = session(`ses_${i}`, ['dev-1', 'dev-2', 'cr'][i - 1]!, 'AR-1', i);
      h.repos.sessions.insert(s);
      h.repos.sessions.update(s.id, {
        workMetadata: {
          lastWorkAt: at(i),
          lastTool: { name: 'get_task', at: at(i) },
          lastError: { code: 'tool_failed', at: at(i) },
        },
      });
      h.repos.messages.insert({
        id: `msg_${i}`,
        projectKey: 'AR',
        from: 'dev-1',
        to: ['dev-2'],
        taskKey: 'AR-1',
        body: sentinel,
        createdAt: at(i),
        deliveredAt: null,
        receipts:
          i === 3
            ? [
                {
                  handle: 'dev-2',
                  kind: 'ai',
                  deliveredAt: at(4),
                  readAt: null,
                  route: { type: 'task', taskKey: 'AR-1' },
                },
              ]
            : [],
      });
      h.repos.fullTestRuns.queue({
        id: `run_${i}`,
        projectKey: 'AR',
        taskKey: 'AR-1',
        repo: sentinel,
        branch: sentinel,
        commit: sentinel,
        createdAt: at(i),
      });
      h.repos.fullTestRuns.finish(`run_${i}`, {
        status: 'failed',
        failedFiles: ['test/example.test.ts'],
        finishedAt: at(i),
      });
    }
    const result = await read(2);
    expect(result.asOf).toBe(at(30));
    expect(result.sessions.map((s) => s.id)).toEqual(['ses_3', 'ses_2']);
    expect(result.sessions[0]?.lastTool).toEqual({ name: 'get_task', at: at(3) });
    expect(result.sessions[0]?.lastError).toEqual({ code: 'tool_failed', at: at(3) });
    expect(result.deliveries.map((m) => m.messageId)).toEqual(['msg_3', 'msg_2']);
    expect(result.deliveries[0]?.recipients[0]?.deliveredAt).toBe(at(4));
    expect(result.deliveries[1]?.recipients[0]?.deliveredAt).toBeNull();
    expect(result.checks.map((c) => c.runId)).toEqual(['run_3', 'run_2']);
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(JSON.stringify(result)).not.toContain('unrelated');
    h.repos.tasks.update(h.domain.tasks.get('AR', 'AR-1').id, { labels: ['changed'] });
    expect((await read()).task.labels).toEqual(['changed']);
  });

  it('keeps unavailable activity and engine readings null without reading transcripts', async () => {
    await setup();
    h.repos.sessions.insert({ ...session('ses_remote', 'dev-1', 'AR-1'), engineId: 'eng_abcdefghijkl' });
    const result = await read();
    expect(result.machine).toBeNull();
    expect(result.sessions[0]).toMatchObject({ lastTool: null, lastError: null });
    expect(result.checks).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  it('refuses guest, customer, forged session and non-coordinator actors in the service itself', async () => {
    await setup();
    h.repos.sessions.insert({
      ...session('ses_guest_pm', 'pm', null),
      workItem: { type: 'general', with: 'guest' },
    });
    for (const sessionId of ['ses_guest_pm', 'ses_missing'])
      await expect(
        h.domain.projectState.diagnostics({ ...context(), sessionId }, 'AR-1'),
      ).rejects.toMatchObject({ status: 403 });
    await expect(h.domain.projectState.diagnostics(context('dev-1'), 'AR-1')).rejects.toMatchObject({
      status: 403,
      code: 'operator_only',
    });
    await expect(h.domain.projectState.diagnostics(context(), 'OTHER-1')).rejects.toMatchObject({
      status: 404,
    });
    await h.domain.projects.create(
      { key: 'BR', name: 'Other project', workspacePath: h.workspace, templateId: 'test' },
      OWNER,
    );
    await expect(
      h.domain.projectState.diagnostics({ ...context(), projectKey: 'BR' }, 'BR-1'),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('rechecks the session after an awaited machine read', async () => {
    await setup();
    h.repos.sessions.insert(session('ses_card', 'dev-1', 'AR-1'));
    vi.mocked(h.domain.machine.view).mockImplementation(async () => {
      const get = h.repos.sessions.get.bind(h.repos.sessions);
      vi.spyOn(h.repos.sessions, 'get').mockImplementation((id) => (id === 'ses_pm' ? null : get(id)));
      throw new Error(sentinel);
    });
    await expect(read()).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('validates the narrow tool input and defaults limit to ten', async () => {
    const tool = TEAM_TOOLS.find((t) => t.name === 'get_operator_diagnostics')!;
    expect(tool.inputSchema.parse({ task_key: 'AR-1' })).toEqual({ task_key: 'AR-1', limit: 10 });
    for (const limit of [0, 21, 1.5, '2'])
      expect(tool.inputSchema.safeParse({ task_key: 'AR-1', limit }).success).toBe(false);
    for (const field of ['path', 'sql', 'command', 'env', 'transcript'])
      expect(tool.inputSchema.safeParse({ task_key: 'AR-1', [field]: sentinel }).success).toBe(false);
    const handler = createFakeTeamToolsHandler();
    await tool.run({
      ctx: devContext,
      args: tool.inputSchema.parse({ task_key: 'AR-1', limit: 2 }),
      handler,
    });
    expect(handler.calls[0]).toMatchObject({
      method: 'getOperatorDiagnostics',
      args: { taskKey: 'AR-1', limit: 2 },
    });
    await setup();
    await expect(read(21)).rejects.toMatchObject({ code: 'invalid' });
  });
});
