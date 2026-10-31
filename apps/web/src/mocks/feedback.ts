import {
  canDeleteFeedback,
  canMarkFeedback,
  canProcessFeedback,
  CloseFeedbackRequest,
  CreateTaskFromFeedbackRequest,
  FeedbackCommentRequest,
  FeedbackLaunchRequest,
  feedbackCardRef,
  feedbackLaunchUrl,
  feedbackMarkRefusal,
  LinkFeedbackRequest,
  memberOf,
  normalizeFeedbackOrigin,
  planFeedbackAction,
} from '@projectman/shared';
import type {
  CreateTaskFromFeedbackResponse,
  ErrorCode,
  FeedbackAction,
  FeedbackAnchor,
  FeedbackCardRef,
  FeedbackEnvironment,
  FeedbackEventType,
  FeedbackInboxResponse,
  FeedbackMarkDetail,
  FeedbackMarkKind,
  FeedbackMarkView,
  FeedbackOutcome,
  FeedbackPerson,
  FeedbackPlan,
  FeedbackSettingsView,
  FeedbackStatus,
  FeedbackSummary,
  FeedbackThreadEntry,
  HumanAccess,
  MemberConfig,
  ProjectConfig,
  ServerEvent,
  Task,
  TimelineEventType,
} from '@projectman/shared';
import { mockId, nowIso } from './time';

interface MockResponse {
  status: number;
  body?: unknown;
}

/** What the fake feedback needs from the backend that hosts it; read when used, a test may swap them. */
export interface MockFeedbackHost {
  config(): ProjectConfig;
  viewerHandle(): string;
  findTask(key: string): Task | undefined;
  /** Creates a card in the viewer's name (the backend's own task creation); its answer holds the task. */
  createCard(input: { title: string; description: string }): MockResponse;
  addTimeline(taskKey: string, who: string, type: TimelineEventType, data: Record<string, unknown>): void;
  emit(event: ServerEvent): void;
}

interface MockFeedbackEvent {
  id: string;
  type: FeedbackEventType;
  actor: string;
  body: string | null;
  taskKey: string | null;
  createdAt: string;
}

/** A mark as the fake keeps it: the stored row, with its thread and who has not read it yet. */
export interface MockFeedbackMark {
  id: string;
  author: string;
  surfaceId: string;
  origin: string;
  pageUrl: string;
  pagePath: string;
  pageTitle: string;
  kind: FeedbackMarkKind;
  body: string;
  anchor: FeedbackAnchor;
  environment: FeedbackEnvironment;
  status: FeedbackStatus;
  outcome: FeedbackOutcome | null;
  taskKey: string | null;
  /** A processor AI was woken for it and has not acted yet. */
  working: boolean;
  hasScreenshot: boolean;
  events: MockFeedbackEvent[];
  unreadBy: Set<string>;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export type MockFeedbackSeed = Partial<
  Omit<MockFeedbackMark, 'events' | 'unreadBy' | 'anchor' | 'environment'>
> & {
  author: string;
  body: string;
  anchor?: FeedbackAnchor;
  /** Minutes ago the mark was made. */
  ageMinutes?: number;
  events?: Array<{
    type: FeedbackEventType;
    actor: string;
    body?: string | null;
    taskKey?: string | null;
    ageMinutes: number;
  }>;
  unreadBy?: string[];
};

const error = (status: number, code: ErrorCode, message: string, details?: unknown): MockResponse => ({
  status,
  body: { error: { code, message, ...(details === undefined ? {} : { details }) } },
});
const ok = (body?: unknown): MockResponse => (body === undefined ? { status: 204 } : { status: 200, body });

const REFUSALS: Record<string, [ErrorCode, string, number]> = {
  feedback_closed: ['feedback_closed', 'the mark is closed', 409],
  feedback_not_closed: ['feedback_not_closed', 'the mark is not closed', 409],
  feedback_task_exists: ['feedback_task_exists', 'the mark already has a card', 409],
  feedback_waiting_owner: ['feedback_waiting_owner', 'the mark waits for the owner', 409],
  feedback_processor_only: ['feedback_processor_only', 'only a feedback processor may do this', 403],
};

const DEFAULT_ENVIRONMENT: FeedbackEnvironment = {
  viewport: { width: 1440, height: 900 },
  scroll: { x: 0, y: 320 },
  devicePixelRatio: 2,
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.2 Safari/605.1.15',
  browser: 'Safari 18',
  os: 'macOS 15',
  language: 'hu-HU',
};

const POINT_ANCHOR: FeedbackAnchor = {
  kind: 'point',
  selector: null,
  textSnippet: null,
  elementOffset: null,
  pagePoint: { x: 640, y: 480 },
  rect: null,
};

/**
 * The fake of the feedback marks (PM-511): the twelve routes of `apps/server/src/api/feedback.ts`, built on
 * the same shared rules (`planFeedbackAction`, `feedbackCardRef`, `canProcessFeedback`), so the UI runs
 * against the contract the server keeps. A project starts without surfaces and marks; a test or a
 * scenario fills it (`seedSample`, `addMark`).
 */
export class MockFeedback {
  marks: MockFeedbackMark[] = [];
  /** The address of the feedback entrance the installation shows in the settings; null: none. */
  publicBaseUrl: string | null = null;
  /** Open sessions with the tool on customer pages, by member (the settings show and end them). */
  activeSessions = new Map<string, number>();
  /** Marker colours by member, in the order people first marked (the server keeps them per project). */
  private colors = new Map<string, number>();

