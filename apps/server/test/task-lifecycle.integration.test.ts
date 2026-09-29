import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { routes } from '@projectman/shared';
import type { Task, TaskDetail } from '@projectman/shared';
import { afterEach, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { createTemplateRegistry } from '../src/domain';
import { createRunnerModule } from '../src/runner';
import { FAKE_CLAUDE, freePort, waitFor } from '../src/runner/test-helpers';
import { setupOwner } from './helpers/app-harness';
import {
  createFakeMcp,
  FakeContextBuilder,
  FakeGithub,
  FakeMemoryStore,
  FakeWorktreeManager,
} from './helpers/fakes';
import { testTemplate } from './helpers/test-template';

let app: FastifyInstance | undefined;
let home: string | undefined;
afterEach(async () => {
  await app?.close();
  if (home) rmSync(home, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it(
  'cancel stops a live fake-claude session through the HTTP API and keeps its worktree',
  { timeout: 30_000 },
  async () => {
    home = mkdtempSync(join(tmpdir(), 'pm-task-lifecycle-'));
    const workspace = join(home, 'workspace');
    mkdirSync(workspace);
    const configFile = join(home, '.claude.json');
    writeFileSync(configFile, JSON.stringify({ numStartups: 1, projects: {} }));
    vi.stubEnv('FAKE_CLAUDE_CONFIG_FILE', configFile);
    vi.stubEnv('FAKE_CLAUDE_TRANSCRIPT_DIR', join(home, 'transcripts'));
    const worktrees = new FakeWorktreeManager(join(home, 'worktrees'));
    const port = await freePort();
    app = await buildApp({
      home,
      logger: false,
      webDistDir: null,
      claudeBin: FAKE_CLAUDE,
      publicBaseUrl: `http://127.0.0.1:${port}`,
      modules: {
        createRunnerModule(options) {
          const module = createRunnerModule({ ...options, claudeConfigPath: configFile });
          return { ...module, planUsage: { get: async () => null } };
        },
        createMcpModule: (options) => createFakeMcp().create(options),
        github: new FakeGithub(),
        contextPackBuilder: new FakeContextBuilder(),
        memberMemory: new FakeMemoryStore(),
        worktrees,
        templates: createTemplateRegistry([testTemplate]),
      },
    });
    await app.listen({ host: '127.0.0.1', port });
    const cookie = await setupOwner(app);
    const headers = { cookie };
    const project = await app.inject({
      method: 'POST',
      url: routes.projects(),
      headers,
      payload: {
        key: 'AR',
        name: 'Acme webshop',
        workspacePath: workspace,
        templateId: 'test',
        repos: [{ name: 'web', path: '.', github: 'acme/web' }],
      },
    });
    expect(project.statusCode).toBe(201);
    const created = await app.inject({
      method: 'POST',
      url: routes.tasks('AR'),
      headers,
      payload: { title: 'Acme checkout', repo: 'web' },
    });
    expect(created.statusCode).toBe(201);
    const started = await app.inject({
      method: 'POST',
      url: routes.startTask('AR', 'AR-1'),
      headers,
      payload: { assignee: 'dev-1' },
    });
    expect(started.statusCode).toBe(200);
    const session = started.json<TaskDetail>().sessions[0]!;
    const { domain, runnerModule } = app.projectman;
    await waitFor(() => domain.sessions.get('AR', session.id).state === 'idle', {
      what: 'fake-claude ready',
    });
    expect(runnerModule.runner.isRunning(session.id)).toBe(true);
    const file = join(session.cwd, 'checkout.txt');
    writeFileSync(file, 'Acme checkout draft');
    const cancelled = await app.inject({
      method: 'POST',
      url: routes.cancelTask('AR', 'AR-1'),
      headers,
      payload: { reason: 'Scope changed' },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json<Task>()).toMatchObject({ status: 'cancelled', assignee: 'dev-1' });
    expect(runnerModule.runner.isRunning(session.id)).toBe(false);
    expect(runnerModule.runner.list()).toEqual([]);
    expect(domain.sessions.get('AR', session.id)).toMatchObject({
      state: 'exited',
      endedAt: expect.any(String),
    });
    expect(worktrees.removed).toEqual([]);
    expect(existsSync(session.cwd)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('Acme checkout draft');
  },
);
