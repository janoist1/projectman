import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  ALERT_SEEN_OPTION,
  canMarkFeedback,
  canProcessFeedback,
  feedbackCardRef,
  feedbackLaunchUrl,
  feedbackMarkRefusal,
  memberOf,
  normalizeFeedbackOrigin,
  ownerHandles,
  planFeedbackAction,
} from '@projectman/shared';
import type {
  Actor,
  FeedbackForwardedAlert,
  CreateFeedbackMarkRequest,
  CreateTaskFromFeedbackRequest,
  CreateTaskFromFeedbackResponse,
  FeedbackAction,
  FeedbackCardRef,
  FeedbackInboxResponse,
  FeedbackLaunchResponse,
  FeedbackMarker,
  FeedbackMarkDetail,
  FeedbackMarkView,
  FeedbackPerson,
  FeedbackPlan,
  FeedbackSettingsView,
  FeedbackSummary,
  FeedbackSurfaceView,
  FeedbackThreadEntry,
  FeedbackWidgetListResponse,
  HumanAccess,
  MemberConfig,
  ProjectConfig,
} from '@projectman/shared';
import type {
  FeedbackEventRecord,
  FeedbackMarkRecord,
  FeedbackMarkStats,
  StoredFeedbackScreenshot,
} from '../../db';
import { isoNow } from '../../core/base';
import type { DomainContext } from '../../core/base';
import { DomainError, forbidden, invalid, notFound } from '../../kernel';
import type { InboxService } from '../../core/inbox';
import type { ProjectService } from '../../core/projects';
import type { TaskService } from '../../core/tasks';
import type { TimelineService } from '../../core/timeline';
import { KeyedMutex, newId } from '../../kernel';
import { prepareScreenshot } from './screenshots';
import type { FeedbackScreenshotStore } from './screenshots';
import type { AttachmentService } from '../../core/attachments';

/** The most marks one list returns. */
const MAX_FEEDBACK_LIST = 1000;
/** The mark text an alert quotes at most. */
const FORWARD_EXCERPT_LENGTH = 200;
/** A launch code is good for this long. */
const FEEDBACK_LAUNCH_CODE_SECONDS = 120;

const REFUSALS = {
  feedback_closed: ['the mark is closed', 409],
  feedback_not_closed: ['the mark is not closed', 409],
  feedback_task_exists: ['the mark already has a card', 409],
  feedback_waiting_owner: ['the mark waits for the owner', 409],
  feedback_processor_only: ['only a feedback processor may do this', 403],
} as const;

/** Who is asking, as the rules need them. */
interface Viewer {
  config: ProjectConfig;
  member: MemberConfig;
  handle: string;
  access: HumanAccess | 'ai';
  processor: boolean;
}

/** What the views of one request are built from. */
interface ViewContext {
  viewer: Viewer;
  colors: Map<string, number>;
  stats: Map<string, FeedbackMarkStats>;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** The most marks one widget list returns. */
const MAX_FEEDBACK_WIDGET_LIST = 500;

const encodeWidgetCursor = (updatedAt: string, id: string) =>
  Buffer.from(`${updatedAt}|${id}`).toString('base64url');

function decodeWidgetCursor(cursor: string): { updatedAt: string; id: string } {
  const [updatedAt, id, ...rest] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (updatedAt === undefined || id === undefined || rest.length > 0)
    throw invalid('invalid_request', 'not a valid cursor');
  return { updatedAt, id };
}

/**
 * The feedback marks of a project (PM-506): people mark a spot on a page of the product, the
 * project's processors decide what comes of each mark. Creating a mark and commenting are methods
 * of their own, so that the public widget API (a later card) calls the same ones as the app. Every
 * change is one unit of work: the row, the thread entry, `updated_at` and the websocket event
 * (and the card's timeline entry when a card is involved).
 *
 * The card of every view is `feedbackCardRef`, the one place that builds it.
 */
export class FeedbackService {
  private readonly ctx: DomainContext;
  private readonly projects: ProjectService;
  private readonly tasks: TaskService;
  private readonly attachments: AttachmentService;
  private readonly timeline: TimelineService;
  private readonly inbox: Pick<InboxService, 'create' | 'resolveByRule'>;
  private readonly screenshots: FeedbackScreenshotStore;
  private readonly publicBaseUrl: string | null;
  private readonly marks = new KeyedMutex();

