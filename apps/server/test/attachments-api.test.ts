import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AttachmentListResponse,
  MAX_ATTACHMENT_BYTES,
  routes,
  TaskDetail,
  UploadAttachmentResponse,
} from '@projectman/shared';
import type { Attachment } from '@projectman/shared';
import { aiActor } from '../src/domain';
import { addHumanAndLogin, createAppHarness, createProject, inject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { OWNER_ACTOR } from './helpers/domain-harness';
import { fileBody, htmlBytes, pdfBytes, pngBytes, svgBytes, uploadFile } from './helpers/attachments';
import { Readable } from 'node:stream';

describe('task attachments API', () => {
  let h: AppHarness;
  let owner: string;
  const cookies: Record<string, string> = {};

  beforeEach(async () => {
    h = await createAppHarness();
    owner = await setupOwner(h.app);
    await createProject(h, owner);
    cookies.admin = await addHumanAndLogin(h.app, { handle: 'ada', access: 'admin' });
    cookies.developer = await addHumanAndLogin(h.app, { handle: 'robin', access: 'developer' });
    cookies.other = await addHumanAndLogin(h.app, { handle: 'olga', access: 'developer' });
    cookies.client = await addHumanAndLogin(h.app, { handle: 'cleo', access: 'client' });
    cookies.viewer = await addHumanAndLogin(h.app, { handle: 'vic', access: 'viewer' });
    cookies.stranger = await addHumanAndLogin(h.app, { handle: 'sam', projectKey: null });
    const { tasks } = h.app.projectman.domain;
    await tasks.create('AR', { title: 'Internal task' }, OWNER_ACTOR);
    await tasks.create('AR', { title: 'Shared task', visibility: 'shared' }, OWNER_ACTOR);
  });
  afterEach(async () => h.close());

  const upload = async (
    cookie: string,
    content: Buffer | string = pngBytes(),
    opts: Parameters<typeof uploadFile>[3] = {},
  ): Promise<Attachment> => {
    const response = await uploadFile(h.app, cookie, content, opts);
    expect(response.statusCode, response.body).toBe(201);
    return UploadAttachmentResponse.parse(response.json()).attachment;
  };
  const urlOf = (
    route: 'attachmentContent' | 'attachmentDownload' | 'taskAttachment',
    id: string,
    taskKey = 'AR-1',
    projectKey = 'AR',
  ) => routes[route](projectKey, taskKey, id);
  const attachmentsDir = () => join(h.home, 'attachments');
  const storedFiles = (taskKey = 'AR-1'): string[] => {
    try {
      return readdirSync(join(attachmentsDir(), 'AR', taskKey)).sort();
    } catch {
      return [];
    }
  };
  const errorCode = (response: { json: () => unknown }) =>
    (response.json() as { error: { code: string } }).error.code;

  describe('upload, list, open, download and delete', () => {
    it('stores the file durably and serves it back through the protected routes', async () => {
      const bytes = pngBytes(300);
      const attachment = await upload(cookies.developer!, bytes, { fileName: 'first picture.png' });
      expect(attachment).toMatchObject({
        projectKey: 'AR',
        taskKey: 'AR-1',
        fileName: 'first picture.png',
        size: 300,
        mediaType: 'image/png',
        preview: 'image',
        uploadedBy: { kind: 'human', handle: 'robin' },
      });
      // The storage path is not part of what the web gets.
      expect(Object.keys(attachment).sort()).toEqual(
        [
          'createdAt',
          'fileName',
          'id',
          'mediaType',
          'preview',
          'projectKey',
          'size',
          'taskKey',
          'uploadedBy',
        ].sort(),
      );

      const file = join(attachmentsDir(), 'AR', 'AR-1', attachment.id);
      expect(readFileSync(file).equals(bytes)).toBe(true);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(join(attachmentsDir(), 'AR', 'AR-1')).mode & 0o777).toBe(0o700);
      expect(storedFiles()).toEqual([attachment.id]);

      const list = await inject(h.app, 'GET', routes.taskAttachments('AR', 'AR-1'), owner);
      expect(AttachmentListResponse.parse(list.json()).attachments).toEqual([attachment]);

      const content = await inject(h.app, 'GET', urlOf('attachmentContent', attachment.id), owner);
      expect(content.statusCode).toBe(200);
      expect(content.rawPayload.equals(bytes)).toBe(true);
      expect(content.headers['content-type']).toBe('image/png');
      expect(content.headers['content-length']).toBe('300');
      expect(String(content.headers['content-disposition'])).toMatch(/^inline; /);

      const download = await inject(h.app, 'GET', urlOf('attachmentDownload', attachment.id), owner);
      expect(download.statusCode).toBe(200);
      expect(download.rawPayload.equals(bytes)).toBe(true);
      expect(String(download.headers['content-disposition'])).toMatch(/^attachment; /);
    });

    it('lists the attachments oldest first, and only those of the task', async () => {
      const first = await upload(cookies.developer!, pngBytes(10), { fileName: 'a.png' });
      const second = await upload(owner, pdfBytes(), { fileName: 'b.pdf' });
      await upload(owner, pngBytes(10), { fileName: 'c.png', taskKey: 'AR-2' });
      const list = await inject(h.app, 'GET', routes.taskAttachments('AR', 'AR-1'), owner);
      expect(AttachmentListResponse.parse(list.json()).attachments.map((a) => a.id)).toEqual([
        first.id,
        second.id,
      ]);
    });

    it('keeps two uploads of the same name apart', async () => {
      const first = await upload(owner, pngBytes(20), { fileName: 'same.png' });
      const second = await upload(owner, pngBytes(30), { fileName: 'same.png' });
      expect(first.id).not.toBe(second.id);
      expect(storedFiles()).toEqual([first.id, second.id].sort());
      const sizes = [first, second].map(
        async (a) => (await inject(h.app, 'GET', urlOf('attachmentContent', a.id), owner)).rawPayload.length,
      );
      expect(await Promise.all(sizes)).toEqual([20, 30]);
    });

    it('deletes file and metadata and records who did what in the task timeline', async () => {
      const attachment = await upload(cookies.developer!, pngBytes(), { fileName: 'plan.png' });
      const deleted = await inject(h.app, 'DELETE', urlOf('taskAttachment', attachment.id), cookies.admin);
      expect(deleted.statusCode).toBe(200);
      expect(deleted.json()).toEqual({ id: attachment.id, deleted: true });
      expect(storedFiles()).toEqual([]);
      expect(h.app.projectman.repos.attachments.get(attachment.id)).toBeNull();

      for (const url of [
        urlOf('attachmentContent', attachment.id),
        urlOf('attachmentDownload', attachment.id),
      ]) {
        expect((await inject(h.app, 'GET', url, owner)).statusCode).toBe(404);
      }
      expect((await inject(h.app, 'DELETE', urlOf('taskAttachment', attachment.id), owner)).statusCode).toBe(
        404,
      );

      const detail = TaskDetail.parse((await inject(h.app, 'GET', routes.task('AR', 'AR-1'), owner)).json());
      const events = detail.timeline.filter((e) => e.type.startsWith('attachment_'));
      expect(events.map((e) => [e.type, e.actor, e.data])).toEqual([
        [
          'attachment_added',
          { kind: 'human', handle: 'robin' },
          { attachmentId: attachment.id, fileName: 'plan.png', size: 64, mediaType: 'image/png' },
        ],
        [
          'attachment_deleted',
          { kind: 'human', handle: 'ada' },
          { attachmentId: attachment.id, fileName: 'plan.png', size: 64, mediaType: 'image/png' },
        ],
      ]);
    });

    it('answers HEAD like GET, with the same checks and no body', async () => {
      const attachment = await upload(owner, pngBytes(123));
      const head = await inject(h.app, 'HEAD', urlOf('attachmentContent', attachment.id), owner);
      expect(head.statusCode).toBe(200);
      expect(head.headers['content-length']).toBe('123');
      expect(head.headers['content-type']).toBe('image/png');
      expect(head.rawPayload.length).toBe(0);
      expect(
        (await inject(h.app, 'HEAD', urlOf('attachmentDownload', attachment.id), owner)).statusCode,
      ).toBe(200);
      expect((await inject(h.app, 'HEAD', urlOf('attachmentContent', attachment.id), null)).statusCode).toBe(
        401,
      );
      expect(
        (await inject(h.app, 'HEAD', urlOf('attachmentContent', attachment.id), cookies.client)).statusCode,
      ).toBe(404);
      expect(
        (await inject(h.app, 'HEAD', urlOf('attachmentContent', attachment.id), cookies.stranger)).statusCode,
      ).toBe(403);
    });
  });

  describe('what is served inline', () => {
    const served = async (content: Buffer | string, fileName: string, declaredType?: string) => {
      const attachment = await upload(owner, content, { fileName, declaredType });
      const response = await inject(h.app, 'GET', urlOf('attachmentContent', attachment.id), owner);
      return { attachment, response };
    };

    it.each([
      ['a PNG', pngBytes(), 'image/png', 'image'],
      ['a PDF', pdfBytes(), 'application/pdf', 'pdf'],
      ['a JPEG', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]), 'image/jpeg', 'image'],
      ['a GIF', Buffer.from('GIF89a......'), 'image/gif', 'image'],
      [
        'a WebP',
        Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]),
        'image/webp',
        'image',
      ],
    ])(
      'shows %s inline once its content proves it, whatever its name and declared type',
      async (_, bytes, type, preview) => {
        const { attachment, response } = await served(bytes, 'notes.txt', 'text/html');
        expect(attachment).toMatchObject({ mediaType: type, preview });
        expect(response.headers['content-type']).toBe(type);
        expect(String(response.headers['content-disposition'])).toMatch(/^inline; /);
      },
    );

    it.each([
      ['HTML named like an image', htmlBytes(), 'photo.png', 'image/png'],
      ['SVG', svgBytes(), 'logo.svg', 'image/svg+xml'],
      ['a renamed executable', Buffer.from('MZ\u0090\u0000'), 'cute.pdf', 'application/pdf'],
      ['unknown bytes', Buffer.from('plain text'), 'readme.txt', 'text/plain'],
      ['an empty file', Buffer.alloc(0), 'empty.png', 'image/png'],
      ['a truncated PNG signature', pngBytes().subarray(0, 5), 'cut.png', 'image/png'],
    ])(
      'serves %s as an attachment of type application/octet-stream',
      async (_, bytes, fileName, declared) => {
        const { attachment, response } = await served(bytes, fileName, declared);
        expect(attachment).toMatchObject({ mediaType: 'application/octet-stream', preview: 'none' });
        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toBe('application/octet-stream');
        expect(String(response.headers['content-disposition'])).toMatch(/^attachment; /);
        expect(response.rawPayload.equals(bytes)).toBe(true);
      },
    );

    it('sends the protective headers on every content and download response', async () => {
      const png = await upload(owner, pngBytes());
      const pdf = await upload(owner, pdfBytes(), { fileName: 'doc.pdf' });
      const html = await upload(owner, htmlBytes(), { fileName: 'page.html' });
      for (const attachment of [png, pdf, html]) {
        for (const route of ['attachmentContent', 'attachmentDownload'] as const) {
          const response = await inject(h.app, 'GET', urlOf(route, attachment.id), owner);
          expect(response.headers['x-content-type-options']).toBe('nosniff');
          expect(response.headers['cache-control']).toBe('private, no-store');
          expect(response.headers['content-security-policy']).toContain("default-src 'none'");
          expect(response.headers['content-security-policy']).toContain('sandbox');
          expect(response.headers['cross-origin-resource-policy']).toBe('same-origin');
          expect(response.headers['referrer-policy']).toBe('no-referrer');
        }
      }
      // A download is never inline, even for an image.
      const download = await inject(h.app, 'GET', urlOf('attachmentDownload', png.id), owner);
      expect(String(download.headers['content-disposition'])).toMatch(/^attachment; /);
    });

    it('keeps the file name out of the paths and encodes it safely in the header', async () => {
      const cases: Array<[string, string]> = [
        ['../../etc/passwd', 'passwd'],
        ['..\\..\\windows\\system32\\evil.png', 'evil.png'],
        ['/absolute/path/photo.png', 'photo.png'],
        ['..', 'file'],
        ['', 'file'],
        ['   ', 'file'],
      ];
      for (const [sent, stored] of cases) {
        const attachment = await upload(owner, pngBytes(), { fileName: sent });
        expect(attachment.fileName).toBe(stored);
        expect(storedFiles()).toContain(attachment.id);
      }
      expect(readdirSync(join(attachmentsDir(), 'AR'))).toEqual(['AR-1']);
      expect(readdirSync(attachmentsDir())).toEqual(['AR']);

      // UTF-8 as a browser sends it, a right-to-left override inside.
      const tricky = await upload(owner, pngBytes(), { fileName: 'árvíztűrő; x=1‮gnp.png' });
      expect(tricky.fileName).toBe('árvíztűrő; x=1gnp.png');
      const response = await inject(h.app, 'GET', urlOf('attachmentContent', tricky.id), owner);
      const disposition = String(response.headers['content-disposition']);
      expect(disposition).not.toMatch(/[\r\n]/);
      expect(disposition).toBe(
        'inline; filename="_rv_zt_r__ x=1gnp.png"; filename*=UTF-8\'\'%C3%A1rv%C3%ADzt%C5%B1r%C5%91%3B%20x%3D1gnp.png',
      );
    });
  });

  describe('size limit', () => {
    it('accepts exactly 25 000 000 bytes and refuses one more, leaving nothing behind', async () => {
      expect(MAX_ATTACHMENT_BYTES).toBe(25_000_000);
      const exact = Buffer.alloc(MAX_ATTACHMENT_BYTES, 1);
      const accepted = await upload(owner, exact, { fileName: 'big.bin' });
      expect(accepted.size).toBe(25_000_000);
      expect(statSync(join(attachmentsDir(), 'AR', 'AR-1', accepted.id)).size).toBe(25_000_000);

      const refused = await uploadFile(h.app, owner, Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 1), {
        fileName: 'too-big.bin',
      });
      expect(refused.statusCode).toBe(413);
      expect(errorCode(refused)).toBe('attachment_too_large');
      expect(storedFiles()).toEqual([accepted.id]);
      expect(h.app.projectman.repos.attachments.inState('pending')).toEqual([]);
      const list = await inject(h.app, 'GET', routes.taskAttachments('AR', 'AR-1'), owner);
      expect(AttachmentListResponse.parse(list.json()).attachments).toHaveLength(1);
    }, 30_000);

    it('refuses a declared length far over the limit before reading the body', async () => {
      const body = fileBody(pngBytes());
      const response = await h.app.inject({
        method: 'POST',
        url: routes.taskAttachments('AR', 'AR-1'),
        headers: {
          cookie: owner,
          ...body.headers,
          'content-length': String(MAX_ATTACHMENT_BYTES + 1_000_000),
        },
        payload: Readable.from([body.payload]),
      });
      expect(response.statusCode).toBe(413);
      expect(errorCode(response)).toBe('attachment_too_large');
    });

    it('keeps the global JSON limit, and takes no file on other routes', async () => {
      const big = await h.app.inject({
        method: 'POST',
        url: routes.taskComments('AR', 'AR-1'),
        headers: { cookie: owner, 'content-type': 'application/json' },
        payload: JSON.stringify({ text: 'x'.repeat(5 * 1024 * 1024 + 1) }),
      });
      expect(big.statusCode).toBe(413);
      const body = fileBody(pngBytes());
      const elsewhere = await h.app.inject({
        method: 'POST',
        url: routes.taskComments('AR', 'AR-1'),
        headers: { cookie: owner, ...body.headers },
        payload: body.payload,
      });
      expect(elsewhere.statusCode).toBe(415);
    });
  });

  describe('malformed requests', () => {
    it('refuses a body that is not multipart, or has no file', async () => {
      const json = await inject(h.app, 'POST', routes.taskAttachments('AR', 'AR-1'), owner, { a: 1 });
      expect(json.statusCode).toBe(415);
      expect(errorCode(json)).toBe('unsupported_media_type');

      const noFile = fileBody('hello');
      const fieldsOnly = await h.app.inject({
        method: 'POST',
        url: routes.taskAttachments('AR', 'AR-1'),
        headers: {
          cookie: owner,
          'content-type': noFile.headers['content-type'],
        },
        payload: noFile.payload
          .toString()
          .replace('; filename="picture.png"', '')
          .replace('Content-Type: application/octet-stream\r\n', ''),
      });
      expect(fieldsOnly.statusCode).toBe(400);
      expect(errorCode(fieldsOnly)).toBe('invalid_request');
      expect(storedFiles()).toEqual([]);
    });

    it('takes a single file only', async () => {
      const first = await upload(owner, pngBytes(), { fileName: 'one.png' });
      expect(first.fileName).toBe('one.png');
      expect(storedFiles()).toHaveLength(1);
    });
  });

  describe('who may do what', () => {
    it('lets every project member who sees the task read; clients only on shared tasks', async () => {
      const internal = await upload(owner, pngBytes(), { taskKey: 'AR-1' });
      const shared = await upload(owner, pngBytes(), { taskKey: 'AR-2' });
      for (const who of ['admin', 'developer', 'viewer'] as const) {
        const list = await inject(h.app, 'GET', routes.taskAttachments('AR', 'AR-1'), cookies[who]!);
        expect(list.statusCode, who).toBe(200);
        const content = await inject(h.app, 'GET', urlOf('attachmentContent', internal.id), cookies[who]!);
        expect(content.statusCode, who).toBe(200);
      }
      // A client does not even learn that the internal task exists.
      for (const url of [
        routes.taskAttachments('AR', 'AR-1'),
        urlOf('attachmentContent', internal.id),
        urlOf('attachmentDownload', internal.id),
      ]) {
        const response = await inject(h.app, 'GET', url, cookies.client!);
        expect(response.statusCode, url).toBe(404);
        expect(errorCode(response)).toBe('not_found');
      }
      const sharedList = await inject(h.app, 'GET', routes.taskAttachments('AR', 'AR-2'), cookies.client!);
      expect(AttachmentListResponse.parse(sharedList.json()).attachments.map((a) => a.id)).toEqual([
        shared.id,
      ]);
      expect(
        (await inject(h.app, 'GET', urlOf('attachmentContent', shared.id, 'AR-2'), cookies.client!))
          .statusCode,
      ).toBe(200);
    });

    it('lets everyone but viewers upload; a client only to a shared task', async () => {
      for (const who of ['admin', 'developer', 'other'] as const) {
        expect((await uploadFile(h.app, cookies[who]!, pngBytes())).statusCode, who).toBe(201);
      }
      const viewer = await uploadFile(h.app, cookies.viewer!, pngBytes());
      expect(viewer.statusCode).toBe(403);
      expect(errorCode(viewer)).toBe('insufficient_access');
      const clientInternal = await uploadFile(h.app, cookies.client!, pngBytes());
      expect(clientInternal.statusCode).toBe(404);
      expect((await uploadFile(h.app, cookies.client!, pngBytes(), { taskKey: 'AR-2' })).statusCode).toBe(
        201,
      );
      expect(storedFiles()).toHaveLength(3);
      expect(storedFiles('AR-2')).toHaveLength(1);
    });

    it('lets an AI member upload and delete its own file', async () => {
      const { attachments } = h.app.projectman.domain;
      const { Readable } = await import('node:stream');
      const attachment = await attachments.upload({
        projectKey: 'AR',
        taskKey: 'AR-1',
        actor: aiActor('dev-1'),
        fileName: 'screenshot.png',
        content: Readable.from([pngBytes()]),
      });
      expect(attachment.uploadedBy).toEqual({ kind: 'ai', handle: 'dev-1' });
      // Humans see it, and other AI members cannot delete it.
      const list = await inject(h.app, 'GET', routes.taskAttachments('AR', 'AR-1'), cookies.viewer!);
      expect(AttachmentListResponse.parse(list.json()).attachments).toHaveLength(1);
      await expect(attachments.delete('AR', 'AR-1', attachment.id, aiActor('dev-2'))).rejects.toMatchObject({
        code: 'insufficient_access',
      });
      await attachments.delete('AR', 'AR-1', attachment.id, aiActor('dev-1'));
      expect(storedFiles()).toEqual([]);
    });

    it('lets the uploader, an admin or the owner delete; nobody else, and no viewer', async () => {
      const mine = await upload(cookies.developer!);
      const denied = await inject(h.app, 'DELETE', urlOf('taskAttachment', mine.id), cookies.other);
      expect(denied.statusCode).toBe(403);
      expect(errorCode(denied)).toBe('insufficient_access');
      expect(
        (await inject(h.app, 'DELETE', urlOf('taskAttachment', mine.id), cookies.viewer)).statusCode,
      ).toBe(403);
      expect(storedFiles()).toEqual([mine.id]);
      expect(
        (await inject(h.app, 'DELETE', urlOf('taskAttachment', mine.id), cookies.developer)).statusCode,
      ).toBe(200);

      const byAdmin = await upload(cookies.developer!);
      expect(
        (await inject(h.app, 'DELETE', urlOf('taskAttachment', byAdmin.id), cookies.admin)).statusCode,
      ).toBe(200);
      const byOwner = await upload(cookies.developer!);
      expect((await inject(h.app, 'DELETE', urlOf('taskAttachment', byOwner.id), owner)).statusCode).toBe(
        200,
      );
      expect(storedFiles()).toEqual([]);
    });

    it('does not let a viewer delete an older upload of their own', async () => {
      const mine = await upload(cookies.developer!);
      await h.app.projectman.domain.projects.update(
        'AR',
        { actor: OWNER_ACTOR, author: { name: 'Owner', email: 'owner@example.com' } },
        (draft) => {
          const member = draft.team.members.find((m) => m.handle === 'robin');
          if (member?.kind === 'human') member.access = 'viewer';
          return 'Make robin a viewer';
        },
      );
      const response = await inject(h.app, 'DELETE', urlOf('taskAttachment', mine.id), cookies.developer);
      expect(response.statusCode).toBe(403);
      expect(storedFiles()).toEqual([mine.id]);
      // ... but can still read it.
      expect(
        (await inject(h.app, 'GET', urlOf('attachmentContent', mine.id), cookies.developer)).statusCode,
      ).toBe(200);
    });

    it('lets a client delete their own upload on a shared task', async () => {
      const own = await upload(cookies.client!, pngBytes(), { taskKey: 'AR-2' });
      const response = await inject(h.app, 'DELETE', urlOf('taskAttachment', own.id, 'AR-2'), cookies.client);
      expect(response.statusCode).toBe(200);
    });

    it('turns away anonymous users and people outside the project', async () => {
      const attachment = await upload(owner);
      for (const [method, url] of [
        ['GET', routes.taskAttachments('AR', 'AR-1')],
        ['GET', urlOf('attachmentContent', attachment.id)],
        ['GET', urlOf('attachmentDownload', attachment.id)],
        ['DELETE', urlOf('taskAttachment', attachment.id)],
      ] as const) {
        expect((await inject(h.app, method, url, null)).statusCode, `${method} ${url}`).toBe(401);
        const stranger = await inject(h.app, method, url, cookies.stranger);
        expect(stranger.statusCode, `${method} ${url}`).toBe(403);
        expect(errorCode(stranger)).toBe('not_a_member');
      }
      expect((await uploadFile(h.app, '', pngBytes())).statusCode).toBe(401);
      expect((await uploadFile(h.app, cookies.stranger!, pngBytes())).statusCode).toBe(403);
      expect(storedFiles()).toEqual([attachment.id]);
    });

    it('checks that project, task and attachment belong together', async () => {
      const attachment = await upload(owner, pngBytes(), { taskKey: 'AR-1' });
      for (const route of ['attachmentContent', 'attachmentDownload', 'taskAttachment'] as const) {
        const method = route === 'taskAttachment' ? 'DELETE' : 'GET';
        // Another task of the same project.
        expect(
          (await inject(h.app, method, urlOf(route, attachment.id, 'AR-2'), owner)).statusCode,
          route,
        ).toBe(404);
        // A task that does not exist, another project, a made-up id.
        expect(
          (await inject(h.app, method, urlOf(route, attachment.id, 'AR-99'), owner)).statusCode,
          route,
        ).toBe(404);
        expect(
          (await inject(h.app, method, urlOf(route, attachment.id, 'AR-1', 'ZZ'), owner)).statusCode,
          route,
        ).toBe(404);
        expect(
          (await inject(h.app, method, urlOf(route, 'att_doesnotexist1', 'AR-1'), owner)).statusCode,
          route,
        ).toBe(404);
        expect(
          (await inject(h.app, method, urlOf(route, '..%2F..%2Fsecret', 'AR-1'), owner)).statusCode,
          route,
        ).toBe(404);
      }
      expect(storedFiles()).toEqual([attachment.id]);
    });

    it('checks the current visibility: a client loses a task that turns internal', async () => {
      const shared = await upload(owner, pngBytes(), { taskKey: 'AR-2' });
      expect(
        (await inject(h.app, 'GET', urlOf('attachmentContent', shared.id, 'AR-2'), cookies.client!))
          .statusCode,
      ).toBe(200);
      await h.app.projectman.domain.tasks.update('AR', 'AR-2', { visibility: 'internal' }, OWNER_ACTOR);
      for (const route of ['attachmentContent', 'attachmentDownload'] as const) {
        expect(
          (await inject(h.app, 'GET', urlOf(route, shared.id, 'AR-2'), cookies.client!)).statusCode,
        ).toBe(404);
      }
      expect(
        (await inject(h.app, 'GET', routes.taskAttachments('AR', 'AR-2'), cookies.client!)).statusCode,
      ).toBe(404);
      expect(
        (await inject(h.app, 'DELETE', urlOf('taskAttachment', shared.id, 'AR-2'), cookies.client!))
          .statusCode,
      ).toBe(404);
      expect((await uploadFile(h.app, cookies.client!, pngBytes(), { taskKey: 'AR-2' })).statusCode).toBe(
        404,
      );
      expect(
        (await inject(h.app, 'GET', urlOf('attachmentContent', shared.id, 'AR-2'), owner)).statusCode,
      ).toBe(200);
    });

    it('stops serving a member who left the project', async () => {
      const attachment = await upload(owner);
      await h.app.projectman.domain.projects.update(
        'AR',
        { actor: OWNER_ACTOR, author: { name: 'Owner', email: 'owner@example.com' } },
        (draft) => {
          draft.team.members = draft.team.members.filter((m) => m.handle !== 'olga');
          return 'Olga leaves';
        },
      );
      const response = await inject(h.app, 'GET', urlOf('attachmentContent', attachment.id), cookies.other);
      expect(response.statusCode).toBe(403);
      expect(errorCode(response)).toBe('not_a_member');
    });
  });

  describe('request protection', () => {
    it('refuses changes from another origin, as every other change', async () => {
      const attachment = await upload(owner);
      const evil = { origin: 'http://evil.example' };
      const body = fileBody(pngBytes());
      const post = await h.app.inject({
        method: 'POST',
        url: routes.taskAttachments('AR', 'AR-1'),
        headers: { cookie: owner, ...body.headers, ...evil },
        payload: body.payload,
      });
      expect(post.statusCode).toBe(403);
      expect(errorCode(post)).toBe('invalid_origin');
      const del = await h.app.inject({
        method: 'DELETE',
        url: urlOf('taskAttachment', attachment.id),
        headers: { cookie: owner, ...evil },
      });
      expect(del.statusCode).toBe(403);
      const crossSite = await h.app.inject({
        method: 'POST',
        url: routes.taskAttachments('AR', 'AR-1'),
        headers: { cookie: owner, ...body.headers, 'sec-fetch-site': 'cross-site' },
        payload: body.payload,
      });
      expect(crossSite.statusCode).toBe(403);
      expect(storedFiles()).toEqual([attachment.id]);
    });

    it('sets no-store on the listing and the content, and has no public static route', async () => {
      const attachment = await upload(owner);
      const list = await inject(h.app, 'GET', routes.taskAttachments('AR', 'AR-1'), owner);
      expect(list.headers['cache-control']).toBe('no-store');
      for (const url of [
        `/attachments/AR/AR-1/${attachment.id}`,
        `/api/attachments/${attachment.id}`,
        `/api/projects/AR/tasks/AR-1/attachments/${attachment.id}/../${attachment.id}/content`,
      ]) {
        const response = await inject(h.app, 'GET', url, null);
        expect([401, 404], url).toContain(response.statusCode);
        expect(response.rawPayload.equals(pngBytes()), url).toBe(false);
      }
    });
  });

  it('refuses a request without a task of the project, before storing anything', async () => {
    expect((await uploadFile(h.app, owner, pngBytes(), { taskKey: 'AR-99' })).statusCode).toBe(404);
    expect((await uploadFile(h.app, owner, pngBytes(), { projectKey: 'ZZ' })).statusCode).toBe(404);
    expect(() => readdirSync(join(attachmentsDir(), 'AR', 'AR-99'))).toThrow();
    mkdirSync(join(h.home, 'unused'), { recursive: true });
  });
});