  private readonly host: MockFeedbackHost;

  constructor(host: MockFeedbackHost) {
    this.host = host;
  }

  /* ---------- seeding ---------- */

  /** A surface the tool may run on; the first call turns the project's feedback on. */
  addSurface(surface: { id: string; name: string; origin: string }): void {
    const config = this.host.config();
    const current = config.project.feedback ?? { surfaces: [], blockedMarkers: [] };
    config.project.feedback = { ...current, surfaces: [...current.surfaces, surface] };
  }

  addMark(seed: MockFeedbackSeed): MockFeedbackMark {
    const config = this.host.config();
    const surface = config.project.feedback?.surfaces[0];
    const at = nowIso();
    const createdAt = seed.ageMinutes === undefined ? at : agoIso(seed.ageMinutes);
    const pagePath = seed.pagePath ?? '/kosar';
    const origin = seed.origin ?? surface?.origin ?? 'https://acme.test';
    const mark: MockFeedbackMark = {
      id: seed.id ?? mockId('fbm'),
      author: seed.author,
      surfaceId: seed.surfaceId ?? surface?.id ?? 'a1b2c3d4',
      origin,
      pageUrl: seed.pageUrl ?? `${origin}${pagePath}`,
      pagePath,
      pageTitle: seed.pageTitle ?? 'Kosár – Acme webshop',
      kind: seed.kind ?? seed.anchor?.kind ?? 'point',
      body: seed.body,
      anchor: seed.anchor ?? POINT_ANCHOR,
      environment: DEFAULT_ENVIRONMENT,
      status: seed.status ?? 'new',
      outcome: seed.outcome ?? null,
      taskKey: seed.taskKey ?? null,
      working: seed.working ?? false,
      hasScreenshot: seed.hasScreenshot ?? false,
      events: (seed.events ?? []).map((event) => ({
        id: mockId('fbe'),
        type: event.type,
        actor: event.actor,
        body: event.body ?? null,
        taskKey: event.taskKey ?? null,
        createdAt: agoIso(event.ageMinutes),
      })),
      unreadBy: new Set(seed.unreadBy ?? []),
      createdAt,
      updatedAt: seed.updatedAt ?? (seed.events?.length ? agoIso(seed.events.at(-1)!.ageMinutes) : createdAt),
      closedAt: seed.closedAt ?? null,
    };
    this.ensureColor(seed.author);
    this.marks.push(mark);
    return mark;
  }

