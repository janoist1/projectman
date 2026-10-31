import { routes } from '@projectman/shared';
import type { DocumentDetail, DocumentHistoryResponse, DocumentListResponse } from '@projectman/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addHumanAndLogin, createAppHarness, createProject, inject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';

/** The documents over REST: a real git repository in the harness's customization directory. */
describe('documents API', () => {
  let h: AppHarness;
  let owner: string;
  const documents = routes.documents('AR');

  beforeEach(async () => {
    h = await createAppHarness();
    owner = await setupOwner(h.app);
    await createProject(h, owner);
  });
  afterEach(async () => {
    await h.close();
  });

  const create = async (cookie = owner, title = 'Project plan', content = '# Plan\n\n## Steps\n1. one') =>
    inject(h.app, 'POST', documents, cookie, { title, content, message: 'Start' });

  it('creates, edits, reads an old version, restores and deletes a document', async () => {
    const created = await create();
    expect(created.statusCode, created.body).toBe(201);
    const first = created.json<DocumentDetail>();
    expect(first.document).toMatchObject({ slug: 'project-plan', title: 'Project plan' });

    const edited = await inject(h.app, 'PATCH', routes.document('AR', 'project-plan'), owner, {
      baseVersion: first.document.version,
      content: '# Plan\n\nnew text',
      message: 'Rewrite',
    });
    expect(edited.statusCode, edited.body).toBe(200);
    const second = edited.json<DocumentDetail>();
    expect(second.document.version).not.toBe(first.document.version);

    const list = await inject(h.app, 'GET', documents, owner);
    expect(list.json<DocumentListResponse>().documents.map((d) => d.slug)).toEqual(['project-plan']);
    expect(JSON.stringify(list.json())).not.toContain('new text');

    const old = await inject(
      h.app,
      'GET',
      `${routes.document('AR', 'project-plan')}?version=${first.document.version}`,
      owner,
    );
    expect(old.json<DocumentDetail>().content).toContain('1. one');

    const history = await inject(h.app, 'GET', routes.documentHistory('AR', 'project-plan'), owner);
    expect(history.json<DocumentHistoryResponse>().versions.map((v) => v.message)).toEqual([
      'Rewrite',
      'Start',
    ]);

    const restored = await inject(h.app, 'POST', routes.documentRestore('AR', 'project-plan'), owner, {
      version: first.document.version,
      baseVersion: second.document.version,
      message: 'Back to the first',
    });
    expect(restored.statusCode, restored.body).toBe(200);
    const third = restored.json<DocumentDetail>();
    expect(third.content).toContain('1. one');

    const deleted = await inject(
      h.app,
      'DELETE',
      `${routes.document('AR', 'project-plan')}?baseVersion=${third.document.version}&message=Obsolete`,
      owner,
    );
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(
      (await inject(h.app, 'GET', documents, owner)).json<DocumentListResponse>().documents,
    ).toHaveLength(0);
    const after = await inject(h.app, 'GET', routes.documentHistory('AR', 'project-plan'), owner);
    expect(after.json<DocumentHistoryResponse>().versions[0]).toMatchObject({
      deleted: true,
      message: 'Obsolete',
    });
  });

  it('refuses every write without its reason, with its own error code, and writes nothing', async () => {
    const first = (await create()).json<DocumentDetail>();
    const slug = routes.document('AR', 'project-plan');
    const base = first.document.version;
    const refused = [
      await inject(h.app, 'POST', documents, owner, { title: 'No reason', content: 'x' }),
      await inject(h.app, 'POST', documents, owner, { title: 'Blank', content: 'x', message: '   ' }),
      await inject(h.app, 'PATCH', slug, owner, { baseVersion: base, content: 'y' }),
      await inject(h.app, 'POST', routes.documentRestore('AR', 'project-plan'), owner, {
        version: base,
        baseVersion: base,
      }),
      await inject(h.app, 'DELETE', `${slug}?baseVersion=${base}`, owner),
    ];
    expect(refused.map((r) => [r.statusCode, r.json().error.code])).toEqual(
      refused.map(() => [400, 'document_message_required']),
    );
    const history = await inject(h.app, 'GET', routes.documentHistory('AR', 'project-plan'), owner);
    expect(history.json<DocumentHistoryResponse>().versions).toHaveLength(1);
    expect(
      (await inject(h.app, 'GET', documents, owner)).json<DocumentListResponse>().documents,
    ).toHaveLength(1);
  });

  it('answers a stale base version with 409 and the current version', async () => {
    const first = (await create()).json<DocumentDetail>();
    await inject(h.app, 'PATCH', routes.document('AR', 'project-plan'), owner, {
      baseVersion: first.document.version,
      content: 'newer',
      message: 'Update',
    });
    const stale = await inject(h.app, 'PATCH', routes.document('AR', 'project-plan'), owner, {
      baseVersion: first.document.version,
      content: 'mine',
      message: 'Update',
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toMatchObject({ code: 'document_conflict' });
    expect(stale.json().error.details.currentVersion).toMatch(/^[0-9a-f]{40}$/);
  });

  it('refuses a document over the size limit with 413', async () => {
    const big = await create(owner, 'Big', 'x'.repeat(200_001));
    expect([big.statusCode, big.json().error.code]).toEqual([413, 'document_too_large']);
  });

  it('answers 404 for an unknown document and 400 for a bad slug', async () => {
    const missing = await inject(h.app, 'GET', routes.document('AR', 'nope'), owner);
    expect([missing.statusCode, missing.json().error.code]).toEqual([404, 'document_not_found']);
    const bad = await inject(h.app, 'GET', routes.document('AR', 'Bad_Slug'), owner);
    expect(bad.statusCode).toBe(400);
  });

  describe('access', () => {
    let documentVersion: string;
    beforeEach(async () => {
      documentVersion = (await create()).json<DocumentDetail>().document.version;
    });

    it('lets a developer read and write but not delete', async () => {
      const developer = await addHumanAndLogin(h.app, { handle: 'dev', access: 'developer' });
      expect((await inject(h.app, 'GET', documents, developer)).statusCode).toBe(200);
      expect((await create(developer, 'By dev')).statusCode).toBe(201);
      const del = await inject(
        h.app,
        'DELETE',
        `${routes.document('AR', 'project-plan')}?baseVersion=${documentVersion}&message=Remove`,
        developer,
      );
      expect([del.statusCode, del.json().error.code]).toEqual([403, 'insufficient_access']);
    });

    it('lets a viewer read but not write', async () => {
      const viewer = await addHumanAndLogin(h.app, { handle: 'view', access: 'viewer' });
      expect((await inject(h.app, 'GET', routes.document('AR', 'project-plan'), viewer)).statusCode).toBe(
        200,
      );
      expect((await create(viewer, 'By viewer')).statusCode).toBe(403);
      const patch = await inject(h.app, 'PATCH', routes.document('AR', 'project-plan'), viewer, {
        baseVersion: documentVersion,
        content: 'x',
        message: 'Edit',
      });
      expect(patch.statusCode).toBe(403);
    });

    it('shows a client nothing', async () => {
      const client = await addHumanAndLogin(h.app, { handle: 'cli', access: 'client' });
      for (const url of [
        documents,
        routes.document('AR', 'project-plan'),
        routes.documentHistory('AR', 'project-plan'),
      ]) {
        expect((await inject(h.app, 'GET', url, client)).statusCode).toBe(403);
      }
      expect((await create(client, 'By client')).statusCode).toBe(403);
    });
  });
});