  constructor(deps: {
    ctx: DomainContext;
    projects: ProjectService;
    tasks: TaskService;
    attachments: AttachmentService;
    timeline: TimelineService;
    inbox: Pick<InboxService, 'create' | 'resolveByRule'>;
    screenshots: FeedbackScreenshotStore;
    /** The public address of the feedback entrance, when the installation has one. */
    publicBaseUrl?: string | null;
  }) {
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.tasks = deps.tasks;
    this.attachments = deps.attachments;
    this.timeline = deps.timeline;
    this.inbox = deps.inbox;
    this.screenshots = deps.screenshots;
    this.publicBaseUrl = deps.publicBaseUrl ?? null;
  }

  // ---- reading ----

  async list(
    projectKey: string,
    actor: Actor,
    opts: { taskKey?: string } = {},
  ): Promise<FeedbackInboxResponse> {
    const viewer = await this.viewerOf(projectKey, actor);
    let taskKey = opts.taskKey;
    if (taskKey) {
      const task = this.tasks.find(projectKey, taskKey);
      if (!task) return this.emptyList(viewer);
      taskKey = task.key;
    }
    const { repos } = this.ctx;
    const records = repos.feedback.listMarks(projectKey, {
      limit: MAX_FEEDBACK_LIST,
      ...(taskKey ? { taskKey } : {}),
    });
    const view = this.viewContext(viewer, repos.feedback.stats(projectKey, viewer.handle));
    const marks = records.map((record) => this.markView(record, view));
    const authors = [...new Set(records.map((record) => record.author))];
    return {
      marks,
      surfaces: this.surfaceViews(viewer.config),
      markers: authors.flatMap((handle) => this.markerOf(viewer.config, handle, view.colors)),
      canProcess: viewer.processor,
      canMark: viewer.member.kind === 'human' && canMarkFeedback(viewer.config, viewer.member),
    };
  }

  async summary(projectKey: string, actor: Actor): Promise<FeedbackSummary> {
    const viewer = await this.viewerOf(projectKey, actor);
    const { feedback } = this.ctx.repos;
    return {
      configured: (viewer.config.project.feedback?.surfaces.length ?? 0) > 0,
      canMark: viewer.member.kind === 'human' && canMarkFeedback(viewer.config, viewer.member),
      canProcess: viewer.processor,
      // A person who processes does not owe a decision on their own marks.
      todo: viewer.processor
        ? feedback.todoCount(projectKey, viewer.member.kind === 'human' ? viewer.handle : null)
        : 0,
      unreadReplies: viewer.member.kind === 'human' ? feedback.unreadOwnCount(projectKey, viewer.handle) : 0,
    };
  }

  async detail(projectKey: string, markId: string, actor: Actor): Promise<FeedbackMarkDetail> {
    const viewer = await this.viewerOf(projectKey, actor);
    return this.detailOf(this.requireMark(projectKey, markId), viewer);
  }

  /**
   * The marks as a processor's tool lists them (PM-512): `todo` the ones that wait for a first
   * decision (oldest first), `open` also the ones that wait for the owner or a marker's answer,
   * `all` every mark (latest activity first). `total` counts all that match, `marks` at most `limit`.
   */
  async listForProcessor(
    projectKey: string,
    actor: Actor,
    opts: { status: 'todo' | 'open' | 'all'; limit: number },
  ): Promise<{ marks: FeedbackMarkView[]; total: number }> {
    const viewer = await this.viewerOf(projectKey, actor);
    if (!viewer.processor) throw this.refusal('feedback_processor_only');
    const statuses: readonly string[] =
      opts.status === 'todo' ? ['new'] : opts.status === 'open' ? ['new', 'waiting_owner', 'handled'] : [];
    const matching = this.ctx.repos.feedback
      .listMarks(projectKey, { limit: MAX_FEEDBACK_LIST })
      .filter((record) => statuses.length === 0 || statuses.includes(record.status));
    if (opts.status === 'todo') matching.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const view = this.viewContext(viewer, this.ctx.repos.feedback.stats(projectKey, viewer.handle));
    return {
      marks: matching.slice(0, opts.limit).map((record) => this.markView(record, view)),
      total: matching.length,
    };
  }

  /** One mark as a processor's tool shows it. */
  async detailForProcessor(projectKey: string, markId: string, actor: Actor): Promise<FeedbackMarkDetail> {
    const viewer = await this.viewerOf(projectKey, actor);
    if (!viewer.processor) throw this.refusal('feedback_processor_only');
    return this.detailOf(this.requireMark(projectKey, markId), viewer);
  }

