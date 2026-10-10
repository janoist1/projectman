import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { ProjectConfig, ProjectPreview, routes } from '@projectman/shared';
import type { ConfigView } from '@projectman/shared';
import type { ProjectTemplate } from '@projectman/templates';
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

describe('project preview and creation with a card mover (PM-459)', () => {
  let h: AppHarness;
  let cookie: string;
  beforeEach(async () => {
    h = await createAppHarness({ extraTemplates: [ownerlessTemplate] });
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
  const preview = (body: unknown, as = cookie) => inject(h.app, 'POST', routes.projectPreview(), as, body);
  const projectKeys = async () =>
    (await inject(h.app, 'GET', routes.projects(), cookie)).json<Array<{ key: string }>>().map((p) => p.key);

  it('answers the configuration a create would save and its issues, and changes nothing', async () => {
    const res = await preview(request({ cardMover: 'creator' }));
    expect(res.statusCode, res.body).toBe(200);
    const body = ProjectPreview.parse(res.json());
    expect(body.config.project).toMatchObject({ key: 'BB', name: 'Brand new', templateId: 'test' });
    expect(body.config.team.cardMover).toEqual({ kind: 'human', handle: 'owner' });
    expect(body.issues.filter((issue) => issue.severity !== 'warning')).toEqual([]);
    expect(await projectKeys()).toEqual([]);
  });

  it('maps the mover choices and defaults to the worker', async () => {
    const moverOf = async (cardMover?: string) =>
      ProjectPreview.parse((await preview(request(cardMover ? { cardMover } : {}))).json()).config.team
        .cardMover;
    expect(await moverOf()).toEqual({ kind: 'worker' });
    expect(await moverOf('worker')).toEqual({ kind: 'worker' });
    expect(await moverOf('project_manager')).toEqual({ kind: 'project_manager' });
    expect(await moverOf('creator')).toEqual({ kind: 'human', handle: 'owner' });
    expect((await preview(request({ cardMover: 'nobody' }))).statusCode).toBe(400);
  });

  it('reads no disk: a workspace that does not exist and a taken key are not its business', async () => {
    await createProject(h, cookie);
    const res = await preview(request({ key: 'AR', workspacePath: join(h.home, 'does-not-exist') }));
    expect(res.statusCode, res.body).toBe(200);
  });

  it('lists what is wrong with a combination', async () => {
    const res = await preview(request({ templateId: 'ownerless' }));
    expect(res.statusCode, res.body).toBe(200);
    expect(ProjectPreview.parse(res.json()).issues).toContainEqual({
      code: 'stage_without_owner',
      path: 'pipeline.stages[2]',
      detail: 'code_review',
    });
  });

  it('refuses an unknown template as the create does', async () => {
    const asPreview = await preview(request({ templateId: 'nope' }));
    const asCreate = await inject(h.app, 'POST', routes.projects(), cookie, request({ templateId: 'nope' }));
    expect([asPreview.statusCode, asPreview.json().error.code]).toEqual([400, 'unknown_template']);
    expect([asCreate.statusCode, asCreate.json().error.code]).toEqual([400, 'unknown_template']);
  });

  it('is for the host owner alone', async () => {
    await createProject(h, cookie);
    const admin = await addHumanAndLogin(h.app, { handle: 'ada', access: 'admin' });
    const res = await preview(request(), admin);
    expect([res.statusCode, res.json().error.code]).toEqual([403, 'owner_only']);
    expect((await inject(h.app, 'POST', routes.projectPreview(), '', request())).statusCode).toBe(401);
  });

  it('creates the project with the creator as the card mover', async () => {
    const res = await inject(h.app, 'POST', routes.projects(), cookie, request({ cardMover: 'creator' }));
    expect(res.statusCode, res.body).toBe(201);
    const { config } = await h.app.projectman.configStore.load('BB');
    expect(config.team.cardMover).toEqual({ kind: 'human', handle: 'owner' });
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