  /**
   * A believable project: one surface, a handful of marks in every state the page shows. The viewer is
   * the owner (a processor) in the first place; the clients Kata and Bence marked, `pm` is the processor AI.
   */
  seedSample(): void {
    this.publicBaseUrl = 'https://projectman.acme.test';
    this.addSurface({ id: 'a1b2c3d4', name: 'Webshop', origin: 'https://acme.test' });
    this.activeSessions.set('kata', 2);
    this.activeSessions.set('owner', 1);
    this.addMark({
      author: 'kata',
      body: 'A kupon mező kitakarja a „Megrendelem” gombot, ha a billentyűzet fel van jönve.',
      pagePath: '/penztar',
      pageTitle: 'Pénztár – Acme webshop',
      ageMinutes: 22,
      hasScreenshot: true,
      unreadBy: ['owner', 'pm'],
    });
    this.addMark({
      author: 'bence',
      body: 'Az üres kosár szövegében elírás van: „kosarad ures”.',
      pagePath: '/kosar',
      kind: 'element',
      anchor: {
        kind: 'element',
        selector: 'main .empty-cart > p',
        textSnippet: 'kosarad ures',
        elementOffset: { x: 0.4, y: 0.5 },
        pagePoint: { x: 520, y: 360 },
        rect: null,
      },
      working: true,
      ageMinutes: 95,
      unreadBy: ['owner'],
    });
    this.addMark({
      author: 'kata',
      body: 'Az összehasonlító táblázat mobilon szétesik. Lehetne belőle kártyás nézet?',
      pagePath: '/osszehasonlitas',
      pageTitle: 'Összehasonlítás – Acme webshop',
      kind: 'area',
      anchor: {
        kind: 'area',
        selector: null,
        textSnippet: null,
        elementOffset: null,
        pagePoint: null,
        rect: { x: 120, y: 340, width: 560, height: 210 },
      },
      status: 'waiting_owner',
      ageMinutes: 60 * 26,
      events: [
        {
          type: 'comment',
          actor: 'pm',
          body: 'Köszönöm! Ez új nézet lenne, nem hiba – a tulajdonos dönti el, belefér-e.',
          ageMinutes: 60 * 25,
        },
        {
          type: 'forwarded',
          actor: 'pm',
          body: 'Új felületi elem, ami az ütemezést érinti; árat és határidőt nem ígérhetek rá.',
          ageMinutes: 60 * 25,
        },
      ],
      unreadBy: ['owner'],
    });
    this.addMark({
      author: 'bence',
      body: 'A termékoldalon a méretválasztó nem mutatja, melyik méret fogyott el.',
      pagePath: '/termek/futocipo',
      pageTitle: 'Futócipő – Acme webshop',
      status: 'handled',
      outcome: 'card_created',
      taskKey: 'AC-21',
      ageMinutes: 60 * 50,
      events: [
        {
          type: 'card_created',
          actor: 'pm',
          taskKey: 'AC-21',
          ageMinutes: 60 * 48,
        },
        {
          type: 'comment',
          actor: 'pm',
          body: 'Felvettem feladatként, a csapat hamarosan foglalkozik vele.',
          ageMinutes: 60 * 48,
        },
      ],
      unreadBy: ['bence'],
    });
    this.addMark({
      author: 'kata',
      body: 'A főoldali banner képe elmosódott a nagy kijelzőn.',
      pagePath: '/',
      pageTitle: 'Acme webshop',
      status: 'handled',
      outcome: 'card_created',
      taskKey: 'AC-24',
      ageMinutes: 60 * 24 * 3,
      events: [
        { type: 'card_created', actor: 'pm', taskKey: 'AC-24', ageMinutes: 60 * 24 * 3 - 30 },
        {
          type: 'comment',
          actor: 'pm',
          body: 'Továbbítottam a csapatnak.',
          ageMinutes: 60 * 24 * 3 - 30,
        },
      ],
    });
    this.addMark({
      author: 'bence',
      body: 'Meddig érvényes a szállítási ár a kosárban?',
      pagePath: '/kosar',
      status: 'handled',
      outcome: 'answered',
      ageMinutes: 60 * 24 * 5,
      events: [
        {
          type: 'comment',
          actor: 'pm',
          body: 'A szállítási díj a megrendelés leadásáig érvényes; a végösszeg a pénztárban jelenik meg.',
          ageMinutes: 60 * 24 * 5 - 20,
        },
      ],
    });
    this.addMark({
      author: 'kata',
      body: 'A „Vissza a bolthoz” gomb a rendelés után egy 404-es oldalra visz.',
      pagePath: '/koszonjuk',
      pageTitle: 'Köszönjük – Acme webshop',
      status: 'closed',
      outcome: 'answered',
      ageMinutes: 60 * 24 * 9,
      closedAt: agoIso(60 * 24 * 8),
      events: [
        { type: 'comment', actor: 'pm', body: 'Javítottuk, köszönjük a jelzést.', ageMinutes: 60 * 24 * 8 },
        { type: 'closed', actor: 'pm', ageMinutes: 60 * 24 * 8 },
      ],
    });
  }

  /* ---------- views ---------- */