  /** Where the mark's stored screenshot lies on the server's machine, or null when it has none or the file is gone. */
  async screenshotPath(projectKey: string, markId: string, actor: Actor): Promise<string | null> {
    const viewer = await this.viewerOf(projectKey, actor);
    if (!viewer.processor) throw this.refusal('feedback_processor_only');
    const record = this.requireMark(projectKey, markId);
    if (!record.screenshot) return null;
    return this.screenshots.locate(projectKey, record.screenshot).catch((err: unknown) => {
      this.ctx.logger.warn({ err, mark: markId }, 'feedback screenshot could not be located');
      return null;
    });
  }

  /** The person as the tool shows them; their marker colour is fixed here at the latest. */
  async me(projectKey: string, actor: Actor): Promise<FeedbackPerson> {
    const viewer = await this.viewerOf(projectKey, actor);
    this.ensureColor(projectKey, viewer.member);
    return this.person(viewer.config, viewer.handle, this.ctx.repos.feedback.colors(projectKey));
  }

  /**
   * The marks of one surface for the public widget: with no cursor the latest ones, then only those
   * changed since the cursor (an opaque `(updated_at, id)`), oldest change first. A change of the
   * reader's own read state does not move a mark; the widget keeps that itself.
   */
  async widgetList(
    projectKey: string,
    actor: Actor,
    opts: { surfaceId: string; cursor: string | null },
  ): Promise<FeedbackWidgetListResponse> {
    const viewer = await this.viewerOf(projectKey, actor);
    this.ensureColor(projectKey, viewer.member);
    const after = opts.cursor === null ? null : decodeWidgetCursor(opts.cursor);
    const { feedback } = this.ctx.repos;
    const records = feedback.listMarksForWidget(projectKey, opts.surfaceId, after, MAX_FEEDBACK_WIDGET_LIST);
    const view = this.viewContext(viewer, feedback.stats(projectKey, viewer.handle));
    const authors = [...new Set(records.map((record) => record.author))];
    const last = records.at(-1);
    return {
      marks: records.map((record) => this.markView(record, view)),
      markers: authors.flatMap((handle) => this.markerOf(viewer.config, handle, view.colors)),
      cursor: last
        ? encodeWidgetCursor(last.updatedAt, last.id)
        : (opts.cursor ?? encodeWidgetCursor('', '')),
      me: this.person(viewer.config, viewer.handle, view.colors),
    };
  }

  /** The person has seen the mark's thread up to now. */
  async markRead(projectKey: string, markId: string, actor: Actor): Promise<void> {
    const viewer = await this.viewerOf(projectKey, actor);
    this.requireMark(projectKey, markId);
    this.ctx.repos.feedback.markRead(projectKey, viewer.handle, markId, isoNow(this.ctx));
  }

  /** The stored screenshot (or its thumbnail), for a processor. */
  async openScreenshot(projectKey: string, markId: string, actor: Actor, thumbnail: boolean) {
    const viewer = await this.viewerOf(projectKey, actor);
    if (!viewer.processor) throw this.refusal('feedback_processor_only');
    const record = this.requireMark(projectKey, markId);
    if (!record.screenshot) throw notFound('feedback screenshot', markId);
    try {
      return await this.screenshots.open(projectKey, record.screenshot, thumbnail);
    } catch (err) {
      this.ctx.logger.error({ err, mark: markId }, 'feedback screenshot could not be opened');
      throw new DomainError('not_found', 'the screenshot file is missing', { status: 404 });
    }
  }

  // ---- marking ----

