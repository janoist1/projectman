import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { labelDefinition, labelRefusal, Me } from '@projectman/shared';
import type { ConfigView, ProjectConfig } from '@projectman/shared';
import { parseYamlFile } from '../src/config/layout';
import { addHumanAndLogin, createAppHarness, createProject, inject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';

/**
 * Real installations hold configurations written before a rule existed (decisions 16 and 19). The
 * project must load and stay in its owner's list; changes to it are refused until it is repaired.
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

  it('keeps a project with repository names and column ids used twice, and refuses changes until they are gone', async () => {
    handEdit('project.yaml', (document) => document.project.repos.push({ name: 'web', path: 'web-copy' }));
    handEdit('pipeline.yaml', (document) => document.columns.push({ id: 'todo', name: 'To do again' }));
    await restart();

    // The project is still listed and opens.
    const me = Me.parse((await inject(h.app, 'GET', '/api/me', cookie)).json());
    expect(me.projects.map((project) => project.key)).toEqual(['AR']);
    const loaded = await config();
    expect(loaded.project.repos.map((repo) => repo.name)).toEqual(['web', 'web']);
    expect(loaded.pipeline.columns.filter((column) => column.id === 'todo')).toHaveLength(2);

    // Every change is refused, whichever way it is made.
    const view = (await inject(h.app, 'GET', '/api/projects/AR/config', cookie)).json<ConfigView>();
    const patched = await inject(h.app, 'PATCH', '/api/projects/AR/config', cookie, {
      baseVersion: view.version,
      limits: { maxConcurrentAi: 2 },
    });
    expect([patched.statusCode, patched.json().error.code]).toEqual([400, 'config_invalid']);
    expect(errorsOf(patched)).toEqual(['duplicate_repo', 'duplicate_column']);
    const added = await inject(h.app, 'POST', '/api/projects/AR/members', cookie, { role: 'qa' });
    expect([added.statusCode, added.json().error.code]).toEqual([422, 'invalid_config']);

    // The repaired configuration is accepted, and the project carries on.
    const repaired: ProjectConfig = structuredClone(loaded);
    repaired.project.repos.pop();
    repaired.pipeline.columns.pop();
    const saved = await inject(h.app, 'PUT', '/api/projects/AR/config', cookie, {
      config: repaired,
      baseVersion: view.version,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const hired = await inject(h.app, 'POST', '/api/projects/AR/members', cookie, { role: 'qa' });
    expect(hired.statusCode, hired.body).toBe(201);
  });

  it('registers a project only the customization repository holds, with its legacy release gate, and lists it', async () => {
    // A fictional project as it was stored before labels; its release gate is a human_approval on the release approval duty.
    const source = new URL('./fixtures/legacy-release-gate/', import.meta.url);
    const directory = join(h.home, 'customization/projects/LG');
    mkdirSync(directory, { recursive: true });
    for (const file of ['project.yaml', 'team.yaml', 'pipeline.yaml'])
      writeFileSync(join(directory, file), readFileSync(new URL(file, source), 'utf8'));
    await restart();

    const { domain } = h.app.projectman;
    expect(domain.projects.has('LG')).toBe(true);
    const release = (await domain.projects.config('LG')).pipeline.stages.find(
      (stage) => stage.id === 'release',
    );
    expect(release?.gate).toEqual({ conditions: [{ type: 'has_label', label: 'release-approved' }] });
    expect(await domain.projectsFor('owner@example.test')).toEqual([
      expect.objectContaining({ key: 'LG', access: 'owner' }),
    ]);
  });

  it('takes the approval of a release away from everyone but the release approval duty when the project loads', async () => {
    await addHumanAndLogin(h.app, { handle: 'kata', name: 'Kata', access: 'client' });
    const before = await config();
    const task = { assignee: null, links: [] };
    const kata = { kind: 'human', handle: 'kata' } as const;
    expect(labelRefusal(before, labelDefinition(before, 'release-ok'), kata, task)).toBe('not_holder');

    // The release approval as it could be stored before: every human, clients and viewers included.
    const wide = { ...labelDefinition(before, 'release-ok')!, setBy: 'humans' as const };
    expect(labelRefusal(before, wide, kata, task)).toBeNull();
    handEdit('pipeline.yaml', (document) => {
      document.labels.find((label: { id: string }) => label.id === 'release-ok').setBy = 'humans';
    });
    await restart();

    const after = await config();
    expect(labelDefinition(after, 'release-ok')!.setBy).toEqual({
      duties: ['release_approval'],
      humansOnly: true,
    });
    expect(labelRefusal(after, labelDefinition(after, 'release-ok'), kata, task)).toBe('not_holder');
    expect(Me.parse((await inject(h.app, 'GET', '/api/me', cookie)).json()).projects).toHaveLength(1);
    // The owner holds the duty, so edits go on; the narrowed label is what the next commit stores.
    const view = (await inject(h.app, 'GET', '/api/projects/AR/config', cookie)).json<ConfigView>();
    const patched = await inject(h.app, 'PATCH', '/api/projects/AR/config', cookie, {
      baseVersion: view.version,
      limits: { maxConcurrentAi: 2 },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    const stored = readFileSync(join(h.home, 'customization/projects/AR/pipeline.yaml'), 'utf8');
    expect(stored).not.toContain('setBy: humans');
  });
});
