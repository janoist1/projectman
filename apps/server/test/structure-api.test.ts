import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { routes } from '@projectman/shared';
import type { StructureView, Task } from '@projectman/shared';
import { addHumanAndLogin, createAppHarness, createProject, inject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
describe('structure API', () => {
  let h: AppHarness;
  afterEach(async () => {
    await h?.close();
  });
  it('reads a real test repository with a descriptor, sizes and changed card files', async () => {
    h = await createAppHarness();
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: h.workspace, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.com');
    mkdirSync(join(h.workspace, 'src'));
    writeFileSync(join(h.workspace, 'src/a.ts'), 'export const value = 1;\n');
    writeFileSync(
      join(h.workspace, 'projectman.structure.yaml'),
      'version: 1\nareas:\n  - id: app\n    name: App\nmodules:\n  - id: app\n    area: app\n    name: App\n    summary: Application\n    paths: [src/]\n',
    );
    git('add', '.');
    git('commit', '-qm', 'Add structure');
    const base = git('rev-parse', 'HEAD');
    git('checkout', '-qb', 'card');
    writeFileSync(join(h.workspace, 'src/a.ts'), 'export const value = 2;\n');
    git('add', '.');
    git('commit', '-qm', 'Change application');
    const head = git('rev-parse', 'HEAD');
    const owner = await setupOwner(h.app);
    await createProject(h, owner);
    const task = (
      await inject(h.app, 'POST', routes.tasks('AR'), owner, { title: 'Test card' })
    ).json<Task>();
    h.app.projectman.repos.tasks.upsertLink(task.id, { kind: 'branch', ref: 'card' }, task.createdAt);
    const response = await inject(h.app, 'GET', routes.projectStructure('AR'), owner);
    expect(response.statusCode).toBe(200);
    const repo = response.json<StructureView>().repos[0]!;
    expect(repo).toMatchObject({
      status: 'ok',
      commit: base,
      sizes: [{ id: 'app', files: 1 }],
      cards: [
        {
          taskKey: task.key,
          source: 'branch',
          commit: head,
          modules: [{ id: 'app', files: 1 }],
          unmapped: [],
        },
      ],
    });
  });
  it('allows every member, clients included', async () => {
    h = await createAppHarness();
    const owner = await setupOwner(h.app);
    await createProject(h, owner);
    const response = await inject(h.app, 'GET', routes.projectStructure('AR'), owner);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveProperty('repos');
    const client = await addHumanAndLogin(h.app, { handle: 'client', access: 'client' });
    expect((await inject(h.app, 'GET', routes.projectStructure('AR'), client)).statusCode).toBe(200);
  });
});