  /**
   * A person makes a mark. `surfaceId` is the surface they marked on (the app's launch and the
   * widget's session know it); the page must be on that surface's address.
   */
  async createMark(input: {
    projectKey: string;
    author: string;
    surfaceId: string;
    request: CreateFeedbackMarkRequest;
  }): Promise<FeedbackMarkDetail> {
    const { projectKey, request } = input;
    const config = await this.projects.config(projectKey);
    const member = memberOf(config, input.author);
    if (!member)
      throw forbidden('feedback_not_allowed', 'you are not a member of this project', {
        reason: 'not_human',
      });
    const refusal = feedbackMarkRefusal(config, member);
    if (refusal === 'no_surface')
      throw new DomainError('feedback_not_configured', 'this project has no feedback surface', {
        status: 409,
      });
    if (refusal) throw forbidden('feedback_not_allowed', 'you may not make marks here', { reason: refusal });
    const surface = config.project.feedback?.surfaces.find((s) => s.id === input.surfaceId);
    if (!surface) throw new DomainError('feedback_surface_not_found', 'unknown surface', { status: 404 });
    let page: URL;
    try {
      page = new URL(request.pageUrl);
    } catch {
      throw new DomainError('feedback_page_mismatch', 'the page is not a valid address', { status: 422 });
    }
    if (page.origin !== normalizeFeedbackOrigin(surface.origin))
      throw new DomainError('feedback_page_mismatch', 'the page is not on the surface', { status: 422 });

    const prepared = request.screenshot ? await prepareScreenshot(request.screenshot) : null;
    const id = newId('fbm');
    const stored = prepared ? await this.screenshots.put(projectKey, id, prepared) : null;
    const at = isoNow(this.ctx);
    try {
      this.ctx.unitOfWork(() => {
        this.ctx.repos.feedback.insertMark({
          id,
          projectKey,
          author: input.author,
          surfaceId: surface.id,
          origin: page.origin,
          pageUrl: request.pageUrl,
          pagePath: `${page.pathname}${page.search}`,
          pageTitle: request.pageTitle,
          kind: request.kind,
          body: request.body,
          anchor: request.anchor,
          environment: request.environment,
          status: 'new',
          outcome: null,
          taskKey: null,
          screenshot: stored,
          handedTo: null,
          handedAt: null,
          handedMessageId: null,
          inboxItemId: null,
          createdAt: at,
          updatedAt: at,
          closedAt: null,
        });
        this.ensureColor(projectKey, member);
        this.changed(projectKey, id);
      });
    } catch (err) {
      if (stored) await this.screenshots.remove(projectKey, stored).catch(() => undefined);
      throw err;
    }
    await this.ctx.events.emit('feedback_needs_processor', { projectKey, markId: id });
    return this.detail(projectKey, id, { kind: 'human', handle: input.author });
  }

  /** A comment in the mark's thread: the marker's, someone else's, or a processor's answer. */
  async comment(projectKey: string, markId: string, actor: Actor, body: string): Promise<FeedbackMarkDetail> {
    const viewer = await this.viewerOf(projectKey, actor);
    if (!viewer.processor) {
      // Other people comment as the marker does: a human who is not a viewer and not blocked.
      if (viewer.member.kind !== 'human') throw this.refusal('feedback_processor_only');
      if (viewer.access === 'viewer' || this.blocked(viewer))
        throw forbidden('feedback_not_allowed', 'you may not comment on marks', {
          reason: viewer.access === 'viewer' ? 'viewer' : 'blocked',
        });
    }
    const detail = await this.marks.run(markId, async () => {
      const mark = this.requireMark(projectKey, markId);
      const plan = this.plan(mark, 'comment', viewer);
      this.ctx.unitOfWork(() => {
        this.apply(mark, plan, viewer, { type: 'comment', body, data: {} });
      });
      return {
        detail: this.detailOf(this.requireMark(projectKey, markId), viewer),
        wake: plan.wakeProcessor,
      };
    });
    if (detail.wake) await this.ctx.events.emit('feedback_needs_processor', { projectKey, markId });
    return detail.detail;
  }

  // ---- deciding ----

  /** A new card from the mark, in the processor's name. */
  async createTask(
    projectKey: string,
    markId: string,
    actor: Actor,
    request: CreateTaskFromFeedbackRequest,
  ): Promise<CreateTaskFromFeedbackResponse> {
    const viewer = await this.viewerOf(projectKey, actor);
    return this.marks.run(markId, async () => {
      const mark = this.requireMark(projectKey, markId);
      const plan = this.plan(mark, 'create_task', viewer);
      const task = await this.tasks.create(
        projectKey,
        { title: request.title, description: request.description },
        actor,
      );
      if (mark.screenshot) await this.attachScreenshot(mark, mark.screenshot, task.key, actor);
      this.ctx.unitOfWork(() => {
        this.apply(mark, plan, viewer, {
          type: 'card_created',
          data: { taskKey: task.key },
          taskKey: task.key,
          reply: request.reply,
        });
        this.timeline.append({
          projectKey,
          taskKey: task.key,
          actor,
          type: 'feedback_linked',
          data: { markId, created: true },
        });
      });
      return {
        mark: await this.detailOf(this.requireMark(projectKey, markId), viewer),
        task: { key: task.key, title: task.title },
      };
    });
  }

