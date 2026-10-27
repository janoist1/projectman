import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { ProjectConfig, routes } from '@projectman/shared';
import type { ConfigView } from '@projectman/shared';
import { getTemplate, type ProjectTemplate } from '@projectman/templates';
import { parseYamlFile } from '../src/config/layout';
import { addHumanAndLogin, createAppHarness, createProject, inject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { testTemplate } from './helpers/test-template';

/** The test template with a review step nobody owns: `stage_without_owner`. */
const ownerlessTemplate: ProjectTemplate = {
  ...testTemplate,
  id: 'ownerless',
  build: (input) => {
    const config = testTemplate.build(input);
    config.pipeline.stages.find((stage) => stage.id === 'code_review')!.owners = [];
    return config;
  },
};

describe('project creation with a card mover (PM-459)', () => {
  let h: AppHarness;
  let cookie: string;
  beforeEach(async () => {
    h = await createAppHarness({ extraTemplates: [ownerlessTemplate, getTemplate('starter')!] });
    cookie = await setupOwner(h.app);
  });
  afterEach(async () => h.close());

  const request = (overrides: Record<string, unknown> = {}) => ({
    key: 'BB',
    name: 'Brand new',
    workspacePath: h.workspace,
    templateId: 'test',
    ...overrides,
  });
  const create = (body: unknown, as = cookie) => inject(h.app, 'POST', routes.projects(), as, body);
  const projectKeys = async () =>
    (await inject(h.app, 'GET', routes.projects(), cookie)).json<Array<{ key: string }>>().map((p) => p.key);

  it('maps the mover choices and defaults to the worker', async () => {
    const moverOf = async (cardMover: string | undefined, key: string) => {
      const res = await create(request({ key, ...(cardMover ? { cardMover } : {}) }));
      expect(res.statusCode, res.body).toBe(201);
      return (await h.app.projectman.configStore.load(key)).config.team.cardMover;
    };
    expect(await moverOf(undefined, 'BA')).toEqual({ kind: 'worker' });
    expect(await moverOf('worker', 'BB')).toEqual({ kind: 'worker' });
    expect(await moverOf('project_manager', 'BC')).toEqual({ kind: 'project_manager' });
    expect(await moverOf('creator', 'BD')).toEqual({ kind: 'human', handle: 'owner' });
    expect((await create(request({ key: 'BE', cardMover: 'nobody' }))).statusCode).toBe(400);
  });

  it('refuses an unknown template', async () => {
    const res = await create(request({ templateId: 'nope' }));
    expect([res.statusCode, res.json().error.code]).toEqual([400, 'unknown_template']);
  });

  it('is for the host owner alone', async () => {
    await createProject(h, cookie);
    const admin = await addHumanAndLogin(h.app, { handle: 'ada', access: 'admin' });
    const res = await create(request(), admin);
    expect([res.statusCode, res.json().error.code]).toEqual([403, 'owner_only']);
    expect((await create(request(), '')).statusCode).toBe(401);
  });

  it('creates a starter without a template id in the requested language and provider', async () => {
    const res = await inject(h.app, 'POST', routes.projects(), cookie, {
      key: 'BB',
      name: 'Starter',
      workspacePath: h.workspace,
      language: 'en',
      provider: 'codex',
    });
    expect(res.statusCode, res.body).toBe(201);
    const { config } = await h.app.projectman.configStore.load('BB');
    expect(config.project).toMatchObject({ templateId: 'starter', language: 'en' });
    expect(config.team.members.filter((member) => member.kind === 'ai')).toHaveLength(3);
    expect(
      config.team.members
        .filter((member) => member.kind === 'ai')
        .every((member) => member.provider === 'codex'),
    ).toBe(true);
  });

  it('refuses a combination that does not work, with the issues, and creates nothing', async () => {
    const res = await inject(h.app, 'POST', routes.projects(), cookie, request({ templateId: 'ownerless' }));
    expect([res.statusCode, res.json().error.code]).toEqual([422, 'invalid_config']);
    expect(res.json().error.details.issues).toContainEqual({
      code: 'stage_without_owner',
      path: 'pipeline.stages[2]',
      detail: 'code_review',
    });
    expect(await projectKeys()).toEqual([]);
  });

  describe('a stored configuration that breaks the new rules', () => {
    beforeEach(async () => createProject(h, cookie));

    /** A hand edit of a stored file in the customization repository. */
    function handEdit(file: 'team.yaml' | 'pipeline.yaml', change: (document: any) => void) {
      const path = join(h.home, 'customization/projects/AR', file);
      const document = parseYamlFile(file, readFileSync(path, 'utf8'));
      change(document);
      writeFileSync(path, stringify(document));
    }

    it('loads, and an unrelated change saves; a new break is refused', async () => {
      handEdit('pipeline.yaml', (document) => {
        document.stages.find((stage: { id: string }) => stage.id === 'code_review').owners = [];
      });
      handEdit('team.yaml', (document) => {
        document.cardMover = { kind: 'human', handle: 'ghost' };
      });
      await h.app.projectman.domain.projects.syncFromStore();

      const view = (await inject(h.app, 'GET', '/api/projects/AR/config', cookie)).json<ConfigView>();
      expect(ProjectConfig.parse(view.config).team.cardMover).toEqual({ kind: 'human', handle: 'ghost' });
      const patched = await inject(h.app, 'PATCH', '/api/projects/AR/config', cookie, {
        baseVersion: view.version,
        limits: { maxConcurrentAi: 2 },
      });
      expect(patched.statusCode, patched.body).toBe(200);

      const current = (await inject(h.app, 'GET', '/api/projects/AR/config', cookie)).json<ConfigView>();
      const pipeline = structuredClone(current.config.pipeline);
      pipeline.stages.find((stage) => stage.id === 'merge')!.owners = [];
      const refused = await inject(h.app, 'PATCH', '/api/projects/AR/config', cookie, {
        baseVersion: current.version,
        pipeline,
      });
      expect([refused.statusCode, refused.json().error.code]).toEqual([400, 'config_invalid']);
      expect(refused.json().error.details.issues).toEqual([
        { code: 'stage_without_owner', path: 'pipeline.stages[3]', detail: 'merge' },
      ]);
    });
  });
});
