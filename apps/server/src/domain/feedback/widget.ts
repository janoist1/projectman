import { createHash, randomBytes } from 'node:crypto';
import { feedbackMarkRefusal, memberOf, normalizeFeedbackOrigin } from '@projectman/shared';
import type {
  CreateFeedbackMarkRequest,
  FeedbackMarkDetail,
  FeedbackSessionResponse,
  FeedbackWidgetListResponse,
  ProjectConfig,
} from '@projectman/shared';
import { isoNow } from '../context';
import type { DomainContext } from '../context';
import { DomainError } from '../errors';
import type { ConfigChange, ProjectService } from '../projects';
import { humanActor, newId } from '../util';
import type { FeedbackService } from './service';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** A tool session ends after this long unused (sliding), and in any case this long after it started. */
export const FEEDBACK_SESSION_IDLE_MS = 30 * DAY_MS;
export const FEEDBACK_SESSION_MAX_MS = 90 * DAY_MS;
/** `last_used_at` is written at most this often. */
const TOUCH_INTERVAL_MS = 60 * 1000;

/** What one tool session, and one project, may do (PM-506 2.5). */
export const FEEDBACK_LIMITS = {
  marksPerSessionHour: 30,
  commentsPerSessionHour: 120,
  marksPerProjectDay: 500,
} as const;

/** The token of a session: 32 random bytes, base64url. */
export const FEEDBACK_SESSION_TOKEN = /^[A-Za-z0-9_-]{43}$/;

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** A valid session of the tool, as a request carries it. */
export interface FeedbackWidgetSession {
  id: string;
  projectKey: string;
  handle: string;
  surfaceId: string;
  /** The address of the customer's page; every request of the session comes from it. */
  origin: string;
}

const codeInvalid = () => new DomainError('feedback_code_invalid', 'the code is not valid', { status: 401 });
const sessionInvalid = () =>
  new DomainError('feedback_session_invalid', 'the session is not valid', { status: 401 });

function rateLimited(retryAfterMs: number): DomainError {
  const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return new DomainError('feedback_rate_limited', 'too many requests; try again later', {
    status: 429,
    details: { retryAfterSeconds },
  });
}

/**
 * What the tool on a customer's page may see of a mark: no environment or screenshot, no reason of a
 * forward, and no processing. The token sits in the page's storage, where a script of the customer's
 * page can read it, so it opens no more than marking and reading the thread needs.
 */
function widgetDetail(detail: FeedbackMarkDetail): FeedbackMarkDetail {
  return {
    ...detail,
    environment: null,
    screenshot: null,
    canProcess: false,
    thread: detail.thread.map((entry) => (entry.type === 'forwarded' ? { ...entry, body: null } : entry)),
  };
}

/**
 * The public widget API (PM-506, PM-509): the tool on a customer's page marks and reads with a bearer
 * session it got for a one-time code. The session is checked on every request, so a revocation, a
 * removed member, a switched-off "may mark", a deleted surface or an expiry take effect at once.
 */
export class FeedbackWidgetService {
  private readonly ctx: DomainContext;
  private readonly projects: ProjectService;
  private readonly feedback: FeedbackService;
  /** Request times per session and kind within the last hour; in memory, a restart empties it. */
  private readonly hits = new Map<string, number[]>();
  /** Marks being made right now per project: they are not in the database yet, but count to its day. */
  private readonly pendingMarks = new Map<string, number>();

  constructor(deps: { ctx: DomainContext; projects: ProjectService; feedback: FeedbackService }) {
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.feedback = deps.feedback;
  }

  // ---- who may call ----

  /** The addresses of all projects' surfaces: the only `Origin`s the API answers. */
  async allowedOrigins(): Promise<Set<string>> {
    const origins = new Set<string>();
    for (const { key } of this.projects.summaries()) {
      const config = this.projects.cachedConfig(key) ?? (await this.projects.config(key).catch(() => null));
      for (const surface of config?.project.feedback?.surfaces ?? []) {
        const origin = normalizeFeedbackOrigin(surface.origin);
        if (origin) origins.add(origin);
      }
    }
    return origins;
  }

  async originAllowed(origin: string): Promise<boolean> {
    return (await this.allowedOrigins()).has(origin);
  }

