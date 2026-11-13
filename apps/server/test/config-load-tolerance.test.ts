import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { Me } from '@projectman/shared';
import type { ConfigView, ProjectConfig } from '@projectman/shared';
import { parseYamlFile } from '../src/config/layout';
import { createAppHarness, createProject, inject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { testConfig } from './helpers/test-template';

/**
 * Real installations hold configurations written before a rule existed (decisions 16 and 19). The
 * project must load and stay in its owner's list; changes may preserve but never worsen its errors.
 */
describe('projects whose stored configuration predates a rule', () => {
  let h: AppHarness;
  let cookie: string;
  beforeEach(async () => {
    h = await createAppHarness();
    cookie = await setupOwner(h.app);
    await createProject(h, cookie);
  });
  afterEach(async () => h.close());

  /** A hand edit of a stored file in the customization repository. */
  function handEdit(file: 'project.yaml' | 'team.yaml' | 'pipeline.yaml', change: (document: any) => void) {
    const path = join(h.home, 'customization/projects/AR', file);
    const document = parseYamlFile(file, readFileSync(path, 'utf8'));
    change(document);
    writeFileSync(path, stringify(document));
  }
  /** What the server does at startup: read every project's files again. */
  const restart = () => h.app.projectman.domain.projects.syncFromStore();
  const config = async () =>
    (await inject(h.app, 'GET', '/api/projects/AR/config', cookie)).json<ConfigView>().config;
  const errorsOf = (response: { json: () => any }) =>
    (response.json().error.details.issues as Array<{ code: string; severity?: string }>)
      .filter((issue) => issue.severity !== 'warning')
      .map((issue) => issue.code);

  it('registers a project only the customization repository holds from a current configuration', async () => {
    const stored = testConfig({
      key: 'LG',
      owner: { handle: 'owner', displayName: 'Owner', email: 'owner@example.test' },
    });
    await h.app.projectman.configStore.save('LG', stored, {
      author: { name: 'Owner', email: 'owner@example.test' },
      message: 'Create current configuration',
    });
    await restart();

    const { domain } = h.app.projectman;
    expect(domain.projects.has('LG')).toBe(true);
    expect(await domain.projects.config('LG')).toEqual(stored);
    expect(await domain.projectsFor('owner@example.test')).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'LG', access: 'owner' })]),
    );
  });

  it('allows edits with existing duplicate repositories and columns but refuses only introduced errors', async () => {
    handEdit('project.yaml', (document) => document.project.repos.push({ name: 'web', path: 'web-copy' }));
    handEdit('pipeline.yaml', (document) => document.columns.push({ id: 'todo', name: 'To do again' }));
    await restart();

    // The project is still listed and opens.
    const me = Me.parse((await inject(h.app, 'GET', '/api/me', cookie)).json());
    expect(me.projects.map((project) => project.key)).toEqual(['AR']);
    const loaded = await config();
    expect(loaded.project.repos.map((repo) => repo.name)).toEqual(['web', 'web']);
    expect(loaded.pipeline.columns.filter((column) => column.id === 'todo')).toHaveLength(2);

    // Unrelated changes persist despite the existing errors.
    const view = (await inject(h.app, 'GET', '/api/projects/AR/config', cookie)).json<ConfigView>();
    const patched = await inject(h.app, 'PATCH', '/api/projects/AR/config', cookie, {
      baseVersion: view.version,
      limits: { maxConcurrentAi: 2 },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect((await h.app.projectman.configStore.load('AR')).config.team.limits.maxConcurrentAi).toBe(2);
    const added = await inject(h.app, 'POST', '/api/projects/AR/members', cookie, { role: 'qa' });
    expect(added.statusCode, added.body).toBe(201);

    const current = (await inject(h.app, 'GET', '/api/projects/AR/config', cookie)).json<ConfigView>();
    const pipeline = structuredClone(current.config.pipeline);
    pipeline.columns.push({ id: 'todo', name: 'Third copy' });
    const refused = await inject(h.app, 'PATCH', '/api/projects/AR/config', cookie, {
      baseVersion: current.version,
      pipeline,
    });
    expect([refused.statusCode, refused.json().error.code]).toEqual([400, 'config_invalid']);
    expect(errorsOf(refused)).toEqual(['duplicate_column']);
    expect(refused.json().error.details.issues).toEqual([
      { code: 'duplicate_column', path: 'pipeline.columns[5].id', detail: 'todo' },
    ]);
    expect((await h.app.projectman.configStore.load('AR')).version).toBe(current.version);

    // The repaired configuration is accepted, and the project carries on.
    const repaired: ProjectConfig = structuredClone(current.config);
    repaired.project.repos.pop();
    repaired.pipeline.columns.pop();
    const saved = await inject(h.app, 'PUT', '/api/projects/AR/config', cookie, {
      config: repaired,
      baseVersion: current.version,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const hired = await inject(h.app, 'POST', '/api/projects/AR/members', cookie, { role: 'qa' });
    expect(hired.statusCode, hired.body).toBe(201);
  });
});
