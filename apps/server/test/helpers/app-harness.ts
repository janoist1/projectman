import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../src/app';
import { createTemplateRegistry } from '../../src/domain';
import {
  createFakeMcp,
  createFakeRunnerModule,
  FakeContextBuilder,
  FakeGithub,
  FakeMemoryStore,
  FakeWorktreeManager,
} from './fakes';
import { testTemplate } from './test-template';

export const OWNER_LOGIN = { name: 'Owner', email: 'owner@example.com', password: 'correct horse battery' };

/** The whole server (buildApp) over a temp PROJECTMAN_HOME, with fakes for every external module. */
export async function createAppHarness(opts: { webDistDir?: string; now?: () => Date } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'pm-app-'));
  const workspace = join(home, 'workspace');
  mkdirSync(workspace);
  const runnerModule = createFakeRunnerModule();
  const mcp = createFakeMcp();
  const github = new FakeGithub();
  const contextBuilder = new FakeContextBuilder();
  const memory = new FakeMemoryStore();
  const worktrees = new FakeWorktreeManager(join(home, 'worktrees'));

  const app = await buildApp({
    home,
    now: opts.now,
    logger: false,
    webDistDir: opts.webDistDir ?? null,
    planUsageTtlMs: 0,
    doneCleanupDelayMs: 0,
    modules: {
      createRunnerModule: (o) => runnerModule.create(o),
      createMcpModule: (o) => mcp.create(o),
      github,
      contextPackBuilder: contextBuilder,
      memberMemory: memory,
      worktrees,
      templates: createTemplateRegistry([testTemplate]),
    },
  });
  await app.ready();

  return {
    app,
    home,
    workspace,
    runnerModule,
    runner: runnerModule.runner,
    mcp,
    github,
    contextBuilder,
    memory,
    worktrees,
    async close() {
      await app.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

export type AppHarness = Awaited<ReturnType<typeof createAppHarness>>;

/** "name=value" of the response's first Set-Cookie header. */
export function cookieOf(res: LightMyRequestResponse): string {
  const header = res.headers['set-cookie'];
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) throw new Error('no set-cookie header');
  return raw.split(';')[0]!;
}

/** First-run setup from localhost; returns the login cookie. */
export async function setupOwner(app: FastifyInstance): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/setup', payload: OWNER_LOGIN });
  if (res.statusCode !== 201) throw new Error(`setup failed: ${res.statusCode} ${res.body}`);
  return cookieOf(res);
}

/** Creates project AR from the test template (workspace + one repo). */
export async function createProject(h: AppHarness, cookie: string): Promise<void> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/projects',
    headers: { cookie },
    payload: {
      key: 'AR',
      name: 'acme',
      workspacePath: h.workspace,
      templateId: 'test',
      repos: [{ name: 'web', path: '.', github: 'acme/web' }],
    },
  });
  if (res.statusCode !== 201) throw new Error(`project creation failed: ${res.statusCode} ${res.body}`);
}
