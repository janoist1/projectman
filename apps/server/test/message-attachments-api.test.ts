import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes, TeamMessage, UploadMessageAttachmentResponse } from '@projectman/shared';
import type { MessageAttachment } from '@projectman/shared';
import { addHumanAndLogin, createAppHarness, createProject, inject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { fileBody, htmlBytes, pdfBytes, pngBytes } from './helpers/attachments';
import { flush } from './helpers/fakes';

const key = 'AR';

describe('message attachments API', () => {
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
    cookies.stranger = await addHumanAndLogin(h.app, { handle: 'sam', projectKey: null });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await h.close();
  });

  const upload = async (
    cookie: string | null,
    content: Buffer | string = pngBytes(),
    fileName = 'picture.png',
  ) => {
    const body = fileBody(content, fileName);
    return h.app.inject({
      method: 'POST',
      url: routes.messageAttachments(key),
      headers: { ...(cookie ? { cookie } : {}), ...body.headers },
      payload: body.payload,
    });
  };
  const put = async (
    cookie: string,
    content: Buffer | string = pngBytes(),
    fileName?: string,
  ): Promise<MessageAttachment> => {
    const response = await upload(cookie, content, fileName);
    expect(response.statusCode, response.body).toBe(201);
    return UploadMessageAttachmentResponse.parse(response.json()).attachment;
  };
  const send = (cookie: string, payload: object) =>
    h.app.inject({
      method: 'POST',
      url: routes.sendTeamMessage(key),
      headers: { cookie },
      payload,
    });
  const errorCode = (response: { json: () => unknown }) =>
    (response.json() as { error: { code: string } }).error.code;
  const statusOf = async (method: 'GET' | 'DELETE' | 'HEAD', url: string, cookie: string | null) =>
    (await inject(h.app, method, url, cookie)).statusCode;

  describe('upload', () => {
    it('stores the file, proves its type by its content and answers without the storage path', async () => {
      const response = await upload(cookies.developer!, pngBytes(300), 'first picture.png');
      expect(response.statusCode).toBe(201);
      const attachment = UploadMessageAttachmentResponse.parse(response.json()).attachment;
      expect(attachment).toMatchObject({
        projectKey: 'AR',
        fileName: 'first picture.png',
        size: 300,
        mediaType: 'image/png',
        preview: 'image',
        uploadedBy: { kind: 'human', handle: 'robin' },
      });
      expect(attachment.id).toMatch(/^msa_/);
      expect(JSON.stringify(response.json())).not.toContain(h.home);
    });

    it('needs a login and a membership of the project, and a multipart body', async () => {
      expect((await upload(null)).statusCode).toBe(401);
      expect((await upload(cookies.stranger!)).statusCode).toBeGreaterThanOrEqual(403);
      const plain = await h.app.inject({
        method: 'POST',
        url: routes.messageAttachments(key),
        headers: { cookie: owner },
        payload: { file: 'x' },
      });
      expect(plain.statusCode).toBe(415);
    });

    it('refuses the 21st unsent file with message_attachment_limit', async () => {
      for (let i = 0; i < 20; i++) await put(cookies.developer!, pngBytes(40 + i), `f${i}.png`);
      const response = await upload(cookies.developer!, pngBytes(200), 'one-more.png');
      expect(response.statusCode).toBe(409);
      expect(errorCode(response)).toBe('message_attachment_limit');
      expect(response.json()).toMatchObject({ error: { details: { max: 20 } } });
      // Another member has a count of their own.
      await put(cookies.other!);
    });
  });

  describe('who may open and delete', () => {
    it('lets an unsent file be seen by its uploader only, even by the owner and an admin', async () => {
      const file = await put(cookies.developer!, pdfBytes(), 'plan.pdf');
      const url = routes.messageAttachmentContent(key, file.id);
      expect(await statusOf('GET', url, cookies.developer!)).toBe(200);
      for (const cookie of [owner, cookies.admin!, cookies.other!, cookies.client!]) {
        expect(await statusOf('GET', url, cookie)).toBe(404);
        expect(await statusOf('GET', routes.messageAttachmentDownload(key, file.id), cookie)).toBe(404);
        expect(await statusOf('DELETE', routes.messageAttachment(key, file.id), cookie)).toBe(404);
      }
      // Not a member of the project at all: refused before the file is looked at.
      expect(await statusOf('GET', url, cookies.stranger!)).toBe(403);
      expect(await statusOf('GET', url, null)).toBe(401);
    });

    it('follows the message once sent: sender, recipient-side readers, the owner and an admin see it', async () => {
      const file = await put(cookies.developer!, pdfBytes(), 'plan.pdf');
      const sent = await send(cookies.developer!, {
        to: ['dev-1'],
        text: 'See the plan',
        attachmentIds: [file.id],
      });
      expect(sent.statusCode, sent.body).toBe(202);
      const message = TeamMessage.parse(sent.json());
      expect(message.attachments).toEqual([
        { id: file.id, fileName: 'plan.pdf', size: file.size, mediaType: 'application/pdf', preview: 'pdf' },
      ]);
      await flush();
      const content = routes.messageAttachmentContent(key, file.id);
      for (const cookie of [cookies.developer!, owner, cookies.admin!]) {
        expect(await statusOf('GET', content, cookie)).toBe(200);
      }
      // Not a party of the message, and a client: the file is not there for them.
      for (const cookie of [cookies.other!, cookies.client!]) {
        expect(await statusOf('GET', content, cookie)).toBe(404);
        expect(await statusOf('GET', routes.messageAttachmentDownload(key, file.id), cookie)).toBe(404);
      }
    });

    it('serves inline only what its content proved, never as active content, with the safe headers', async () => {
      const pdf = await put(cookies.developer!, pdfBytes(), 'plan.pdf');
      const html = await put(cookies.developer!, htmlBytes(), 'page.html');
      const inline = await inject(
        h.app,
        'GET',
        routes.messageAttachmentContent(key, pdf.id),
        cookies.developer!,
      );
      expect(inline.headers['content-type']).toBe('application/pdf');
      expect(inline.headers['content-disposition']).toMatch(/^inline/);
      expect(inline.headers['x-content-type-options']).toBe('nosniff');
      expect(inline.headers['content-security-policy']).toBeTruthy();
      expect(inline.headers['cache-control']).toBe('private, no-store');
      const page = await inject(
        h.app,
        'GET',
        routes.messageAttachmentContent(key, html.id),
        cookies.developer!,
      );
      expect(page.headers['content-type']).toBe('application/octet-stream');
      expect(page.headers['content-disposition']).toMatch(/^attachment/);
      const download = await inject(
        h.app,
        'GET',
        routes.messageAttachmentDownload(key, pdf.id),
        cookies.developer!,
      );
      expect(download.headers['content-disposition']).toMatch(/^attachment/);
      const head = await inject(
        h.app,
        'HEAD',
        routes.messageAttachmentContent(key, pdf.id),
        cookies.developer!,
      );
      expect(head.statusCode).toBe(200);
      expect(head.rawPayload.length).toBe(0);
    });

    it('serves a thumbnail of an image', async () => {
      const picture = await sharp({
        create: { width: 400, height: 300, channels: 3, background: '#3366cc' },
      })
        .png()
        .toBuffer();
      const file = await put(cookies.developer!, picture);
      const thumbnail = await inject(
        h.app,
        'GET',
        routes.messageAttachmentThumbnail(key, file.id),
        cookies.developer!,
      );
      expect(thumbnail.statusCode).toBe(200);
      expect(thumbnail.headers['content-type']).toBe('image/webp');
      expect(await statusOf('GET', routes.messageAttachmentThumbnail(key, file.id), cookies.other!)).toBe(
        404,
      );
    });

    it('lets the uploader or an admin delete a sent file, and refuses a visible reader: 403', async () => {
      const first = await put(cookies.developer!, pdfBytes(), 'first.pdf');
      const second = await put(cookies.developer!, pdfBytes(), 'second.pdf');
      const sent = await send(owner, { to: ['dev-1', 'robin'], text: 'For all', attachmentIds: [] });
      expect(sent.statusCode, sent.body).toBe(202);
      // The developer's files go with a message of their own.
      const mine = await send(cookies.developer!, {
        to: ['dev-1', 'olga'],
        text: 'Two files',
        attachmentIds: [first.id, second.id],
      });
      expect(mine.statusCode, mine.body).toBe(202);
      await flush();
      // olga is a recipient: she sees the file but did not upload it and is not an admin.
      expect(await statusOf('GET', routes.messageAttachmentContent(key, first.id), cookies.other!)).toBe(200);
      const refused = await inject(h.app, 'DELETE', routes.messageAttachment(key, first.id), cookies.other!);
      expect(refused.statusCode).toBe(403);
      // A member who cannot see the message learns nothing: 404.
      expect(await statusOf('DELETE', routes.messageAttachment(key, first.id), cookies.client!)).toBe(404);

      const byUploader = await inject(
        h.app,
        'DELETE',
        routes.messageAttachment(key, first.id),
        cookies.developer!,
      );
      expect(byUploader.statusCode).toBe(200);
      expect(byUploader.json()).toEqual({ id: first.id, deleted: true });
      const byAdmin = await inject(h.app, 'DELETE', routes.messageAttachment(key, second.id), cookies.admin!);
      expect(byAdmin.statusCode).toBe(200);
      for (const file of [first, second]) {
        expect(await statusOf('GET', routes.messageAttachmentContent(key, file.id), cookies.developer!)).toBe(
          404,
        );
      }
    });
  });

  describe('sending with files', () => {
    it('accepts a message of files only and a message with text, in the order given', async () => {
      const a = await put(cookies.developer!, pngBytes(80), 'a.png');
      const b = await put(cookies.developer!, pdfBytes(), 'b.pdf');
      const only = await send(cookies.developer!, {
        to: ['dev-1'],
        text: '',
        attachmentIds: [b.id, a.id],
      });
      expect(only.statusCode, only.body).toBe(202);
      const message = TeamMessage.parse(only.json());
      expect(message.attachments?.map((f) => f.id)).toEqual([b.id, a.id]);
      expect(message.body).toBe('');
    });

    it('refuses a message with neither text nor files, a repeated id and more than 10 ids', async () => {
      const file = await put(cookies.developer!, pngBytes(90));
      expect(
        (await send(cookies.developer!, { to: ['dev-1'], text: '   ', attachmentIds: [] })).statusCode,
      ).toBe(400);
      const twice = await send(cookies.developer!, {
        to: ['dev-1'],
        text: '',
        attachmentIds: [file.id, file.id],
      });
      expect(twice.statusCode).toBe(400);
      const many = Array.from({ length: 11 }, (_, i) => `msa_${String(i).padStart(10, 'a')}`);
      expect(
        (await send(cookies.developer!, { to: ['dev-1'], text: '', attachmentIds: many })).statusCode,
      ).toBe(400);
    });

    it('answers message_attachment_unavailable for a file that is unknown, someone else’s or already sent', async () => {
      const mine = await put(cookies.developer!, pngBytes(100));
      const theirs = await put(cookies.other!, pngBytes(101));
      const unknown = await send(cookies.developer!, {
        to: ['dev-1'],
        text: 'x',
        attachmentIds: ['msa_nosuchfile01'],
      });
      expect(unknown.statusCode).toBe(409);
      expect(errorCode(unknown)).toBe('message_attachment_unavailable');
      expect(unknown.json()).toMatchObject({ error: { details: { id: 'msa_nosuchfile01' } } });
      const other = await send(cookies.developer!, { to: ['dev-1'], text: 'x', attachmentIds: [theirs.id] });
      expect(other.statusCode).toBe(409);
      expect(errorCode(other)).toBe('message_attachment_unavailable');
      expect(
        (await send(cookies.developer!, { to: ['dev-1'], text: 'x', attachmentIds: [mine.id] })).statusCode,
      ).toBe(202);
      const again = await send(cookies.developer!, { to: ['dev-1'], text: 'y', attachmentIds: [mine.id] });
      expect(again.statusCode).toBe(409);
      expect(errorCode(again)).toBe('message_attachment_unavailable');
    });
  });
});