  private viewer() {
    const config = this.host.config();
    const member = memberOf(config, this.host.viewerHandle());
    if (!member) return null;
    return {
      config,
      member,
      handle: member.handle,
      access: (member.kind === 'human' ? member.access : 'ai') as HumanAccess | 'ai',
      processor: canProcessFeedback(config, member),
    };
  }

  private ensureColor(handle: string): void {
    const member = memberOf(this.host.config(), handle);
    if (member?.kind === 'human' && !this.colors.has(handle)) this.colors.set(handle, this.colors.size % 8);
  }

  private person(handle: string): FeedbackPerson {
    const member = memberOf(this.host.config(), handle);
    const kind = member?.kind ?? 'human';
    return {
      handle,
      name: member?.displayName ?? handle,
      kind,
      color: kind === 'human' ? (this.colors.get(handle) ?? null) : null,
    };
  }

  private cardOf(taskKey: string | null): FeedbackCardRef | null {
    if (!taskKey) return null;
    const task = this.host.findTask(taskKey);
    if (!task) return null;
    const stage = this.host.config().pipeline.stages.find((s) => s.id === task.stageId);
    return feedbackCardRef(task, stage?.name ?? task.stageId);
  }

  private view(
    mark: MockFeedbackMark,
    viewer: NonNullable<ReturnType<MockFeedback['viewer']>>,
  ): FeedbackMarkView {
    const surface = viewer.config.project.feedback?.surfaces.find((s) => s.id === mark.surfaceId);
    const comments = mark.events.filter((event) => event.type === 'comment').length;
    return {
      id: mark.id,
      projectKey: viewer.config.project.key,
      author: this.person(mark.author),
      surface: { id: mark.surfaceId, name: surface?.name ?? null, origin: mark.origin },
      pageUrl: mark.pageUrl,
      pagePath: mark.pagePath,
      pageTitle: mark.pageTitle,
      kind: mark.kind,
      body: mark.body,
      anchor: mark.anchor,
      status: mark.status,
      outcome: mark.outcome,
      card: this.cardOf(mark.taskKey),
      working: mark.working && mark.status !== 'closed',
      commentCount: comments,
      unread: mark.unreadBy.has(viewer.handle),
      hasScreenshot: mark.hasScreenshot,
      canDelete: canDeleteFeedback(viewer.member, mark),
      createdAt: mark.createdAt,
      updatedAt: mark.updatedAt,
      lastActivityAt: mark.events.at(-1)?.createdAt ?? mark.createdAt,
      closedAt: mark.closedAt,
    };
  }

  private detail(mark: MockFeedbackMark, viewer: NonNullable<ReturnType<MockFeedback['viewer']>>) {
    const thread: FeedbackThreadEntry[] = mark.events.map((event) => ({
      id: event.id,
      type: event.type,
      actor: this.person(event.actor),
      body: event.type === 'forwarded' && !viewer.processor ? null : event.body,
      card:
        (event.type === 'card_created' || event.type === 'card_linked') && event.taskKey
          ? this.cardOf(event.taskKey)
          : null,
      createdAt: event.createdAt,
    }));
    const blocked = viewer.config.project.feedback?.blockedMarkers.includes(viewer.handle) ?? false;
    const detail: FeedbackMarkDetail = {
      ...this.view(mark, viewer),
      thread,
      environment: viewer.processor ? mark.environment : null,
      screenshot:
        viewer.processor && mark.hasScreenshot
          ? { mediaType: 'image/png', size: 184_220, width: 1440, height: 900 }
          : null,
      canProcess: viewer.processor,
      canComment:
        mark.status !== 'closed' &&
        (viewer.processor || (viewer.member.kind === 'human' && viewer.access !== 'viewer' && !blocked)),
    };
    return detail;
  }

  /* ---------- the routes ---------- */

