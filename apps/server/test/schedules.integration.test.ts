import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { routes, ScheduleRun } from '@projectman/shared';
import { afterEach, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { createTemplateRegistry } from '../src/domain';
import { createRunnerModule } from '../src/runner';
import { FAKE_CLAUDE, freePort, waitFor } from '../src/runner/test-helpers';
import { setupOwner } from './helpers/app-harness';
import { createFakeMcp, FakeGithub, FakeMemoryStore, FakeWorktreeManager } from './helpers/fakes';
import { testTemplate } from './helpers/test-template';

let app: FastifyInstance | undefined;
let home: string | undefined;
afterEach(async () => {
  await app?.close();
  if (home) rmSync(home, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
it(
  'runs a clock-matched schedule in a fake CLI and supports run-now and exit completion',
  { timeout: 30_000 },
  async () => {
    home = mkdtempSync(join(tmpdir(), 'pm-schedule-cli-'));
    const workspace = join(home, 'workspace');
    mkdirSync(workspace);
    const configFile = join(home, '.claude.json');
    writeFileSync(configFile, JSON.stringify({ numStartups: 1, projects: {} }));
    vi.stubEnv('FAKE_CLAUDE_CONFIG_FILE', configFile);
    vi.stubEnv('FAKE_CLAUDE_TRANSCRIPT_DIR', join(home, 'transcripts'));
    const worktrees = new FakeWorktreeManager(join(home, 'worktrees'));
    const port = await freePort();
    let at = new Date('2026-09-30T08:29:30Z');
    app = await buildApp({
      home,
      now: () => at,
      logger: false,
      webDistDir: null,
      claudeBin: FAKE_CLAUDE,
      publicBaseUrl: `http://127.0.0.1:${port}`,
      scheduleTimer: { set: () => null, clear: () => {} },
      modules: {
        createRunnerModule(options) {
          const module = createRunnerModule({ ...options, claudeConfigPath: configFile });
          return { ...module, planUsage: { get: async () => null } };
        },
        createMcpModule: (options) => createFakeMcp().create(options),
        github: new FakeGithub(),
        memberMemory: new FakeMemoryStore(),
        worktrees,
        templates: createTemplateRegistry([testTemplate]),
      },
    });
    await app.listen({ host: '127.0.0.1', port });
    const cookie = await setupOwner(app);
    const headers = { cookie };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: routes.projects(),
          headers,
          payload: { key: 'AR', name: 'Fictional workshop', workspacePath: workspace, templateId: 'test' },
        })
      ).statusCode,
    ).toBe(201);
    const prompt = 'Inspect the fictional workspace and report maintenance opportunities.';
    await app.projectman.domain.projects.update(
      'AR',
      {
        actor: { kind: 'human', handle: 'owner' },
        author: { name: 'Owner', email: 'owner@example.com' },
      },
      (config) => {
        config.project.timezone = 'Europe/Budapest';
        return 'Set fictional project timezone';
      },
    );
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: routes.member('AR', 'dev-1'),
          headers,
          payload: { schedule: { cron: '30 10 * * *', prompt } },
        })
      ).statusCode,
    ).toBe(200);
    const { domain } = app.projectman;
    await domain.schedules.check();
    expect(worktrees.calls).toHaveLength(0);
    expect(domain.sessions.list('AR')).toHaveLength(0);
    at = new Date('2026-09-30T08:30:00Z');
    await domain.schedules.check();
    const run = (await domain.schedules.view('AR')).runs[0]!;
    const sessionId = run.sessionId!;
    await waitFor(() => domain.sessions.get('AR', sessionId).transcriptPath, {
      what: 'fake scheduled transcript',
    });
    await vi.waitFor(
      async () => {
        const detail = await domain.sessions.detail('AR', sessionId);
        expect(detail.chat.some((item) => item.kind === 'user_text' && item.text === prompt)).toBe(true);
      },
      { timeout: 10_000 },
    );
    expect(domain.sessions.get('AR', sessionId)).toMatchObject({
      cwd: workspace,
      branch: null,
      workItem: { type: 'schedule', runId: run.id },
    });
    expect(worktrees.calls).toHaveLength(0);
    await domain.schedules.check();
    expect((await domain.schedules.view('AR')).runs).toHaveLength(1);
    expect(
      (await app.inject({ method: 'POST', url: routes.runSchedule('AR', 'dev-1'), headers })).statusCode,
    ).toBe(409);
    expect(
      (await app.inject({ method: 'POST', url: routes.stopSession('AR', sessionId), headers })).statusCode,
    ).toBe(200);
    expect(domain.ctx.repos.schedules.get(run.id)?.status).toBe('done');
    const nowRun = await app.inject({ method: 'POST', url: routes.runSchedule('AR', 'dev-1'), headers });
    expect(nowRun.statusCode).toBe(201);
    expect(ScheduleRun.parse(nowRun.json()).sessionId).not.toBe(sessionId);
  },
);
