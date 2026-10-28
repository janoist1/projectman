import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AttachmentListResponse, routes } from '@projectman/shared';
import type {
  CreateFeedbackMarkRequest,
  CreateTaskFromFeedbackResponse as CreatedFromMark,
  FeedbackInboxResponse as MarkInbox,
  FeedbackMarkDetail as MarkDetail,
  ServerEvent,
} from '@projectman/shared';
import { humanActor } from '../src/kernel';
import { canSeeProjectEvent } from '../src/core/projects';
import { addHumanAndLogin, createAppHarness, createProject, inject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { OWNER_ACTOR } from './helpers/domain-harness';

// The responses are plain interfaces, not schemas: `parse` only states the shape a body is read as.
const FeedbackMarkDetail = { parse: (value: unknown) => value as MarkDetail };
const FeedbackInboxResponse = { parse: (value: unknown) => value as MarkInbox };
const CreateTaskFromFeedbackResponse = { parse: (value: unknown) => value as CreatedFromMark };
const SURFACE = { id: 'shop', name: 'Shop', origin: 'https://shop.example.com' };
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

describe('feedback marks API (PM-506)', () => {
  let h: AppHarness;
  let owner: string;
  const cookies: Record<string, string> = {};
  const events: ServerEvent[] = [];

  const feedback = () => h.app.projectman.domain.feedback;
  const png = () =>
    sharp({ create: { width: 40, height: 30, channels: 3, background: '#cc3333' } })
      .png()
      .toBuffer();
  const request = async (
    opts: { screenshot?: boolean; body?: string } = {},
  ): Promise<CreateFeedbackMarkRequest> => ({
    pageUrl: 'https://shop.example.com/cart?step=2#top',
    pageTitle: 'Cart',
    kind: 'point',
    body: opts.body ?? 'The total is wrong',
    anchor: {
      kind: 'point',
      selector: null,
      textSnippet: null,
      elementOffset: null,
      pagePoint: { x: 10, y: 20 },
      rect: null,
    },
    environment: {
      viewport: { width: 1280, height: 800 },
      scroll: { x: 0, y: 0 },
      devicePixelRatio: 2,
      userAgent: 'Mozilla/5.0 (test)',
      browser: 'Chrome 140',
      os: 'macOS',
      language: 'hu-HU',
    },
    screenshot: opts.screenshot
      ? { mediaType: 'image/png', dataBase64: (await png()).toString('base64') }
      : null,
  });
  const mark = async (author: string, opts: Parameters<typeof request>[0] = {}) =>
    feedback().createMark({ projectKey: 'AR', author, surfaceId: 'shop', request: await request(opts) });
  const get = async (cookie: string, url: string) => inject(h.app, 'GET', url, cookie);
  const post = async (cookie: string, url: string, payload: unknown = {}) =>
    inject(h.app, 'POST', url, cookie, payload);
  const errorCode = (response: { json: () => unknown }) =>
    (response.json() as { error: { code: string } }).error.code;

  beforeEach(async () => {
    h = await createAppHarness();
    owner = await setupOwner(h.app);
    await createProject(h, owner);
    cookies.admin = await addHumanAndLogin(h.app, { handle: 'ada', access: 'admin' });
    cookies.developer = await addHumanAndLogin(h.app, { handle: 'robin', access: 'developer' });
    cookies.client = await addHumanAndLogin(h.app, { handle: 'cleo', access: 'client' });
    cookies.viewer = await addHumanAndLogin(h.app, { handle: 'vic', access: 'viewer' });
    cookies.stranger = await addHumanAndLogin(h.app, { handle: 'sam', projectKey: null });
    await h.app.projectman.domain.projects.update(
      'AR',
      { actor: humanActor('owner'), author: { name: 'Owner', email: 'owner@example.com' } },
      (draft) => {
        draft.project.feedback = { surfaces: [SURFACE], blockedMarkers: [] };
        return 'Set up a feedback surface';
      },
    );
    events.length = 0;
    h.app.projectman.domain.bus.subscribe((event) => events.push(event));
  });
  afterEach(async () => h.close());

  describe('launching the tool', () => {
    const launch = (cookie: string, payload: unknown, origin: string | null = 'http://localhost') =>
      h.app.inject({
        method: 'POST',
        url: routes.feedbackLaunch('AR'),
        headers: { cookie, ...(origin ? { origin } : {}) },
        payload: payload as object,
      });

    it('gives a one-time code bound to the person, kept only as a hash', async () => {
      const response = await launch(cookies.client!, { surfaceId: 'shop' });
      expect(response.statusCode, response.body).toBe(201);
      const { url, expiresAt } = response.json() as { url: string; expiresAt: string };
      expect(url.startsWith('https://shop.example.com/#pm-feedback=')).toBe(true);
      const code = decodeURIComponent(url.split('pm-feedback=')[1]!);
      expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(100_000);
      expect(Date.parse(expiresAt) - Date.now()).toBeLessThanOrEqual(120_000);

      const { feedback: repo } = h.app.projectman.repos;
      // Not stored in the clear; used once, and only before it expires.
      expect(repo.consumeLaunchCode(code, new Date().toISOString())).toBeNull();
      const used = repo.consumeLaunchCode(sha256(code), new Date().toISOString());
      expect(used).toMatchObject({
        member: 'cleo',
        projectKey: 'AR',
        surfaceId: 'shop',
        origin: 'https://shop.example.com',
        appOrigin: 'http://localhost',
      });
      expect(repo.consumeLaunchCode(sha256(code), new Date().toISOString())).toBeNull();
    });

    it('takes the person to the page of the mark', async () => {
      const made = await mark('cleo');
      const response = await launch(cookies.client!, { surfaceId: 'shop', markId: made.id });
      const { url } = response.json() as { url: string };
      // The page without its own fragment; the code goes in a new one.
      expect(url.startsWith('https://shop.example.com/cart?step=2#pm-feedback=')).toBe(true);
      expect(url).toContain(`pm-feedback-mark=${made.id}`);
    });

    it('is refused for a viewer, an unknown surface, a stranger and a request without Origin', async () => {
      const viewer = await launch(cookies.viewer!, { surfaceId: 'shop' });
      expect(viewer.statusCode).toBe(403);
      expect(errorCode(viewer)).toBe('feedback_not_allowed');
      expect(viewer.json().error.details).toEqual({ reason: 'viewer' });
      const unknown = await launch(cookies.client!, { surfaceId: 'nope' });
      expect(unknown.statusCode).toBe(404);
      expect(errorCode(unknown)).toBe('feedback_surface_not_found');
      expect((await launch(cookies.stranger!, { surfaceId: 'shop' })).statusCode).toBe(403);
      const noOrigin = await launch(cookies.client!, { surfaceId: 'shop' }, null);
      expect(noOrigin.statusCode).toBe(400);
    });
  });

  describe('marks, comments and decisions', () => {
    it('follows a mark from the marker to a card with its screenshot, and on to close and reopen', async () => {
      const made = await mark('cleo', { screenshot: true });
      expect(made).toMatchObject({
        status: 'new',
        pagePath: '/cart?step=2',
        hasScreenshot: true,
        author: { handle: 'cleo', kind: 'human' },
      });
      expect(events).toContainEqual({ type: 'feedback_changed', projectKey: 'AR', markId: made.id });

      // A non-processor may comment on their own mark, not decide.
      const comment = await post(cookies.client!, routes.feedbackComments('AR', made.id), {
        body: 'Same on mobile',
      });
      expect(comment.statusCode, comment.body).toBe(201);
      expect(FeedbackMarkDetail.parse(comment.json()).thread.map((e) => e.type)).toEqual(['comment']);
      const refused = await post(cookies.developer!, routes.feedbackTask('AR', made.id), {
        title: 'Fix the total',
        description: '',
      });
      expect(refused.statusCode).toBe(403);
      expect(errorCode(refused)).toBe('feedback_processor_only');

      // The processor makes a card: shared, as the marker is a client; the screenshot is attached in their name.
      const created = await post(cookies.admin!, routes.feedbackTask('AR', made.id), {
        title: 'Fix the total',
        description: 'The cart total ignores the discount',
        reply: 'We are on it',
      });
      expect(created.statusCode, created.body).toBe(201);
      const body = CreateTaskFromFeedbackResponse.parse(created.json());
      expect(body.task.title).toBe('Fix the total');
      expect(body.mark).toMatchObject({
        status: 'handled',
        outcome: 'card_created',
        card: { visible: true, key: body.task.key },
      });
      expect(body.mark.thread.map((e) => e.type)).toEqual(['comment', 'card_created', 'comment']);

      const { tasks, attachments } = h.app.projectman.domain;
      const task = tasks.find('AR', body.task.key)!;
      expect(task).not.toHaveProperty('visibility');
      expect(task.parentKey ?? null).toBeNull();
      const attached = await attachments.list('AR', task.key, humanActor('ada'));
      expect(attached).toHaveLength(1);
      expect(attached[0]).toMatchObject({
        fileName: `jeloles-${made.id}.png`,
        mediaType: 'image/png',
        uploadedBy: { kind: 'human', handle: 'ada' },
      });
      expect(h.app.projectman.repos.timeline.latestOfType('AR', task.key, 'feedback_linked')?.data).toEqual({
        markId: made.id,
        created: true,
      });
      const listed = AttachmentListResponse.parse(
        (await get(owner, routes.taskAttachments('AR', task.key))).json(),
      );
      expect(listed.attachments).toHaveLength(1);

      // A second card for the same mark is refused.
      const again = await post(cookies.admin!, routes.feedbackTask('AR', made.id), {
        title: 'Again',
        description: '',
      });
      expect(again.statusCode).toBe(409);
      expect(errorCode(again)).toBe('feedback_task_exists');

      const closed = await post(cookies.admin!, routes.feedbackClose('AR', made.id), { reply: 'Done' });
      expect(closed.statusCode, closed.body).toBe(200);
      expect(FeedbackMarkDetail.parse(closed.json())).toMatchObject({ status: 'closed', canComment: false });
      const late = await post(cookies.client!, routes.feedbackComments('AR', made.id), { body: 'One more' });
      expect(late.statusCode).toBe(409);
      expect(errorCode(late)).toBe('feedback_closed');
      const closeTwice = await post(cookies.admin!, routes.feedbackClose('AR', made.id), {});
      expect(errorCode(closeTwice)).toBe('feedback_closed');

      const reopened = await post(cookies.admin!, routes.feedbackReopen('AR', made.id));
      expect(reopened.statusCode, reopened.body).toBe(200);
      expect(FeedbackMarkDetail.parse(reopened.json()).status).toBe('handled');
      const reopenAgain = await post(cookies.admin!, routes.feedbackReopen('AR', made.id));
      expect(errorCode(reopenAgain)).toBe('feedback_not_closed');
    });

    it('stores the screenshot privately and serves it to processors only', async () => {
      const made = await mark('robin', { screenshot: true });
      const dir = join(h.home, 'feedback', 'AR');
      const files = readdirSync(dir).sort();
      expect(files).toEqual([`${made.id}.png`, `${made.id}.thumb`]);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(join(dir, files[0]!)).mode & 0o777).toBe(0o600);

      const original = await get(owner, routes.feedbackScreenshot('AR', made.id));
      expect(original.statusCode).toBe(200);
      expect(original.headers['content-type']).toBe('image/png');
      expect(original.headers['x-content-type-options']).toBe('nosniff');
      expect(original.headers['content-security-policy']).toBe(
        "default-src 'none'; sandbox; frame-ancestors 'none'",
      );
      expect(original.headers['cross-origin-resource-policy']).toBe('same-origin');
      const thumb = await get(owner, `${routes.feedbackScreenshot('AR', made.id)}?thumb=1`);
      expect(thumb.headers['content-type']).toBe('image/webp');

      const denied = await get(cookies.developer!, routes.feedbackScreenshot('AR', made.id));
      expect(denied.statusCode).toBe(403);
      expect(errorCode(denied)).toBe('feedback_processor_only');
      // The environment and the screenshot's details are for processors too.
      const own = FeedbackMarkDetail.parse(
        (await get(cookies.developer!, routes.feedbackMark('AR', made.id))).json(),
      );
      expect(own.environment).toBeNull();
      expect(own.screenshot).toBeNull();
      const seen = FeedbackMarkDetail.parse((await get(owner, routes.feedbackMark('AR', made.id))).json());
      expect(seen.environment).toMatchObject({ browser: 'Chrome 140' });
      expect(seen.screenshot).toMatchObject({ mediaType: 'image/png', width: 40, height: 30 });
    });

    it('refuses a screenshot that is not the image it claims to be, and a page off the surface', async () => {
      const fake = await request();
      fake.screenshot = {
        mediaType: 'image/png',
        dataBase64: Buffer.from('<html>not an image</html>').toString('base64'),
      };
      await expect(
        feedback().createMark({ projectKey: 'AR', author: 'robin', surfaceId: 'shop', request: fake }),
      ).rejects.toMatchObject({ code: 'feedback_screenshot_invalid', status: 422 });
      const elsewhere = { ...(await request()), pageUrl: 'https://evil.example.com/' };
      await expect(
        feedback().createMark({ projectKey: 'AR', author: 'robin', surfaceId: 'shop', request: elsewhere }),
      ).rejects.toMatchObject({ code: 'feedback_page_mismatch' });
      await expect(
        feedback().createMark({
          projectKey: 'AR',
          author: 'vic',
          surfaceId: 'shop',
          request: await request(),
        }),
      ).rejects.toMatchObject({ code: 'feedback_not_allowed', details: { reason: 'viewer' } });
      expect(existsSync(join(h.home, 'feedback', 'AR'))).toBe(false);
    });

    it('links a mark to an existing card and refuses an unknown one', async () => {
      const { tasks } = h.app.projectman.domain;
      const existing = await tasks.create('AR', { title: 'Cart rework' }, OWNER_ACTOR);
      const made = await mark('robin');
      const unknown = await post(owner, routes.feedbackLink('AR', made.id), { taskKey: 'AR-999' });
      expect(unknown.statusCode).toBe(404);
      expect(errorCode(unknown)).toBe('task_not_found');
      const linked = await post(owner, routes.feedbackLink('AR', made.id), {
        taskKey: existing.key,
        reply: 'Known',
      });
      expect(linked.statusCode, linked.body).toBe(200);
      expect(FeedbackMarkDetail.parse(linked.json())).toMatchObject({
        status: 'handled',
        outcome: 'card_linked',
        card: { visible: true, key: existing.key },
      });
      expect(
        h.app.projectman.repos.timeline.latestOfType('AR', existing.key, 'feedback_linked')?.data,
      ).toEqual({
        markId: made.id,
        created: false,
      });
    });
  });

  describe('who sees what', () => {
    it('shows a client the key and the title of the card of a mark, including its details (PM-79)', async () => {
      const made = await mark('robin');
      const created = await post(owner, routes.feedbackTask('AR', made.id), {
        title: 'Secret refactor',
        description: '',
      });
      const { task } = CreateTaskFromFeedbackResponse.parse(created.json());
      expect(h.app.projectman.domain.tasks.find('AR', task.key)).not.toHaveProperty('visibility');

      const listed = await get(cookies.client!, routes.feedback('AR'));
      expect(listed.statusCode).toBe(200);
      const inbox = FeedbackInboxResponse.parse(listed.json());
      expect(inbox.marks.find((m) => m.id === made.id)?.card).toMatchObject({
        visible: true,
        key: task.key,
        title: 'Secret refactor',
      });
      const detail = await get(cookies.client!, routes.feedbackMark('AR', made.id));
      expect(
        FeedbackMarkDetail.parse(detail.json()).thread.find((e) => e.type === 'card_created')?.card,
      ).toMatchObject({ visible: true, key: task.key });
      // Asking by card works for a client as for a developer.
      for (const who of [cookies.client!, cookies.developer!]) {
        const byCard = await get(who, `${routes.feedback('AR')}?task=${task.key}`);
        expect(FeedbackInboxResponse.parse(byCard.json()).marks.map((m) => m.id)).toEqual([made.id]);
      }

      // The live events reach the client too; the event names only the mark.
      const client = { handle: 'cleo', access: 'client' } as const;
      const changed = events.filter((e) => e.type === 'feedback_changed');
      expect(changed.length).toBeGreaterThan(0);
      for (const event of changed) {
        expect(canSeeProjectEvent(client, event)).toBe(true);
        expect(JSON.stringify(event)).not.toContain(task.key);
      }
      const timelineEvent = events.find((e) => e.type === 'timeline_appended');
      if (timelineEvent) expect(canSeeProjectEvent(client, timelineEvent)).toBe(true);
    });

    it('keeps the forwarding reason and the unread count to the people they concern', async () => {
      const made = await mark('cleo');
      // Unread: a processor's reply to the client's mark is unread until they read it.
      await post(owner, routes.feedbackComments('AR', made.id), { body: 'Looking' });
      const before = (await get(cookies.client!, routes.feedbackSummary('AR'))).json() as {
        unreadReplies: number;
        canMark: boolean;
        canProcess: boolean;
      };
      expect(before).toMatchObject({ unreadReplies: 1, canMark: true, canProcess: false });
      expect((await post(cookies.client!, routes.feedbackRead('AR', made.id))).statusCode).toBe(204);
      const after = (await get(cookies.client!, routes.feedbackSummary('AR'))).json() as {
        unreadReplies: number;
      };
      expect(after.unreadReplies).toBe(0);
      const staff = (await get(cookies.admin!, routes.feedbackSummary('AR'))).json() as { todo: number };
      expect(staff.todo).toBe(0);
    });

    it('keeps outsiders and viewers who cannot comment out', async () => {
      const made = await mark('robin');
      expect((await get(cookies.stranger!, routes.feedback('AR'))).statusCode).toBe(403);
      expect((await get(cookies.viewer!, routes.feedback('AR'))).statusCode).toBe(200);
      const comment = await post(cookies.viewer!, routes.feedbackComments('AR', made.id), { body: 'Hi' });
      expect(comment.statusCode).toBe(403);
      expect((await get(owner, routes.feedbackMark('AR', 'fbm_0000000000'))).statusCode).toBe(404);
      expect(errorCode(await get(owner, routes.feedbackMark('AR', 'nonsense')))).toBe(
        'feedback_mark_not_found',
      );
    });
  });

  describe('settings and signing the tool out', () => {
    it('shows the surfaces and the markers to an owner or admin, and ends a marker’s sessions', async () => {
      await mark('cleo');
      expect((await get(cookies.developer!, routes.feedbackSettings('AR'))).statusCode).toBe(403);
      const response = await get(cookies.admin!, routes.feedbackSettings('AR'));
      expect(response.statusCode, response.body).toBe(200);
      const view = response.json() as {
        publicBaseUrl: string | null;
        surfaces: { id: string; lastMarkAt: string | null }[];
        markers: { handle: string; color: number; activeSessions: number; lastMarkAt: string | null }[];
      };
      expect(view.publicBaseUrl).toBeNull();
      expect(view.surfaces).toEqual([
        expect.objectContaining({ id: 'shop', lastMarkAt: expect.any(String) }),
      ]);
      const cleo = view.markers.find((m) => m.handle === 'cleo');
      expect(cleo).toMatchObject({ activeSessions: 0, lastMarkAt: expect.any(String) });

      const { feedback: repo } = h.app.projectman.repos;
      const now = new Date().toISOString();
      repo.insertSession({
        id: 'fbs_test',
        tokenHash: sha256('session-token'),
        projectKey: 'AR',
        member: 'cleo',
        surfaceId: 'shop',
        origin: 'https://shop.example.com',
        appOrigin: 'http://localhost',
        userAgent: null,
        createdAt: now,
        lastUsedAt: now,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
      const withSession = (await get(cookies.admin!, routes.feedbackSettings('AR'))).json() as typeof view;
      expect(withSession.markers.find((m) => m.handle === 'cleo')?.activeSessions).toBe(1);

      expect((await post(cookies.developer!, routes.feedbackMarkerLogout('AR', 'cleo'))).statusCode).toBe(
        403,
      );
      const logout = await post(cookies.admin!, routes.feedbackMarkerLogout('AR', 'cleo'));
      expect(logout.statusCode).toBe(204);
      expect(repo.sessionByTokenHash(sha256('session-token'))?.revokedBy).toBe('ada');
      const ended = (await get(cookies.admin!, routes.feedbackSettings('AR'))).json() as typeof view;
      expect(ended.markers.find((m) => m.handle === 'cleo')?.activeSessions).toBe(0);
      expect((await post(cookies.admin!, routes.feedbackMarkerLogout('AR', 'nobody'))).statusCode).toBe(404);
    });
  });
});