  /** `rest` is the path below `/feedback`; null: not a feedback route. */
  handle(method: string, rest: string, body: unknown, query: URLSearchParams): MockResponse | null {
    const viewer = this.viewer();
    if (!viewer) return error(403, 'not_a_member', 'Not a member');
    if (rest === '' && method === 'GET') return this.list(viewer, query.get('task'));
    if (rest === '/summary' && method === 'GET') return ok(this.summary(viewer));
    if (rest === '/settings' && method === 'GET') {
      if (viewer.access !== 'owner' && viewer.access !== 'admin')
        return error(403, 'insufficient_access', 'requires admin access');
      return ok(this.settings(viewer));
    }
    if (rest === '/launch' && method === 'POST') return this.launch(viewer, body);
    const logout = /^\/markers\/([\w-]+)\/logout$/.exec(rest);
    if (logout && method === 'POST') {
      if (viewer.access !== 'owner' && viewer.access !== 'admin')
        return error(403, 'insufficient_access', 'requires admin access');
      this.activeSessions.delete(logout[1]!);
      return ok();
    }
    const match = /^\/(fbm_[a-z0-9]+)(?:\/([a-z]+))?$/.exec(rest);
    if (!match) return null;
    const mark = this.marks.find((entry) => entry.id === match[1]);
    if (!mark) return error(404, 'feedback_mark_not_found', `mark not found: ${match[1]}`);
    const action = match[2];
    if (!action && method === 'GET') return ok(this.detail(mark, viewer));
    if (!action && method === 'DELETE') return this.remove(mark, viewer);
    if (method !== 'POST') return null;
    switch (action) {
      case 'read':
        mark.unreadBy.delete(viewer.handle);
        return ok();
      case 'comments':
        return this.comment(mark, viewer, body);
      case 'task':
        return this.createTask(mark, viewer, body);
      case 'link':
        return this.link(mark, viewer, body);
      case 'close':
        return this.decide(mark, viewer, 'close', body);
      case 'reopen':
        return this.decide(mark, viewer, 'reopen', body);
      default:
        return null;
    }
  }

  private list(
    viewer: NonNullable<ReturnType<MockFeedback['viewer']>>,
    taskKey: string | null,
  ): MockResponse {
    let marks = this.marks;
    if (taskKey) {
      const task = this.host.findTask(taskKey);
      marks = task ? this.marks.filter((mark) => mark.taskKey === task.key) : [];
    }
    const sorted = [...marks].sort((a, b) => lastActivity(b).localeCompare(lastActivity(a)));
    const authors = [...new Set(sorted.map((mark) => mark.author))];
    const response: FeedbackInboxResponse = {
      marks: sorted.map((mark) => this.view(mark, viewer)),
      surfaces: (viewer.config.project.feedback?.surfaces ?? []).map((s) => ({ ...s })),
      markers: authors.flatMap((handle) => {
        const person = this.person(handle);
        return person.kind === 'human' && person.color !== null
          ? [{ handle, name: person.name, color: person.color }]
          : [];
      }),
      canProcess: viewer.processor,
      canMark: viewer.member.kind === 'human' && canMarkFeedback(viewer.config, viewer.member),
    };
    return ok(response);
  }

  private summary(viewer: NonNullable<ReturnType<MockFeedback['viewer']>>): FeedbackSummary {
    const human = viewer.member.kind === 'human';
    return {
      configured: (viewer.config.project.feedback?.surfaces.length ?? 0) > 0,
      canMark: human && canMarkFeedback(viewer.config, viewer.member),
      canProcess: viewer.processor,
      // A person who processes does not owe a decision on their own marks.
      todo: viewer.processor
        ? this.marks.filter((mark) => mark.status === 'new' && !(human && mark.author === viewer.handle))
            .length
        : 0,
      unreadReplies: human
        ? this.marks.filter((mark) => mark.author === viewer.handle && mark.unreadBy.has(viewer.handle))
            .length
        : 0,
    };
  }

  private settings(viewer: NonNullable<ReturnType<MockFeedback['viewer']>>): FeedbackSettingsView {
    const lastBy = (pick: (mark: MockFeedbackMark) => string) => {
      const last = new Map<string, string>();
      for (const mark of this.marks) {
        const key = pick(mark);
        if (!last.has(key) || mark.createdAt > last.get(key)!) last.set(key, mark.createdAt);
      }
      return last;
    };
    const bySurface = lastBy((mark) => mark.surfaceId);
    const byAuthor = lastBy((mark) => mark.author);
    const blocked = new Set(viewer.config.project.feedback?.blockedMarkers ?? []);
    // A person without a colour yet gets the next free one when they first mark: shown as it will be.
    let nextColor = this.colors.size;
    return {
      publicBaseUrl: this.publicBaseUrl,
      surfaces: (viewer.config.project.feedback?.surfaces ?? []).map((surface) => ({
        ...surface,
        lastMarkAt: bySurface.get(surface.id) ?? null,
      })),
      markers: viewer.config.team.members.flatMap((member: MemberConfig) => {
        if (member.kind !== 'human') return [];
        return [
          {
            handle: member.handle,
            name: member.displayName,
            access: member.access,
            color: this.colors.get(member.handle) ?? nextColor++ % 8,
            blocked: blocked.has(member.handle),
            activeSessions: this.activeSessions.get(member.handle) ?? 0,
            lastMarkAt: byAuthor.get(member.handle) ?? null,
          },
        ];
      }),
    };
  }