  /** The person may still mark on this surface, and the surface has this address; null if not. */
  private markerAllowed(config: ProjectConfig, handle: string, surfaceId: string, origin: string) {
    const member = memberOf(config, handle);
    if (!member || feedbackMarkRefusal(config, member) !== null) return null;
    const surface = config.project.feedback?.surfaces.find((s) => s.id === surfaceId);
    if (!surface || normalizeFeedbackOrigin(surface.origin) !== origin) return null;
    return { config, surface };
  }

  /** `unavailable`: the configuration could not be read, which says nothing about the person. */
  private async markerCheck(projectKey: string, handle: string, surfaceId: string, origin: string) {
    const config = await this.projects.config(projectKey).catch(() => null);
    if (!config) return 'unavailable' as const;
    return this.markerAllowed(config, handle, surfaceId, origin);
  }

  /**
   * A session ends for good when its person may no longer mark or its surface is gone or has another
   * address: the handle of a removed member can be given to someone else, and the old token must not
   * work for them. Every change of the configuration is looked at, so a session that is never used
   * again ends too.
   */
  configChanged(change: ConfigChange): void {
    const { feedback: repo } = this.ctx.repos;
    const at = isoNow(this.ctx);
    for (const session of repo.liveSessions(change.projectKey, at))
      if (!this.markerAllowed(change.next, session.member, session.surfaceId, session.origin))
        repo.revokeSession(session.id, 'system', at);
  }

  // ---- the session ----

  private sessionEnd(now: Date, createdAt: string): string {
    return new Date(
      Math.min(now.getTime() + FEEDBACK_SESSION_IDLE_MS, Date.parse(createdAt) + FEEDBACK_SESSION_MAX_MS),
    ).toISOString();
  }

  /**
   * Exchanges the one-time launch code for a session. An unknown, expired, used or foreign code is the
   * same 401: the answer never says which. The code is used up by any attempt that names it, whoever
   * the caller: a code that was tried from another address is not worth keeping.
   */
  async exchange(input: {
    code: string;
    origin: string;
    userAgent: string | null;
  }): Promise<FeedbackSessionResponse> {
    const now = this.ctx.now();
    const at = now.toISOString();
    const { feedback: repo } = this.ctx.repos;
    const code = repo.consumeLaunchCode(sha256(input.code), at);
    if (!code || code.origin !== input.origin) throw codeInvalid();
    const checked = await this.markerCheck(code.projectKey, code.member, code.surfaceId, code.origin);
    if (!checked || checked === 'unavailable') throw codeInvalid();

    const token = randomBytes(32).toString('base64url');
    const expiresAt = this.sessionEnd(now, at);
    repo.insertSession({
      id: newId('fbs'),
      tokenHash: sha256(token),
      projectKey: code.projectKey,
      member: code.member,
      surfaceId: code.surfaceId,
      origin: code.origin,
      appOrigin: code.appOrigin,
      userAgent: input.userAgent?.slice(0, 500) ?? null,
      createdAt: at,
      lastUsedAt: at,
      expiresAt,
    });
    const me = await this.feedback.me(code.projectKey, humanActor(code.member));
    const mark = code.markId ? repo.getMark(code.markId) : null;
    // Only a mark of the surface the session is for: the tool shows no other.
    const markId =
      mark && mark.projectKey === code.projectKey && mark.surfaceId === code.surfaceId ? mark.id : null;
    return {
      token,
      expiresAt,
      me,
      project: { key: code.projectKey, name: checked.config.project.name },
      surface: { id: checked.surface.id, name: checked.surface.name, origin: code.origin },
      markId,
      // The app's page of the project's marks, for a link from the tool.
      appUrl: `${code.appOrigin}/p/${code.projectKey}/feedback`,
    };
  }

  /** The session behind a token, if it is good now and for this `Origin`; else 401. */
  async authenticate(token: string, origin: string): Promise<FeedbackWidgetSession> {
    if (!FEEDBACK_SESSION_TOKEN.test(token)) throw sessionInvalid();
    const { feedback: repo } = this.ctx.repos;
    const record = repo.sessionByTokenHash(sha256(token));
    const now = this.ctx.now();
    if (
      !record ||
      record.revokedAt !== null ||
      Date.parse(record.expiresAt) <= now.getTime() ||
      Date.parse(record.createdAt) + FEEDBACK_SESSION_MAX_MS <= now.getTime() ||
      record.origin !== origin
    )
      throw sessionInvalid();
    const checked = await this.markerCheck(record.projectKey, record.member, record.surfaceId, record.origin);
    // A person who may not mark any more loses the session for good, also if this is the first request
    // since the change; an unreadable configuration only refuses this request.
    if (!checked) repo.revokeSession(record.id, 'system', now.toISOString());
    if (!checked || checked === 'unavailable') throw sessionInvalid();
    if (now.getTime() - Date.parse(record.lastUsedAt) >= TOUCH_INTERVAL_MS)
      repo.touchSession(record.id, now.toISOString(), this.sessionEnd(now, record.createdAt));
    return {
      id: record.id,
      projectKey: record.projectKey,
      handle: record.member,
      surfaceId: record.surfaceId,
      origin: record.origin,
    };
  }

