import type { OperatorSessions } from './ports';
import { isProjectManager, memberOf, SYSTEM_SENDER } from '@projectman/shared';
import type { Session, TeamMessage } from '@projectman/shared';
import type { DomainContext } from '../../core/base';
import type { BackgroundTasks } from '../../kernel';
import type { MessageService } from '../../core/messages';
import type { ProjectService } from '../../core/projects';
import { aiActor, KeyedMutex } from '../../kernel';

export const RELAY_WINDOW_MS = 2 * 60 * 60 * 1000;
const RELAY_TAIL_ITEMS = 200;

/** Makes a manager's final session reply visible to the person awaiting it (PM-458). */
export class PmReplyRelay {
  private readonly locks = new KeyedMutex();

  private readonly deps: {
    ctx: DomainContext;
    projects: ProjectService;
    sessions: Pick<OperatorSessions, 'detail'>;
    messages: MessageService;
    background: BackgroundTasks;
  };

  constructor(deps: PmReplyRelay['deps']) {
    this.deps = deps;
  }

  finish(session: Session): void {
    const { ctx, projects, sessions, messages, background } = this.deps;
    const config = projects.cachedConfig(session.projectKey);
    if (!config || session.workItem.type !== 'general') return;
    const manager = memberOf(config, session.member);
    if (!isProjectManager(manager)) return;
    const cutoff = ctx.now().getTime() - RELAY_WINDOW_MS;
    // One bounded read of the window per check; the replies are indexed once, not searched per candidate.
    const load = () => {
      const history = ctx.repos.messages.listWindow(
        session.projectKey,
        session.member,
        new Date(cutoff).toISOString(),
      );
      const relayed = new Set<string>();
      const lastSent = new Map<string, number>();
      for (const reply of history) {
        if (reply.relayed) relayed.add(reply.relayed.inReplyTo);
        if (reply.from !== session.member) continue;
        const sentAt = Date.parse(reply.createdAt);
        for (const to of reply.to) if (sentAt > (lastSent.get(to) ?? -Infinity)) lastSent.set(to, sentAt);
      }
      const unanswered = (candidate: TeamMessage, delivered: number) =>
        !relayed.has(candidate.id) && !((lastSent.get(candidate.from) ?? -Infinity) > delivered);
      return { history, unanswered };
    };
    const { history, unanswered } = load();
    const latest = new Map<string, { message: TeamMessage; delivered: number }>();
    for (const message of history) {
      if (
        !message.to.includes(session.member) ||
        message.from === SYSTEM_SENDER ||
        memberOf(config, message.from)?.kind !== 'human'
      )
        continue;
      const at = message.receipts?.find((r) => r.handle === session.member)?.deliveredAt;
      if (!at) continue;
      const delivered = Date.parse(at);
      if (!(delivered >= cutoff) || !unanswered(message, delivered)) continue;
      const previous = latest.get(message.from);
      if (!previous || delivered >= previous.delivered) latest.set(message.from, { message, delivered });
    }
    if (!latest.size) return;
    // Capture candidates before later idle listeners deliver the next turn's messages.
    // Transcript reads (including remote engine reads) never hold up session event listeners.
    background.run(
      () =>
        this.locks.run(session.id, async () => {
          const before = load().unanswered;
          if (![...latest.values()].some(({ message, delivered }) => before(message, delivered))) return;
          // The final reply is at the end of the transcript: its tail is all that is read.
          const { chat } = await sessions.detail(session.projectKey, session.id, { limit: RELAY_TAIL_ITEMS });
          // Replies sent while the transcript was read count; the load is the last step before recording.
          const current = load().unanswered;
          for (const { message, delivered } of latest.values()) {
            const reply = chat.findLast(
              (item) => item.kind === 'assistant_text' && Date.parse(item.ts) > delivered,
            );
            if (reply?.kind !== 'assistant_text' || !reply.text.trim() || !current(message, delivered))
              continue;
            // No await between the final duplicate check and recording the stored message.
            messages.record({
              projectKey: session.projectKey,
              from: session.member,
              to: [message.from],
              taskKey: message.taskKey,
              kind: 'info',
              body: reply.text.slice(-20000),
              actor: aiActor(session.member),
              sessionId: session.id,
              delivered: true,
              humanRecipients: [message.from],
              relayed: { sessionId: session.id, inReplyTo: message.id },
            });
          }
        }),
      (err) => ctx.logger.warn({ err, sessionId: session.id }, 'could not relay project manager reply'),
    );
  }
}