  private launch(viewer: NonNullable<ReturnType<MockFeedback['viewer']>>, body: unknown): MockResponse {
    const parsed = FeedbackLaunchRequest.safeParse(body ?? {});
    if (!parsed.success) return error(400, 'invalid_request', 'Invalid launch');
    const refusal = feedbackMarkRefusal(viewer.config, viewer.member);
    if (refusal === 'no_surface')
      return error(409, 'feedback_not_configured', 'this project has no feedback surface');
    if (refusal)
      return error(403, 'feedback_not_allowed', 'you may not make marks here', { reason: refusal });
    const surface = viewer.config.project.feedback?.surfaces.find((s) => s.id === parsed.data.surfaceId);
    if (!surface) return error(404, 'feedback_surface_not_found', 'unknown surface');
    const origin = normalizeFeedbackOrigin(surface.origin) ?? surface.origin;
    let target = `${origin}/`;
    const mark = parsed.data.markId ? this.marks.find((entry) => entry.id === parsed.data.markId) : undefined;
    if (parsed.data.markId && !mark)
      return error(404, 'feedback_mark_not_found', `mark not found: ${parsed.data.markId}`);
    if (mark && mark.surfaceId === surface.id && mark.origin === origin) target = mark.pageUrl.split('#')[0]!;
    const code = 'MOCKCODE'.repeat(5) + 'abc';
    return {
      status: 201,
      body: {
        url: feedbackLaunchUrl(target, code, parsed.data.markId),
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
      },
    };
  }

  /** The step an action takes, or the refusal (the one rule the server uses). */
  private plan(
    mark: MockFeedbackMark,
    viewer: NonNullable<ReturnType<MockFeedback['viewer']>>,
    action: FeedbackAction,
  ): FeedbackPlan | MockResponse {
    const plan = planFeedbackAction(mark, action, {
      handle: viewer.handle,
      kind: viewer.member.kind,
      processor: viewer.processor,
    });
    return 'refused' in plan ? this.refused(plan.refused) : plan;
  }

  private step(
    mark: MockFeedbackMark,
    viewer: NonNullable<ReturnType<MockFeedback['viewer']>>,
    plan: FeedbackPlan,
    step: { type: FeedbackEventType; body?: string; taskKey?: string; reply?: string },
  ): void {
    const at = nowIso();
    const push = (type: FeedbackEventType, body: string | null, taskKey: string | null) =>
      mark.events.push({ id: mockId('fbe'), type, actor: viewer.handle, body, taskKey, createdAt: at });
    push(step.type, step.body ?? null, step.taskKey ?? null);
    if (step.reply) push('comment', step.reply, null);
    mark.status = plan.status;
    mark.outcome = plan.outcome;
    mark.updatedAt = at;
    mark.closedAt = plan.status === 'closed' ? at : null;
    if (step.taskKey !== undefined) mark.taskKey = step.taskKey;
    if (plan.clearHanded) mark.working = false;
    if (plan.wakeProcessor) mark.working = true;
    // Everyone else has something new to read.
    for (const member of viewer.config.team.members)
      if (member.handle !== viewer.handle) mark.unreadBy.add(member.handle);
    mark.unreadBy.delete(viewer.handle);
    this.ensureColor(viewer.handle);
    this.host.emit({
      type: 'feedback_changed',
      projectKey: viewer.config.project.key,
      markId: mark.id,
    });
  }

  /** Deletes the mark for good; a card it led to stays and gets a line on its timeline. */
  private remove(
    mark: MockFeedbackMark,
    viewer: NonNullable<ReturnType<MockFeedback['viewer']>>,
  ): MockResponse {
    if (!canDeleteFeedback(viewer.member, mark))
      return error(403, 'insufficient_access', 'you may not delete this mark');
    this.marks = this.marks.filter((entry) => entry.id !== mark.id);
    if (mark.taskKey)
      this.host.addTimeline(mark.taskKey, viewer.handle, 'feedback_deleted', {
        markId: mark.id,
        author: mark.author,
        created: mark.outcome === 'card_created',
      });
    this.host.emit({ type: 'feedback_changed', projectKey: viewer.config.project.key, markId: mark.id });
    return ok();
  }

