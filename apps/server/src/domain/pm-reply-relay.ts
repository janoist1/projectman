import { isProjectManager, memberOf, SYSTEM_SENDER } from '@projectman/shared';
import type { Session, TeamMessage } from '@projectman/shared';
import type { DomainContext } from './context';
import type { MessageService } from './messaging';
import type { ProjectService } from './projects';
import type { SessionOrchestrator } from './sessions';
import { aiActor, KeyedMutex } from './util';

export const RELAY_WINDOW_MS = 2 * 60 * 60 * 1000;

/** Makes a manager's final session reply visible to the person awaiting it (PM-458). */
export class PmReplyRelay {
  private readonly locks = new KeyedMutex();

  private readonly deps: {
    ctx: DomainContext;
    projects: ProjectService;
    sessions: SessionOrchestrator;
    messages: MessageService;
  };

  constructor(deps: PmReplyRelay['deps']) {
    this.deps = deps;
  }

  finish(session: Session): Promise<void> {
    return this.locks.run(session.id, async () => {
      const { ctx, projects, sessions, messages } = this.deps;
      const config = projects.cachedConfig(session.projectKey);
      if (
        !config ||
        session.workItem.type !== 'general' ||
        !isProjectManager(memberOf(config, session.member))
      )
        return;
      const cutoff = ctx.now().getTime() - RELAY_WINDOW_MS;
      const all = () =>
        ctx.repos.messages.list(session.projectKey, {
          member: session.member,
          limit: Number.MAX_SAFE_INTEGER,
        });
      const unanswered = (candidate: TeamMessage, delivered: number, history: TeamMessage[]) =>
        !history.some(
          (reply) =>
            reply.relayed?.inReplyTo === candidate.id ||
            (reply.from === session.member &&
              reply.to.includes(candidate.from) &&
              Date.parse(reply.createdAt) > delivered),
        );
      const history = all();
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
        if (!(delivered >= cutoff) || !unanswered(message, delivered, history)) continue;
        const previous = latest.get(message.from);
        if (!previous || delivered >= previous.delivered) latest.set(message.from, { message, delivered });
      }
      if (!latest.size) return;
      const { chat } = await sessions.detail(session.projectKey, session.id);
      for (const { message, delivered } of latest.values()) {
        const reply = chat.findLast(
          (item) => item.kind === 'assistant_text' && Date.parse(item.ts) > delivered,
        );
        if (reply?.kind !== 'assistant_text' || !reply.text.trim() || !unanswered(message, delivered, all()))
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
    });
  }
}