  /** The mark belongs to a card that already exists. */
  async link(
    projectKey: string,
    markId: string,
    actor: Actor,
    request: { taskKey: string; reply?: string },
  ): Promise<FeedbackMarkDetail> {
    const viewer = await this.viewerOf(projectKey, actor);
    return this.marks.run(markId, async () => {
      const mark = this.requireMark(projectKey, markId);
      const plan = this.plan(mark, 'link', viewer);
      const task = this.tasks.find(projectKey, request.taskKey);
      if (!task)
        throw new DomainError('task_not_found', `card not found: ${request.taskKey}`, { status: 404 });
      this.ctx.unitOfWork(() => {
        this.apply(mark, plan, viewer, {
          type: 'card_linked',
          data: { taskKey: task.key },
          taskKey: task.key,
          reply: request.reply,
        });
        this.timeline.append({
          projectKey,
          taskKey: task.key,
          actor,
          type: 'feedback_linked',
          data: { markId, created: false },
        });
      });
      return this.detailOf(this.requireMark(projectKey, markId), viewer);
    });
  }

  /**
   * An AI processor passes the mark on to the owners with a `reason`: the mark waits for the owner,
   * who is told with an alert. The AI does not act on the mark again; a person's answer settles it.
   */
  async forward(
    projectKey: string,
    markId: string,
    actor: Actor,
    request: { reason: string; reply: string },
  ): Promise<FeedbackMarkDetail> {
    const viewer = await this.viewerOf(projectKey, actor);
    return this.marks.run(markId, async () => {
      const mark = this.requireMark(projectKey, markId);
      const plan = this.plan(mark, 'forward', viewer);
      const owners = ownerHandles(viewer.config);
      this.ctx.unitOfWork(() => {
        const excerpt = mark.body.replace(/\s+/g, ' ').trim().slice(0, FORWARD_EXCERPT_LENGTH);
        const payload: FeedbackForwardedAlert = {
          alert: 'feedback_forwarded',
          markId,
          author: mark.author,
          excerpt,
          reason: request.reason,
        };
        // An installation always has an owner; without one the mark still waits, and the app shows it.
        const alert =
          owners.length > 0
            ? this.inbox.create({
                projectKey,
                kind: 'alert',
                assignees: owners,
                source: 'system',
                title: `Feedback needs the owner: ${excerpt || mark.pagePath}`,
                payload,
                options: [ALERT_SEEN_OPTION],
              })
            : null;
        this.apply(mark, plan, viewer, {
          type: 'forwarded',
          body: request.reason,
          data: {},
          reply: request.reply,
          ...(alert ? { inboxItemId: alert.id } : {}),
        });
      });
      return this.detailOf(this.requireMark(projectKey, markId), viewer);
    });
  }

  async close(projectKey: string, markId: string, actor: Actor, reply?: string): Promise<FeedbackMarkDetail> {
    return this.decide(projectKey, markId, actor, 'close', { type: 'closed', reply });
  }

  async reopen(projectKey: string, markId: string, actor: Actor): Promise<FeedbackMarkDetail> {
    return this.decide(projectKey, markId, actor, 'reopen', { type: 'reopened' });
  }

  private async decide(
    projectKey: string,
    markId: string,
    actor: Actor,
    action: FeedbackAction,
    step: { type: 'closed' | 'reopened'; reply?: string },
  ): Promise<FeedbackMarkDetail> {
    const viewer = await this.viewerOf(projectKey, actor);
    return this.marks.run(markId, async () => {
      const mark = this.requireMark(projectKey, markId);
      const plan = this.plan(mark, action, viewer);
      this.ctx.unitOfWork(() => {
        this.apply(mark, plan, viewer, { type: step.type, data: {}, reply: step.reply });
      });
      return this.detailOf(this.requireMark(projectKey, markId), viewer);
    });
  }

  // ---- the launch into the product and the settings ----

