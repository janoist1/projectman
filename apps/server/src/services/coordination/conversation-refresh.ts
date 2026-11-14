import {
  autoCompactWindowOf,
  conversationRefreshDue,
  coordinationMemberOf,
  CONVERSATION_REFRESH_NOTE_MAX,
} from '@projectman/shared';
import type { ConversationRefresh, ProjectConfig, Session } from '@projectman/shared';
import type { DomainContext } from '../../core/base';
import { isoNow } from '../../core/base';
import type { ProjectService } from '../../core/projects';
import type { ProjectManagerSessions } from './ports';
import type { CoordinationRequests } from './requests';

/** What the project manager is told when its conversation is about to be refreshed. */
const NOTE_REQUEST =
  'Your conversation has grown long and will continue in a fresh one. Call save_handover once with a short note ' +
  'for your next conversation: what you are in the middle of, what you promised and what to watch. Do nothing ' +
  `else in this turn: call only save_handover (at most ${CONVERSATION_REFRESH_NOTE_MAX} characters). The server hands ` +
  'over your open questions, approvals, operations and the owners’ recent answers by itself.';

/**
 * Refreshes the project manager's long general conversation (PM-1461): when its context passes the share of the
 * compaction window (`conversationRefreshDue`), or when `requestRefresh` asks for it, the session asks the project
 * manager for a short note at its next idle moment, and the moment after that it continues in a new conversation
 * (the session row stays) that starts from a server-built handover. It never switches in the middle of a turn
 * (everything runs at idle), with an owner's request open, or while an operation the project manager started runs.
 */
export class ConversationRefreshes {
  private readonly deps: {
    ctx: DomainContext;
    projects: Pick<ProjectService, 'config' | 'cachedConfig'>;
    requests: Pick<CoordinationRequests, 'openFor'>;
    sessions: Pick<ProjectManagerSessions, 'find' | 'stop' | 'isRunning'>;
    /** A system message of the action kind to the project manager. */
    notify: (projectKey: string, member: string, text: string) => Promise<void>;
  };

  constructor(deps: ConversationRefreshes['deps']) {
    this.deps = deps;
  }

  /** The session just went idle: the refresh moves one step on when it may. */
  async sessionIdle(session: Session): Promise<void> {
    const { ctx } = this.deps;
    try {
      // Everything up to the first await runs before the other idle listeners deliver anything to the session.
      const config = this.deps.projects.cachedConfig(session.projectKey);
      if (!config || !this.isProjectManagerGeneral(config, session)) return;
      if (this.blocked(session)) return;
      const { sessions } = ctx.repos;
      const refresh = sessions.conversationRefresh(session.id);
      if (!refresh) {
        const manager = coordinationMemberOf(config);
        if (!manager) return;
        const window = autoCompactWindowOf(config.team.limits, manager);
        if (!conversationRefreshDue(sessions.compaction(session.id).contextTokens, window)) return;
        await this.askForNote(session, {
          state: 'note_requested',
          reason: 'context',
          requestedAt: isoNow(ctx),
        });
        return;
      }
      if (refresh.state === 'note_requested') {
        if (!refresh.askedAt) await this.askForNote(session, refresh);
        else sessions.setConversationRefresh(session.id, { ...refresh, state: 'pending' });
      }
      // Pending: the process ends here, the next start is the new conversation. A start the checks above held
      // back comes round again at the next idle moment.
      if (sessions.conversationRefresh(session.id)?.state === 'pending') await this.endProcess(session);
    } catch (err) {
      ctx.logger.warn({ err, sessionId: session.id }, 'could not move the conversation refresh on');
    }
  }

  /**
   * Asks for the project manager's conversation to be refreshed (the review of the project manager's work, PM-1447 E).
   * The running one is asked for its note first; one with no process continues fresh at its next start.
   * False: there is no project manager conversation to refresh.
   */
  async requestRefresh(projectKey: string, reason: 'review'): Promise<boolean> {
    const { ctx } = this.deps;
    const config = await this.deps.projects.config(projectKey);
    const manager = coordinationMemberOf(config);
    if (!manager) return false;
    const session = ctx.repos.sessions.findByWorkItem(projectKey, manager.handle, { type: 'general' });
    if (!session) return false;
    if (ctx.repos.sessions.conversationRefresh(session.id)) return true;
    const requestedAt = isoNow(ctx);
    ctx.repos.sessions.setConversationRefresh(
      session.id,
      this.deps.sessions.isRunning(session.id)
        ? { state: 'note_requested', reason, requestedAt }
        : { state: 'pending', reason, requestedAt },
    );
    return true;
  }

  /**
   * The project manager's note for its next conversation (`save_handover`): it is kept and the refresh is ready;
   * the session continues in the new conversation after this turn. Only while the note is asked for; null: it is not.
   */
  saveHandover(sessionId: string, note: string): ConversationRefresh | null {
    const { ctx } = this.deps;
    const refresh = ctx.repos.sessions.conversationRefresh(sessionId);
    if (refresh?.state !== 'note_requested' || !refresh.askedAt) return null;
    const saved: ConversationRefresh = {
      ...refresh,
      state: 'pending',
      note: note.trim().slice(0, CONVERSATION_REFRESH_NOTE_MAX),
      noteAt: isoNow(ctx),
    };
    ctx.repos.sessions.setConversationRefresh(sessionId, saved);
    return saved;
  }

  /** The project manager's internal general conversation: not a card's and not a person's own. */
  private isProjectManagerGeneral(config: ProjectConfig, session: Session): boolean {
    return (
      coordinationMemberOf(config)?.handle === session.member &&
      session.workItem.type === 'general' &&
      !session.workItem.with
    );
  }

  /** An owner's request is open, or an operation the project manager started is running. */
  private blocked(session: Session): boolean {
    return (
      this.deps.requests.openFor(session.id) !== null ||
      this.deps.ctx.repos.superHandoffs
        .openOperationsOfKey(session.projectKey, session.id)
        .some((operation) => operation.state === 'running')
    );
  }

  private async askForNote(session: Session, refresh: ConversationRefresh): Promise<void> {
    const { ctx } = this.deps;
    ctx.repos.sessions.setConversationRefresh(session.id, { ...refresh, askedAt: isoNow(ctx) });
    await this.deps.notify(session.projectKey, session.member, NOTE_REQUEST);
  }

  /** The idle process ends quietly; the row stays, and its next start is the new conversation. */
  private async endProcess(session: Session): Promise<void> {
    if (!this.deps.sessions.isRunning(session.id)) return;
    // A turn or a request that began since the checks leaves the session alone: it must finish first.
    if (this.deps.sessions.find(session.id)?.state !== 'idle' || this.blocked(session)) return;
    await this.deps.sessions.stop(session.projectKey, session.id, {
      kind: 'restart',
      restartFor: 'new_round',
    });
  }
}
