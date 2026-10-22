import {
  DEFAULT_PROJECT_LANGUAGE,
  SYSTEM_FEEDBACK_NEW_PER_DAY,
  SYSTEM_FEEDBACK_REPOSITORY,
  SYSTEM_FEEDBACK_TEXT_MAX,
  SYSTEM_FEEDBACK_TITLE_MAX,
  formatSystemFeedbackBody,
  parseSystemFeedbackIssueUrl,
  redactSystemFeedback,
  redactionCounts,
  systemFeedbackIssueUrl,
} from '@projectman/shared';
import type {
  Actor,
  PrepareSystemFeedbackRequest,
  RedactionCounts,
  SetSystemFeedbackForwardingRequest,
  SystemFeedbackAccess,
  SystemFeedbackForwardingView,
  SystemFeedbackItem,
  SystemFeedbackList,
  SystemFeedbackPrepared,
  SystemFeedbackPreview,
  SystemFeedbackState,
  SystemFeedbackSummary,
  SystemFeedbackTextLabels,
} from '@projectman/shared';
import { getLocale } from '@projectman/templates';
import type {
  SystemFeedbackContextProvider,
  SystemFeedbackLookup,
  SystemFeedbackRecorder,
} from '../../../contracts';
import { isoNow } from '../../../core/base';
import type { DomainContext } from '../../../core/base';
import type { ProjectService } from '../../../core/projects';
import type { TaskService } from '../../../core/tasks';
import type { SystemFeedbackItemRecord } from '../../../db';
import { DomainError, KeyedMutex, SYSTEM_ACTOR, conflict, invalid, newId, notFound } from '../../../kernel';

/** The most items one list returns. */
export const MAX_SYSTEM_FEEDBACK_LIST = 200;
/** How many changes of the forwarding setting the view lists. */
const FORWARDING_HISTORY = 20;
/** The most items the Operator's own list returns. */
export const MAX_SYSTEM_FEEDBACK_OPERATOR_LIST = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A row of the Operator's own list: it never carries what the owner decided or why. */
export interface SystemFeedbackOperatorRow {
  id: string;
  state: SystemFeedbackState;
  title: string;
  occurrences: number;
  lastSeenAt: string;
}

const wrongState = (state: SystemFeedbackState) =>
  conflict('system_feedback_wrong_state', `the feedback is ${state}`, { state });

/**
 * The Operator's findings about projectman itself (PM-472, PM-479). Everything stored or sent on passes the
 * installation's filter, which is built fresh for every use; a fault in the filter's inputs stops the write,
 * it never lets text through. The owner decides where an item goes: a card of this installation (`card`),
 * a prefilled issue they send themselves (`manual`), or nowhere (`off`). Nothing here talks to GitHub.
 */
export class SystemFeedbackService implements SystemFeedbackRecorder, SystemFeedbackLookup {
  private readonly ctx: DomainContext;
  private readonly projects: Pick<ProjectService, 'has' | 'config'>;
  private readonly tasks: Pick<TaskService, 'create'>;
  private readonly filterContext: SystemFeedbackContextProvider;
  private readonly version: string;
  /** One opening of a card at a time per item; the conditional update is the guard that survives a restart. */
  private readonly cards = new KeyedMutex();

  constructor(deps: {
    ctx: DomainContext;
    projects: Pick<ProjectService, 'has' | 'config'>;
    tasks: Pick<TaskService, 'create'>;
    context: SystemFeedbackContextProvider;
    /** The running projectman version, recorded with every occurrence. */
    version: string;
  }) {
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.tasks = deps.tasks;
    this.filterContext = deps.context;
    this.version = deps.version;
  }

  // ---- reading ----

  /**
   * `projectKey` limits the list to one project (a project owner sees only their own); `access` decides
   * whether the forwarding setting comes with it.
   */
  list(opts: { access: SystemFeedbackAccess; projectKey?: string }): SystemFeedbackList {
    const { systemFeedback } = this.ctx.repos;
    const records = systemFeedback.list({
      limit: MAX_SYSTEM_FEEDBACK_LIST,
      ...(opts.projectKey ? { projectKey: opts.projectKey } : {}),
    });
    return {
      access: opts.access,
      items: records.map((record) => this.view(record)),
      newCount: systemFeedback.newCount(opts.projectKey),
      forwarding: opts.access === 'manage' ? this.forwardingView() : null,
      repository: SYSTEM_FEEDBACK_REPOSITORY,
    };
  }

  summary(): SystemFeedbackSummary {
    return { newCount: this.ctx.repos.systemFeedback.newCount() };
  }