  /**
   * A one-time code that starts the tool on the customer's page for this person. 32 random bytes,
   * kept only as a hash, good for two minutes and once, bound to the person, the project, the
   * surface and the address of the app that asked (`appOrigin`, the request's `Origin`).
   */
  async launch(
    projectKey: string,
    actor: Actor,
    request: { surfaceId: string; markId?: string },
    appOrigin: string,
  ): Promise<FeedbackLaunchResponse> {
    const viewer = await this.viewerOf(projectKey, actor);
    const refusal = feedbackMarkRefusal(viewer.config, viewer.member);
    if (refusal === 'no_surface')
      throw new DomainError('feedback_not_configured', 'this project has no feedback surface', {
        status: 409,
      });
    if (refusal) throw forbidden('feedback_not_allowed', 'you may not make marks here', { reason: refusal });
    const surface = viewer.config.project.feedback?.surfaces.find((s) => s.id === request.surfaceId);
    if (!surface) throw new DomainError('feedback_surface_not_found', 'unknown surface', { status: 404 });
    const origin = normalizeFeedbackOrigin(surface.origin) ?? surface.origin;
    let target = `${origin}/`;
    if (request.markId) {
      const mark = this.requireMark(projectKey, request.markId);
      // A mark made on another surface does not take the person there.
      if (mark.surfaceId === surface.id && mark.origin === origin) target = mark.pageUrl.split('#')[0]!;
    }
    const code = randomBytes(32).toString('base64url');
    const now = this.ctx.now();
    const expiresAt = new Date(now.getTime() + FEEDBACK_LAUNCH_CODE_SECONDS * 1000).toISOString();
    this.ctx.repos.feedback.insertLaunchCode(
      {
        codeHash: sha256(code),
        projectKey,
        member: viewer.handle,
        surfaceId: surface.id,
        origin,
        appOrigin,
        markId: request.markId ?? null,
        createdAt: now.toISOString(),
        expiresAt,
      },
      now,
    );
    return { url: feedbackLaunchUrl(target, code, request.markId), expiresAt };
  }

  /** The owner's and the admin's view of the surfaces and of the people who mark. */
  async settings(projectKey: string, actor: Actor): Promise<FeedbackSettingsView> {
    const viewer = await this.viewerOf(projectKey, actor);
    this.requireAdmin(viewer);
    const { feedback } = this.ctx.repos;
    const lastBySurface = feedback.lastMarkBySurface(projectKey);
    const lastByAuthor = feedback.lastMarkByAuthor(projectKey);
    const sessions = feedback.activeSessionCounts(projectKey, isoNow(this.ctx));
    const colors = feedback.colors(projectKey);
    const blocked = new Set(viewer.config.project.feedback?.blockedMarkers ?? []);
    // A person without a colour yet gets the next free one when they first mark: shown as it will be.
    let nextColor = colors.size;
    const markers = viewer.config.team.members.flatMap((member) => {
      if (member.kind !== 'human') return [];
      const color = colors.get(member.handle) ?? nextColor++ % 8;
      return [
        {
          handle: member.handle,
          name: member.displayName,
          access: member.access,
          color,
          blocked: blocked.has(member.handle),
          activeSessions: sessions.get(member.handle) ?? 0,
          lastMarkAt: lastByAuthor.get(member.handle) ?? null,
        },
      ];
    });
    return {
      publicBaseUrl: this.publicBaseUrl,
      surfaces: this.surfaceViews(viewer.config).map((surface) => ({
        ...surface,
        lastMarkAt: lastBySurface.get(surface.id) ?? null,
      })),
      markers,
    };
  }

  /** Ends all the sessions the person has with the tool on customer pages. */
  async logoutMarker(projectKey: string, actor: Actor, handle: string): Promise<void> {
    const viewer = await this.viewerOf(projectKey, actor);
    this.requireAdmin(viewer);
    const target = memberOf(viewer.config, handle);
    if (!target || target.kind !== 'human') throw notFound('member', handle);
    this.ctx.repos.feedback.revokeSessions(projectKey, handle, viewer.handle, isoNow(this.ctx));
  }

  // ---- internals ----

  private requireAdmin(viewer: Viewer): void {
    if (viewer.access !== 'owner' && viewer.access !== 'admin')
      throw forbidden('insufficient_access', 'requires admin access');
  }

  private blocked(viewer: Viewer): boolean {
    return viewer.config.project.feedback?.blockedMarkers.includes(viewer.handle) ?? false;
  }

  private refusal(code: keyof typeof REFUSALS): DomainError {
    const [message, status] = REFUSALS[code];
    return new DomainError(code, message, { status });
  }