  private comment(
    mark: MockFeedbackMark,
    viewer: NonNullable<ReturnType<MockFeedback['viewer']>>,
    body: unknown,
  ): MockResponse {
    const input = FeedbackCommentRequest.safeParse(body ?? {});
    if (!input.success) return error(400, 'invalid_request', 'Invalid comment');
    if (!viewer.processor) {
      const blocked = viewer.config.project.feedback?.blockedMarkers.includes(viewer.handle) ?? false;
      if (viewer.member.kind !== 'human') return this.refused('feedback_processor_only');
      if (viewer.access === 'viewer' || blocked)
        return error(403, 'feedback_not_allowed', 'you may not comment on marks', {
          reason: viewer.access === 'viewer' ? 'viewer' : 'blocked',
        });
    }
    const plan = this.plan(mark, viewer, 'comment');
    if (isRefusal(plan)) return plan;
    this.step(mark, viewer, plan, { type: 'comment', body: input.data.body });
    return { status: 201, body: this.detail(mark, viewer) };
  }

  private refused(code: string): MockResponse {
    const [name, message, status] = REFUSALS[code]!;
    return error(status, name, message);
  }

  private createTask(
    mark: MockFeedbackMark,
    viewer: NonNullable<ReturnType<MockFeedback['viewer']>>,
    body: unknown,
  ): MockResponse {
    const input = CreateTaskFromFeedbackRequest.safeParse(body ?? {});
    if (!input.success) return error(400, 'invalid_request', 'Invalid card');
    const plan = this.plan(mark, viewer, 'create_task');
    if (isRefusal(plan)) return plan;
    const created = this.host.createCard({
      title: input.data.title,
      description: input.data.description,
    });
    if (created.status >= 400) return created;
    const task = created.body as Task;
    this.step(mark, viewer, plan, {
      type: 'card_created',
      taskKey: task.key,
      reply: input.data.reply,
    });
    this.host.addTimeline(task.key, viewer.handle, 'feedback_linked', { markId: mark.id, created: true });
    const response: CreateTaskFromFeedbackResponse = {
      mark: this.detail(mark, viewer),
      task: { key: task.key, title: task.title },
    };
    return { status: 201, body: response };
  }

  private link(
    mark: MockFeedbackMark,
    viewer: NonNullable<ReturnType<MockFeedback['viewer']>>,
    body: unknown,
  ): MockResponse {
    const input = LinkFeedbackRequest.safeParse(body ?? {});
    if (!input.success) return error(400, 'invalid_request', 'Invalid link');
    const plan = this.plan(mark, viewer, 'link');
    if (isRefusal(plan)) return plan;
    const task = this.host.findTask(input.data.taskKey);
    if (!task) return error(404, 'task_not_found', `card not found: ${input.data.taskKey}`);
    this.step(mark, viewer, plan, { type: 'card_linked', taskKey: task.key, reply: input.data.reply });
    this.host.addTimeline(task.key, viewer.handle, 'feedback_linked', { markId: mark.id, created: false });
    return ok(this.detail(mark, viewer));
  }

  private decide(
    mark: MockFeedbackMark,
    viewer: NonNullable<ReturnType<MockFeedback['viewer']>>,
    action: 'close' | 'reopen',
    body: unknown,
  ): MockResponse {
    const input = CloseFeedbackRequest.safeParse(body ?? {});
    if (!input.success) return error(400, 'invalid_request', 'Invalid request');
    const plan = this.plan(mark, viewer, action);
    if (isRefusal(plan)) return plan;
    this.step(mark, viewer, plan, {
      type: action === 'close' ? 'closed' : 'reopened',
      ...(action === 'close' && input.data.reply ? { reply: input.data.reply } : {}),
    });
    return ok(this.detail(mark, viewer));
  }
}

function isRefusal(value: unknown): value is MockResponse {
  return typeof value === 'object' && value !== null && 'status' in value && 'body' in value;
}

function agoIso(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function lastActivity(mark: MockFeedbackMark): string {
  return mark.events.at(-1)?.createdAt ?? mark.createdAt;
}