  /** One item for a viewer who may read system feedback; `projectKey` limits it to a project owner's own project. */
  get(id: string, opts: { projectKey?: string } = {}): SystemFeedbackItem {
    const record = this.require(id);
    // Another project's item does not exist for a project owner.
    if (opts.projectKey !== undefined && record.projectKey !== opts.projectKey)
      throw notFound('feedback', id);
    return this.view(record);
  }

  /** The project's own items for its Operator, the latest seen first. */
  listForOperator(projectKey: string): SystemFeedbackOperatorRow[] {
    const { systemFeedback } = this.ctx.repos;
    return systemFeedback.list({ projectKey, limit: MAX_SYSTEM_FEEDBACK_OPERATOR_LIST }).map((record) => ({
      id: record.id,
      state: record.state,
      title: record.title,
      occurrences: systemFeedback.occurrenceCount(record.id),
      lastSeenAt: record.lastSeenAt,
    }));
  }

  belongsToProject(projectKey: string, id: string): boolean {
    return this.ctx.repos.systemFeedback.get(id)?.projectKey === projectKey;
  }

  // ---- the forwarding setting ----

  forwardingView(): SystemFeedbackForwardingView {
    const history = this.ctx.repos.systemFeedback.forwardingHistory(FORWARDING_HISTORY);
    const latest = history[0];
    return {
      mode: latest?.mode ?? 'manual',
      projectKey: latest?.mode === 'card' ? latest.projectKey : null,
      history: history.map((change) => ({
        mode: change.mode,
        projectKey: change.projectKey,
        by: this.userName(change.changedBy),
        at: change.changedAt,
      })),
    };
  }

  setForwarding(
    request: SetSystemFeedbackForwardingRequest,
    by: { id: string },
  ): SystemFeedbackForwardingView {
    const projectKey = request.mode === 'card' ? (request.projectKey ?? null) : null;
    if (projectKey !== null && !this.projects.has(projectKey)) throw notFound('project', projectKey);
    this.ctx.unitOfWork(() => {
      this.ctx.repos.systemFeedback.appendForwarding({
        id: newId('fbf'),
        mode: request.mode,
        projectKey,
        changedBy: by.id,
        changedAt: isoNow(this.ctx),
      });
      this.ctx.bus.publish({ type: 'system_feedback_changed', projectKey: null });
    });
    return this.forwardingView();
  }

  // ---- recording ----

  async record(
    projectKey: string,
    member: string,
    sessionId: string,
    input: { title: string; what: string; workaround: string; fix: string; sameAs?: string },
  ): Promise<SystemFeedbackItem> {
    const { systemFeedback } = this.ctx.repos;
    if (input.sameAs) {
      const known = systemFeedback.get(input.sameAs);
      // Another project's item does not exist for this one, in any state.
      if (!known || known.projectKey !== projectKey) throw notFound('feedback', input.sameAs);
      this.ctx.unitOfWork(() => {
        systemFeedback.addOccurrence(known.id, {
          at: isoNow(this.ctx),
          version: this.version,
          sessionId,
        });
        this.ctx.bus.publish({ type: 'system_feedback_changed', projectKey });
      });
      return this.view(this.require(known.id));
    }
    const text = this.checkedTexts(input);
    const filter = await this.filterContext.current();
    const id = newId('fb');
    this.ctx.unitOfWork(() => {
      const now = this.ctx.now();
      // The limit is checked in the unit of work that inserts, so two parallel records cannot both pass.
      const since = new Date(now.getTime() - DAY_MS).toISOString();
      if (systemFeedback.createdSince(projectKey, since) >= SYSTEM_FEEDBACK_NEW_PER_DAY)
        throw conflict(
          'system_feedback_limit',
          `a project may record ${SYSTEM_FEEDBACK_NEW_PER_DAY} new system feedback items in 24 hours`,
        );
      systemFeedback.insert({
        id,
        projectKey,
        title: redactSystemFeedback(text.title, filter).text,
        what: redactSystemFeedback(text.what, filter).text,
        workaround: redactSystemFeedback(text.workaround, filter).text,
        fix: redactSystemFeedback(text.fix, filter).text,
        createdAt: now.toISOString(),
        version: this.version,
        sessionId,
      });
      this.ctx.bus.publish({ type: 'system_feedback_changed', projectKey });
    });
    this.ctx.logger.info({ projectKey, member, feedback: id }, 'system feedback recorded');
    if (this.forwardingView().mode === 'card') await this.openCard(id, SYSTEM_ACTOR, null).catch(() => null);
    return this.view(this.require(id));
  }

  // ---- forwarding ----