  private async viewerOf(projectKey: string, actor: Actor): Promise<Viewer> {
    const config = await this.projects.config(projectKey);
    const member = memberOf(config, actor.handle);
    if (!member || actor.kind === 'system')
      throw forbidden('not_a_member', 'you are not a member of this project');
    return {
      config,
      member,
      handle: member.handle,
      access: member.kind === 'human' ? member.access : 'ai',
      processor: canProcessFeedback(config, member),
    };
  }

  private requireMark(projectKey: string, markId: string): FeedbackMarkRecord {
    const record = this.ctx.repos.feedback.getMark(markId);
    if (!record || record.projectKey !== projectKey)
      throw new DomainError('feedback_mark_not_found', `mark not found: ${markId}`, { status: 404 });
    return record;
  }

  private plan(mark: FeedbackMarkRecord, action: FeedbackAction, viewer: Viewer): FeedbackPlan {
    const plan = planFeedbackAction(mark, action, {
      handle: viewer.handle,
      kind: viewer.member.kind,
      processor: viewer.processor,
    });
    if ('refused' in plan) throw this.refusal(plan.refused);
    return plan;
  }

  private ensureColor(projectKey: string, member: MemberConfig): void {
    if (member.kind === 'human' && this.ctx.repos.feedback.colorOf(projectKey, member.handle) === null)
      this.ctx.repos.feedback.assignColor(projectKey, member.handle);
  }

  private changed(projectKey: string, markId: string): void {
    this.ctx.bus.publish({ type: 'feedback_changed', projectKey, markId });
  }

  /**
   * Inside a unit of work: the thread entry (and the reply, a comment of the same hand), the new
   * state, and the clean-up of what the old state held (the forwarded alert for the owner).
   */
  private apply(
    mark: FeedbackMarkRecord,
    plan: FeedbackPlan,
    viewer: Viewer,
    step: {
      type: FeedbackEventRecord['type'];
      body?: string;
      data: Record<string, unknown>;
      taskKey?: string;
      reply?: string;
      /** The owners' alert this step opened (a forward). */
      inboxItemId?: string;
    },
  ): void {
    const { feedback } = this.ctx.repos;
    const at = isoNow(this.ctx);
    const insertEvent = (
      type: FeedbackEventRecord['type'],
      body: string | null,
      data: Record<string, unknown>,
    ) =>
      feedback.insertEvent({
        id: newId('fbe'),
        markId: mark.id,
        actor: viewer.handle,
        type,
        body,
        data,
        createdAt: at,
      });
    insertEvent(step.type, step.body ?? null, step.data);
    if (step.reply) insertEvent('comment', step.reply, {});
    // The alert asked the owner to decide; whoever settles the mark answers it.
    const leavesWaiting = mark.status === 'waiting_owner' && plan.status !== 'waiting_owner';
    if (leavesWaiting && mark.inboxItemId)
      this.inbox.resolveByRule(mark.inboxItemId, ALERT_SEEN_OPTION.id, 'feedback_handled');
    feedback.updateMark(mark.id, {
      status: plan.status,
      outcome: plan.outcome,
      updatedAt: at,
      closedAt: plan.status === 'closed' ? at : null,
      ...(step.taskKey !== undefined ? { taskKey: step.taskKey } : {}),
      ...(plan.clearHanded ? { handedTo: null, handedAt: null, handedMessageId: null } : {}),
      ...(leavesWaiting ? { inboxItemId: null } : {}),
      ...(step.inboxItemId !== undefined ? { inboxItemId: step.inboxItemId } : {}),
    });
    this.ensureColor(mark.projectKey, viewer.member);
    this.changed(mark.projectKey, mark.id);
  }

  /** The screenshot goes to the card as `jeloles-<markId>.<ext>`, in the processor's name; a failure only costs the file. */
  private async attachScreenshot(
    mark: FeedbackMarkRecord,
    screenshot: StoredFeedbackScreenshot,
    taskKey: string,
    actor: Actor,
  ): Promise<void> {
    try {
      const bytes = await this.screenshots.read(mark.projectKey, screenshot);
      await this.attachments.upload({
        projectKey: mark.projectKey,
        taskKey,
        actor,
        fileName: `jeloles-${mark.id}.${screenshot.file.split('.').pop()}`,
        content: Readable.from([bytes]),
      });
    } catch (err) {
      this.ctx.logger.warn(
        { err, mark: mark.id, task: taskKey },
        'the feedback screenshot could not be attached',
      );
    }
  }

