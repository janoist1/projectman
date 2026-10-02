import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BoardView, routes, ServerEvent, TaskDetail, UploadAttachmentResponse } from '@projectman/shared';
import type { Task } from '@projectman/shared';
import { addHumanAndLogin, createAppHarness, createProject, inject, setupOwner } from './helpers/app-harness';
import type { InjectOptions } from 'fastify';
import type { AppHarness } from './helpers/app-harness';
import { OWNER_ACTOR } from './helpers/domain-harness';
import { pdfBytes, pngBytes, svgBytes, uploadFile } from './helpers/attachments';

const WIDTH = 1600;
const HEIGHT = 1000;

/** A real picture of the given format, made by sharp itself. */
async function picture(format: 'png' | 'jpeg' | 'gif' | 'webp', width = WIDTH, height = HEIGHT) {
  const base = sharp({ create: { width, height, channels: 3, background: '#3366cc' } });
  return base[format]().toBuffer();
}

describe('attachment thumbnails and the card cover', () => {
  let h: AppHarness;
  let owner: string;
  const cookies: Record<string, string> = {};

  beforeEach(async () => {
    h = await createAppHarness();
    owner = await setupOwner(h.app);
    await createProject(h, owner);
    cookies.client = await addHumanAndLogin(h.app, { handle: 'cleo', access: 'client' });
    cookies.viewer = await addHumanAndLogin(h.app, { handle: 'vic', access: 'viewer' });
    cookies.stranger = await addHumanAndLogin(h.app, { handle: 'sam', projectKey: null });
    const { tasks } = h.app.projectman.domain;
    await tasks.create('AR', { title: 'Internal task' }, OWNER_ACTOR);
    await tasks.create('AR', { title: 'Shared task', visibility: 'shared' }, OWNER_ACTOR);
  });
  afterEach(async () => h.close());

  const call = (request: { method: NonNullable<InjectOptions['method']>; url: string; cookie?: string }) =>
    inject(h.app, request.method, request.url, request.cookie);
  const upload = async (content: Buffer | string, opts: Parameters<typeof uploadFile>[3] = {}) => {
    const response = await uploadFile(h.app, owner, content, opts);
    expect(response.statusCode, response.body).toBe(201);
    return UploadAttachmentResponse.parse(response.json()).attachment;
  };
  const thumbnail = (cookie: string, id: string, taskKey = 'AR-1', method: 'GET' | 'HEAD' = 'GET') =>
    call({ method, url: routes.attachmentThumbnail('AR', taskKey, id), cookie });
  const remove = (id: string, taskKey = 'AR-1') =>
    call({ method: 'DELETE', url: routes.taskAttachment('AR', taskKey, id), cookie: owner });
  const stored = (taskKey = 'AR-1') => {
    try {
      return readdirSync(join(h.home, 'attachments', 'AR', taskKey)).sort();
    } catch {
      return [];
    }
  };
  const coverOf = async (taskKey = 'AR-1', cookie = owner): Promise<string | null | undefined> => {
    const detail = TaskDetail.parse(
      (await call({ method: 'GET', url: routes.task('AR', taskKey), cookie })).json(),
    );
    return detail.task.coverAttachmentId;
  };

  it.each(['png', 'jpeg', 'gif', 'webp'] as const)(
    'makes a small WebP preview of a %s on the first request and keeps it',
    async (format) => {
      const attachment = await upload(await picture(format), { fileName: `photo.${format}` });
      expect(stored()).toEqual([attachment.id]);

      const response = await thumbnail(owner, attachment.id);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers).toMatchObject({
        'content-type': 'image/webp',
        'x-content-type-options': 'nosniff',
        'cross-origin-resource-policy': 'same-origin',
        'cache-control': 'private, no-store',
        'content-security-policy': "default-src 'none'; sandbox",
      });
      const meta = await sharp(response.rawPayload).metadata();
      expect(meta.format).toBe('webp');
      expect(Math.max(meta.width!, meta.height!)).toBe(640);
      expect(meta.width! / meta.height!).toBeCloseTo(WIDTH / HEIGHT, 1);
      expect(Number(response.headers['content-length'])).toBe(response.rawPayload.length);
      // Kept next to the attachment, not made again.
      expect(stored()).toEqual([attachment.id, `${attachment.id}.thumb`].sort());
      const again = await thumbnail(owner, attachment.id);
      expect(again.rawPayload.equals(response.rawPayload)).toBe(true);
      expect((await thumbnail(owner, attachment.id, 'AR-1', 'HEAD')).statusCode).toBe(200);
    },
  );

  it('does not enlarge a small image, and leaves no metadata in the preview', async () => {
    const small = await sharp({ create: { width: 120, height: 80, channels: 3, background: '#cc3333' } })
      .jpeg()
      .withMetadata({ exif: { IFD0: { Copyright: 'secret-copyright' } } })
      .toBuffer();
    const attachment = await upload(small, { fileName: 'small.jpg' });
    const response = await thumbnail(owner, attachment.id);
    expect(response.statusCode).toBe(200);
    const meta = await sharp(response.rawPayload).metadata();
    expect([meta.width, meta.height]).toEqual([120, 80]);
    expect(meta.exif).toBeUndefined();
    expect(response.rawPayload.includes('secret-copyright')).toBe(false);
  });

  it('applies the EXIF orientation of a photo', async () => {
    const rotated = await sharp({ create: { width: 800, height: 400, channels: 3, background: '#33cc66' } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const attachment = await upload(rotated, { fileName: 'phone.jpg' });
    const meta = await sharp((await thumbnail(owner, attachment.id)).rawPayload).metadata();
    expect([meta.width, meta.height]).toEqual([320, 640]);
  });

  it('has no preview for a PDF, SVG or other file', async () => {
    const files = [
      await upload(pdfBytes(), { fileName: 'plan.pdf' }),
      await upload(svgBytes(), { fileName: 'logo.svg' }),
      await upload('plain text', { fileName: 'notes.txt' }),
    ];
    for (const file of files) {
      const response = await thumbnail(owner, file.id);
      expect(response.statusCode).toBe(404);
    }
    expect(stored().some((name) => name.endsWith('.thumb'))).toBe(false);
  });

  it('answers 404 for a broken image, keeps the server alive and does not decode it again', async () => {
    const broken = await upload(pngBytes(500), { fileName: 'broken.png' });
    const truncated = (await picture('jpeg')).subarray(0, 300);
    const cut = await upload(truncated, { fileName: 'cut.jpg' });
    for (const file of [broken, cut]) {
      expect((await thumbnail(owner, file.id)).statusCode).toBe(404);
      expect((await thumbnail(owner, file.id)).statusCode).toBe(404);
    }
    expect(stored().some((name) => name.includes('.thumb'))).toBe(false);
    // Still serving.
    const good = await upload(await picture('png'));
    expect((await thumbnail(owner, good.id)).statusCode).toBe(200);
  });

  it('refuses an image with too many pixels', async () => {
    // 12 000 x 12 000 = 144 MP of one colour: a small PNG that decodes to far more than the limit.
    const huge = await sharp({ create: { width: 12_000, height: 12_000, channels: 3, background: '#000' } })
      .png({ compressionLevel: 9 })
      .toBuffer();
    const attachment = await upload(huge, { fileName: 'huge.png' });
    expect((await thumbnail(owner, attachment.id)).statusCode).toBe(404);
  });

  it('shares one run between simultaneous requests', async () => {
    const attachment = await upload(await picture('png'));
    const responses = await Promise.all(Array.from({ length: 6 }, () => thumbnail(owner, attachment.id)));
    expect(responses.map((r) => r.statusCode)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(stored()).toEqual([attachment.id, `${attachment.id}.thumb`].sort());
  });

  it('is removed with the attachment', async () => {
    const attachment = await upload(await picture('png'));
    expect((await thumbnail(owner, attachment.id)).statusCode).toBe(200);
    expect((await remove(attachment.id)).statusCode).toBe(200);
    expect(stored()).toEqual([]);
    expect((await thumbnail(owner, attachment.id)).statusCode).toBe(404);
  });

  describe('who may see it', () => {
    it('hides the preview of an internal card from a client, as the content', async () => {
      const attachment = await upload(await picture('png'));
      expect((await thumbnail(owner, attachment.id)).statusCode).toBe(200);
      expect((await thumbnail(cookies.client!, attachment.id)).statusCode).toBe(404);
      expect(
        (
          await call({
            method: 'GET',
            url: routes.attachmentContent('AR', 'AR-1', attachment.id),
            cookie: cookies.client!,
          })
        ).statusCode,
      ).toBe(404);
    });

    it('shows the preview of a shared card to a client and to a viewer', async () => {
      const attachment = await upload(await picture('png'), { taskKey: 'AR-2' });
      expect((await thumbnail(cookies.client!, attachment.id, 'AR-2')).statusCode).toBe(200);
      expect((await thumbnail(cookies.viewer!, attachment.id, 'AR-2')).statusCode).toBe(200);
    });

    it('needs a login and membership, and the right task', async () => {
      const attachment = await upload(await picture('png'));
      const anonymous = await call({
        method: 'GET',
        url: routes.attachmentThumbnail('AR', 'AR-1', attachment.id),
      });
      expect(anonymous.statusCode).toBe(401);
      expect((await thumbnail(cookies.stranger!, attachment.id)).statusCode).toBeGreaterThanOrEqual(403);
      // The id of another task's attachment is not found under this task.
      expect((await thumbnail(owner, attachment.id, 'AR-2')).statusCode).toBe(404);
    });

    it('never gives a client the cover of an internal card on the board or in a pushed task', async () => {
      const events: Task[] = [];
      h.app.projectman.domain.bus.subscribe((event) => {
        if (event.type === 'task_upserted') events.push(event.task);
      });
      await upload(await picture('png'));
      const shared = await upload(await picture('png'), { taskKey: 'AR-2' });
      const board = BoardView.parse(
        (await call({ method: 'GET', url: routes.board('AR'), cookie: cookies.client! })).json(),
      );
      expect(board.tasks.map((task) => [task.key, task.coverAttachmentId])).toEqual([['AR-2', shared.id]]);
      expect(events.map((task) => task.key).sort()).toEqual(['AR-1', 'AR-2']);
    });
  });

  describe('the cover of the card', () => {
    const attach = (content: Buffer | string, fileName: string, taskKey = 'AR-1') =>
      upload(content, { fileName, taskKey });

    it('is the first image, in the board, in the details and in a pushed task', async () => {
      const pushed: Task[] = [];
      h.app.projectman.domain.bus.subscribe((event) => {
        // What the socket would carry: the event as the web parses it.
        const parsed = ServerEvent.parse(event);
        if (parsed.type === 'task_upserted') pushed.push(parsed.task);
      });
      expect(await coverOf()).toBeUndefined();
      await attach(pdfBytes(), 'plan.pdf');
      expect(await coverOf()).toBeUndefined();
      expect(pushed).toEqual([]);

      const first = await attach(await picture('png'), 'one.png');
      const second = await attach(await picture('jpeg'), 'two.jpg');
      expect(await coverOf()).toBe(first.id);
      const board = BoardView.parse(
        (await call({ method: 'GET', url: routes.board('AR'), cookie: owner })).json(),
      );
      expect(board.tasks.find((task) => task.key === 'AR-1')?.coverAttachmentId).toBe(first.id);
      expect(board.tasks.find((task) => task.key === 'AR-2')?.coverAttachmentId).toBeUndefined();
      // Only the first image changed the cover; the second one is not announced.
      expect(pushed.map((task) => [task.key, task.coverAttachmentId])).toEqual([['AR-1', first.id]]);
      expect(second.id).not.toBe(first.id);
    });

    it('moves to the next image when the cover is deleted, and is announced', async () => {
      const first = await attach(await picture('png'), 'one.png');
      const second = await attach(await picture('jpeg'), 'two.jpg');
      const pushed: Task[] = [];
      h.app.projectman.domain.bus.subscribe((event) => {
        if (event.type === 'task_upserted') pushed.push(event.task);
      });
      expect((await remove(first.id)).statusCode).toBe(200);
      expect(await coverOf()).toBe(second.id);
      expect(pushed.at(-1)).toMatchObject({ key: 'AR-1', coverAttachmentId: second.id });
      expect((await remove(second.id)).statusCode).toBe(200);
      expect(await coverOf()).toBeUndefined();
      expect(pushed.at(-1)?.coverAttachmentId).toBeUndefined();
      expect(pushed.at(-1)?.key).toBe('AR-1');
    });

    it('does not change the task’s update time', async () => {
      const before = TaskDetail.parse(
        (await call({ method: 'GET', url: routes.task('AR', 'AR-1'), cookie: owner })).json(),
      ).task.updatedAt;
      await attach(await picture('png'), 'one.png');
      const after = TaskDetail.parse(
        (await call({ method: 'GET', url: routes.task('AR', 'AR-1'), cookie: owner })).json(),
      ).task.updatedAt;
      expect(after).toBe(before);
    });
  });

  describe('recovery', () => {
    it('removes a thumbnail that belongs to no attachment, and a half written one', async () => {
      const attachment = await upload(await picture('png'));
      expect((await thumbnail(owner, attachment.id)).statusCode).toBe(200);
      const dir = join(h.home, 'attachments', 'AR', 'AR-1');
      const orphan = 'att_orphan0000000000';
      writeFileSync(join(dir, `${orphan}.thumb`), 'x');
      writeFileSync(join(dir, `${orphan}.thumb.part`), 'x');
      writeFileSync(join(dir, `${attachment.id}.thumb.part`), 'x');

      await h.app.projectman.domain.attachments.recover();

      expect(stored()).toEqual([attachment.id, `${attachment.id}.thumb`].sort());
      expect(existsSync(join(dir, `${orphan}.thumb`))).toBe(false);
    });
  });
});