  /**
   * Opens the item's card in the project the owner chose. Atomic with the card: the card and the item's
   * `forwarded` state are written in the card's own unit of work (`onCreated`), so a card without a
   * forwarded item, or the reverse, cannot be left behind. A failure to open the card is stored on the item
   * (`cardError`) and the item stays `new`; whoever asked sees it in the returned item.
   */
  openCard(id: string, actor: Actor, by: string | null): Promise<SystemFeedbackItem> {
    return this.cards.run(id, async () => {
      const item = this.require(id);
      if (item.state !== 'new') throw wrongState(item.state);
      const setting = this.forwardingView();
      if (setting.mode !== 'card' || setting.projectKey === null)
        throw conflict('system_feedback_forwarding_mode', 'the forwarding mode is not card');
      const target = setting.projectKey;
      const { systemFeedback } = this.ctx.repos;
      try {
        const sent = await this.filtered(item, await this.labelsOf(item.projectKey));
        await this.tasks.create(target, { title: sent.title, description: sent.body }, actor, {
          onCreated: (task) => {
            const forwarded = systemFeedback.forward(id, {
              kind: 'card',
              projectKey: target,
              taskKey: task.key,
              url: null,
              by,
              at: isoNow(this.ctx),
            });
            // Someone else finished the item first: this card must not exist.
            if (!forwarded) throw wrongState(this.require(id).state);
            this.ctx.bus.publish({ type: 'system_feedback_changed', projectKey: item.projectKey });
          },
        });
      } catch (error) {
        const current = this.ctx.repos.systemFeedback.get(id);
        if (current?.state === 'forwarded') {
          // The card was committed; what failed came after (a notification). Never open a second one.
          this.ctx.logger.warn({ feedback: id }, 'system feedback card was created, a follow-up failed');
        } else if (current?.state !== 'new') {
          throw error;
        } else {
          this.recordCardError(id, error);
        }
      }
      return this.view(this.require(id));
    });
  }

  /** What an owner is shown before sending an item as an issue: the text, filtered again. */
  async preview(id: string): Promise<SystemFeedbackPreview> {
    const item = this.requireManual(id);
    const sent = await this.filtered(item, await this.labelsOf(item.projectKey));
    return {
      title: sent.title,
      body: sent.body,
      counts: sent.counts,
      repository: SYSTEM_FEEDBACK_REPOSITORY,
    };
  }

  /**
   * Checks the text the owner is about to send: if the filter changes anything, the changed text comes back
   * for the owner to look at; otherwise the address of the prefilled issue. Nothing is stored or sent.
   */
  async prepare(id: string, request: PrepareSystemFeedbackRequest): Promise<SystemFeedbackPrepared> {
    this.requireManual(id);
    const filter = await this.filterContext.current();
    const title = redactSystemFeedback(request.title, filter).text;
    const body = redactSystemFeedback(request.body, filter).text;
    if (title !== request.title || body !== request.body)
      return { result: 'refiltered', title, body, counts: redactionCounts(`${title}\n${body}`) };
    const { url, bodyInUrl } = systemFeedbackIssueUrl(title, body);
    return { result: 'ready', url, bodyInUrl };
  }

  /** The owner has sent the item as an issue by hand; the issue's address is optional. */
  markForwarded(id: string, request: { issueUrl?: string }, by: { id: string }): SystemFeedbackItem {
    const item = this.requireManual(id);
    let url: string | null = null;
    if (request.issueUrl) {
      const number = parseSystemFeedbackIssueUrl(request.issueUrl);
      if (number === null)
        throw invalid(
          'system_feedback_issue_url',
          'not the address of an issue of the projectman repository',
        );
      // Rebuilt from the number: whatever else the address carried is not kept.
      url = `https://github.com/${SYSTEM_FEEDBACK_REPOSITORY}/issues/${number}`;
    }
    this.ctx.unitOfWork(() => {
      const forwarded = this.ctx.repos.systemFeedback.forward(item.id, {
        kind: 'issue',
        projectKey: null,
        taskKey: null,
        url,
        by: by.id,
        at: isoNow(this.ctx),
      });
      if (!forwarded) throw wrongState(this.require(item.id).state);
      this.ctx.bus.publish({ type: 'system_feedback_changed', projectKey: item.projectKey });
    });
    return this.view(this.require(id));
  }

  dismiss(id: string, reason: string, by: { id: string }): SystemFeedbackItem {
    const item = this.require(id);
    this.ctx.unitOfWork(() => {
      if (!this.ctx.repos.systemFeedback.dismiss(id, reason, by.id, isoNow(this.ctx)))
        throw wrongState(this.require(id).state);
      this.ctx.bus.publish({ type: 'system_feedback_changed', projectKey: item.projectKey });
    });
    return this.view(this.require(id));
  }

  restore(id: string): SystemFeedbackItem {
    const item = this.require(id);
    this.ctx.unitOfWork(() => {
      if (!this.ctx.repos.systemFeedback.restore(id)) throw wrongState(this.require(id).state);
      this.ctx.bus.publish({ type: 'system_feedback_changed', projectKey: item.projectKey });
    });
    return this.view(this.require(id));
  }