  // ---- views ----

  private viewContext(viewer: Viewer, stats: Map<string, FeedbackMarkStats>): ViewContext {
    return { viewer, colors: this.ctx.repos.feedback.colors(viewer.config.project.key), stats };
  }

  private emptyList(viewer: Viewer): FeedbackInboxResponse {
    return {
      marks: [],
      surfaces: this.surfaceViews(viewer.config),
      markers: [],
      canProcess: viewer.processor,
      canMark: viewer.member.kind === 'human' && canMarkFeedback(viewer.config, viewer.member),
    };
  }

  private surfaceViews(config: ProjectConfig): FeedbackSurfaceView[] {
    return (config.project.feedback?.surfaces ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      origin: s.origin,
    }));
  }

  private person(config: ProjectConfig, handle: string, colors: Map<string, number>): FeedbackPerson {
    const member = memberOf(config, handle);
    const kind = member?.kind ?? 'human';
    return {
      handle,
      name: member?.displayName ?? handle,
      kind,
      color: kind === 'human' ? (colors.get(handle) ?? null) : null,
    };
  }

  private markerOf(config: ProjectConfig, handle: string, colors: Map<string, number>): FeedbackMarker[] {
    const person = this.person(config, handle, colors);
    return person.kind === 'human' && person.color !== null
      ? [{ handle: person.handle, name: person.name, color: person.color }]
      : [];
  }

  private cardOf(taskKey: string | null, view: ViewContext): FeedbackCardRef | null {
    if (!taskKey) return null;
    const task = this.tasks.find(view.viewer.config.project.key, taskKey);
    if (!task) return null;
    const stage = view.viewer.config.pipeline.stages.find((s) => s.id === task.stageId);
    return feedbackCardRef(task, stage?.name ?? task.stageId);
  }

  private markView(record: FeedbackMarkRecord, view: ViewContext): FeedbackMarkView {
    const stats = view.stats.get(record.id);
    const surface = view.viewer.config.project.feedback?.surfaces.find((s) => s.id === record.surfaceId);
    return {
      id: record.id,
      projectKey: record.projectKey,
      author: this.person(view.viewer.config, record.author, view.colors),
      surface: { id: record.surfaceId, name: surface?.name ?? null, origin: record.origin },
      pageUrl: record.pageUrl,
      pagePath: record.pagePath,
      pageTitle: record.pageTitle,
      kind: record.kind,
      body: record.body,
      anchor: record.anchor,
      status: record.status,
      outcome: record.outcome,
      card: this.cardOf(record.taskKey, view),
      working: record.handedTo !== null && record.status !== 'closed',
      commentCount: stats?.commentCount ?? 0,
      unread: stats?.unread ?? false,
      hasScreenshot: record.screenshot !== null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      lastActivityAt: stats?.lastEventAt ?? record.createdAt,
      closedAt: record.closedAt,
    };
  }

  private detailOf(record: FeedbackMarkRecord, viewer: Viewer): FeedbackMarkDetail {
    const { feedback } = this.ctx.repos;
    const view = this.viewContext(viewer, feedback.stats(record.projectKey, viewer.handle, record.id));
    const thread: FeedbackThreadEntry[] = feedback.listEvents(record.id).map((event) => ({
      id: event.id,
      type: event.type,
      actor: this.person(viewer.config, event.actor, view.colors),
      // The reason of a forward is for the people who decide.
      body: event.type === 'forwarded' && !viewer.processor ? null : event.body,
      card:
        (event.type === 'card_created' || event.type === 'card_linked') &&
        typeof event.data.taskKey === 'string'
          ? this.cardOf(event.data.taskKey, view)
          : null,
      createdAt: event.createdAt,
    }));
    const human = viewer.member.kind === 'human';
    return {
      ...this.markView(record, view),
      thread,
      environment: viewer.processor ? record.environment : null,
      screenshot: viewer.processor && record.screenshot ? this.screenshotMeta(record.screenshot) : null,
      canProcess: viewer.processor,
      canComment:
        record.status !== 'closed' &&
        (viewer.processor || (human && viewer.access !== 'viewer' && !this.blocked(viewer))),
    };
  }

  private screenshotMeta(stored: StoredFeedbackScreenshot) {
    return { mediaType: stored.mediaType, size: stored.size, width: stored.width, height: stored.height };
  }
}
