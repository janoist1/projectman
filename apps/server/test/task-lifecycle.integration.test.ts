import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { routes } from '@projectman/shared';
import type { Task, TaskDetail } from '@projectman/shared';
import { afterEach, expect, it } from 'vitest';
import { waitFor } from '../src/runner/test-helpers';
import { createAppHarness, createProject, setupOwner } from './helpers/app-harness';
import type { CliAppHarness } from './helpers/app-harness';

let h: CliAppHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

it(
  'cancel stops a live fake-claude session through the HTTP API and keeps its worktree',
  { timeout: 30_000 },
  async () => {
    h = await createAppHarness({ runner: 'fake-cli' });
    const { app, worktrees } = h;
    const cookie = await setupOwner(app);
    const headers = { cookie };
    await createProject(h, cookie);
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