  // ---- internals ----

  private require(id: string): SystemFeedbackItemRecord {
    const record = this.ctx.repos.systemFeedback.get(id);
    if (!record) throw notFound('feedback', id);
    return record;
  }

  /** A new item the owner may send by hand: the mode is manual and the item is still new. */
  private requireManual(id: string): SystemFeedbackItemRecord {
    const item = this.require(id);
    if (this.forwardingView().mode !== 'manual')
      throw conflict('system_feedback_forwarding_mode', 'the forwarding mode is not manual');
    if (item.state !== 'new') throw wrongState(item.state);
    return item;
  }

  /** The texts of a new item, trimmed and checked against the limits before anything is filtered. */
  private checkedTexts(input: { title: string; what: string; workaround: string; fix: string }) {
    const title = input.title.trim();
    const what = input.what.trim();
    const workaround = input.workaround.trim();
    const fix = input.fix.trim();
    if (!title || [...title].length > SYSTEM_FEEDBACK_TITLE_MAX)
      throw invalid('invalid_request', `title must have 1 to ${SYSTEM_FEEDBACK_TITLE_MAX} characters`);
    for (const [name, text] of [
      ['what', what],
      ['workaround', workaround],
      ['fix', fix],
    ] as const)
      if (!text || [...text].length > SYSTEM_FEEDBACK_TEXT_MAX)
        throw invalid('invalid_request', `${name} must have 1 to ${SYSTEM_FEEDBACK_TEXT_MAX} characters`);
    return { title, what, workaround, fix };
  }

  /** The headings of the text, in the language of the project the item comes from. */
  private labelsOf(projectKey: string): Promise<SystemFeedbackTextLabels> {
    return this.projects
      .config(projectKey)
      .then((config) => getLocale(config.project.language).systemFeedback)
      .catch(() => getLocale(DEFAULT_PROJECT_LANGUAGE).systemFeedback);
  }

  /** The item's text as it leaves, filtered again with what the installation knows now. */
  private async filtered(
    item: SystemFeedbackItemRecord,
    labels: SystemFeedbackTextLabels,
  ): Promise<{ title: string; body: string; counts: RedactionCounts }> {
    const filter = await this.filterContext.current();
    const clean = (text: string) => redactSystemFeedback(text, filter).text;
    const title = clean(item.title);
    const body = clean(
      formatSystemFeedbackBody(
        {
          what: item.what,
          workaround: item.workaround,
          fix: item.fix,
          version: item.version,
          occurrences: this.ctx.repos.systemFeedback.occurrenceCount(item.id),
        },
        labels,
      ),
    );
    return { title, body, counts: redactionCounts(`${title}\n${body}`) };
  }

  /** Stores why the card could not be opened; only a safe message, the real error goes to the log. */
  private recordCardError(id: string, error: unknown): void {
    const code = error instanceof DomainError ? error.code : 'internal_error';
    const message = error instanceof DomainError ? error.message : 'the card could not be created';
    if (!(error instanceof DomainError))
      this.ctx.logger.error({ err: error, feedback: id }, 'system feedback card failed');
    this.ctx.unitOfWork(() => {
      if (!this.ctx.repos.systemFeedback.setCardError(id, { code, message, at: isoNow(this.ctx) })) return;
      const item = this.ctx.repos.systemFeedback.get(id);
      if (item) this.ctx.bus.publish({ type: 'system_feedback_changed', projectKey: item.projectKey });
    });
  }

  private userName(id: string): string {
    return this.ctx.repos.users.get(id)?.name ?? id;
  }

  private view(record: SystemFeedbackItemRecord): SystemFeedbackItem {
    const { forwarded, dismissed } = record;
    return {
      id: record.id,
      projectKey: record.projectKey,
      title: record.title,
      what: record.what,
      workaround: record.workaround,
      fix: record.fix,
      state: record.state,
      createdAt: record.createdAt,
      lastSeenAt: record.lastSeenAt,
      version: record.version,
      occurrences: this.ctx.repos.systemFeedback
        .occurrences(record.id)
        .map(({ at, version }) => ({ at, version })),
      counts: redactionCounts([record.title, record.what, record.workaround, record.fix].join('\n')),
      forwarded: forwarded && {
        kind: forwarded.kind,
        projectKey: forwarded.projectKey,
        taskKey: forwarded.taskKey,
        url: forwarded.url,
        by: forwarded.by === null ? null : this.userName(forwarded.by),
        at: forwarded.at,
      },
      dismissed: dismissed && { reason: dismissed.reason, by: this.userName(dismissed.by), at: dismissed.at },
      cardError: record.cardError,
    };
  }
}