  /** The person leaves: this session ends. */
  endSession(session: FeedbackWidgetSession): void {
    this.ctx.repos.feedback.revokeSession(session.id, session.handle, isoNow(this.ctx));
  }

  // ---- limits ----

  /** Counts one more request of `kind` for the session within the last hour; 429 when it is over. */
  private charge(session: FeedbackWidgetSession, kind: 'marks' | 'comments', max: number): void {
    const at = this.ctx.now().getTime();
    const key = `${session.id}:${kind}`;
    if (this.hits.size > 1000)
      for (const [k, times] of this.hits) if (times.every((t) => t <= at - HOUR_MS)) this.hits.delete(k);
    const times = (this.hits.get(key) ?? []).filter((t) => t > at - HOUR_MS);
    this.hits.set(key, times);
    if (times.length >= max) throw rateLimited(times[0]! + HOUR_MS - at);
    times.push(at);
  }

  /** The project's marks of the last day, whoever made them. */
  private checkProjectDay(projectKey: string): void {
    const at = this.ctx.now().getTime();
    const { count, oldest } = this.ctx.repos.feedback.marksSince(
      projectKey,
      new Date(at - DAY_MS).toISOString(),
    );
    if (count + (this.pendingMarks.get(projectKey) ?? 0) >= FEEDBACK_LIMITS.marksPerProjectDay)
      throw rateLimited((oldest ? Date.parse(oldest) : at) + DAY_MS - at);
  }

  // ---- the tool's requests ----

  async list(session: FeedbackWidgetSession, cursor: string | null): Promise<FeedbackWidgetListResponse> {
    return this.feedback.widgetList(session.projectKey, humanActor(session.handle), {
      surfaceId: session.surfaceId,
      cursor,
    });
  }

  async detail(session: FeedbackWidgetSession, markId: string): Promise<FeedbackMarkDetail> {
    this.requireMark(session, markId);
    return widgetDetail(await this.feedback.detail(session.projectKey, markId, humanActor(session.handle)));
  }

  async createMark(
    session: FeedbackWidgetSession,
    request: CreateFeedbackMarkRequest,
  ): Promise<FeedbackMarkDetail> {
    this.charge(session, 'marks', FEEDBACK_LIMITS.marksPerSessionHour);
    this.checkProjectDay(session.projectKey);
    // Counted from the check to the insert, so parallel requests cannot all pass the same check.
    const key = session.projectKey;
    this.pendingMarks.set(key, (this.pendingMarks.get(key) ?? 0) + 1);
    try {
      return widgetDetail(
        await this.feedback.createMark({
          projectKey: key,
          author: session.handle,
          surfaceId: session.surfaceId,
          request,
        }),
      );
    } finally {
      const left = (this.pendingMarks.get(key) ?? 1) - 1;
      if (left > 0) this.pendingMarks.set(key, left);
      else this.pendingMarks.delete(key);
    }
  }

  async comment(session: FeedbackWidgetSession, markId: string, body: string): Promise<FeedbackMarkDetail> {
    this.requireMark(session, markId);
    this.charge(session, 'comments', FEEDBACK_LIMITS.commentsPerSessionHour);
    return widgetDetail(
      await this.feedback.comment(session.projectKey, markId, humanActor(session.handle), body),
    );
  }

  async markRead(session: FeedbackWidgetSession, markId: string): Promise<void> {
    this.requireMark(session, markId);
    await this.feedback.markRead(session.projectKey, markId, humanActor(session.handle));
  }

  /** The tool sees the marks of its own surface only. */
  private requireMark(session: FeedbackWidgetSession, markId: string): void {
    const mark = this.ctx.repos.feedback.getMark(markId);
    if (!mark || mark.projectKey !== session.projectKey || mark.surfaceId !== session.surfaceId)
      throw new DomainError('feedback_mark_not_found', `mark not found: ${markId}`, { status: 404 });
  }
}
