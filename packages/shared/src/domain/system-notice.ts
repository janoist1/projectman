import { z } from 'zod';
import type { AlertPayload } from './inbox';

/**
 * The notices the system writes to the Messages page (PM-1241, PM-1250): information for the owners that asks for no
 * decision. The stored message text is English, for the AI readers; the web draws the notice from the key and
 * `params` in the language of the interface.
 */
export const SYSTEM_NOTICE_KINDS = [
  'session_tokens',
  'provider_rate_limited',
  'refinement_done',
  'feedback_forwarded',
  'host_request_answered',
  'email_parked',
  'relation_check',
  'work_outage',
  'waiting_digest',
] as const;
export const SystemNoticeKind = z.enum(SYSTEM_NOTICE_KINDS);
export type SystemNoticeKind = z.infer<typeof SystemNoticeKind>;

/** The values a notice is drawn with: plain text and numbers only. */
export const SystemNoticeParams = z.record(z.string(), z.union([z.string(), z.number()]));
export type SystemNoticeParams = z.infer<typeof SystemNoticeParams>;

/** A system notice as the server hands it to the Messages page: its key, its values and the English text. */
export interface SystemNotice {
  notice: SystemNoticeKind;
  params: SystemNoticeParams;
  text: string;
}

const NOTICE_EXCERPT = 300;

function cut(text: string): string {
  return text.length > NOTICE_EXCERPT ? `${text.slice(0, NOTICE_EXCERPT)}…` : text;
}

/** The params with the entries that have no value left out. */
function present(params: Record<string, string | number | null | undefined>): SystemNoticeParams {
  return Object.fromEntries(
    Object.entries(params).filter((entry): entry is [string, string | number] => {
      const value = entry[1];
      return value !== null && value !== undefined && value !== '';
    }),
  );
}

/**
 * The notice an alert becomes when it goes to the Messages page (the `owner_messages` route class, and the
 * pm-class alerts of a project without a project manager); null for an alert that is no notice. The English text
 * is what AI readers see, the key and params are what the web draws.
 */
export function systemNoticeOf(alert: AlertPayload): SystemNotice | null {
  switch (alert.alert) {
    case 'session_tokens':
      return {
        notice: 'session_tokens',
        params: present({
          counted: alert.countedTokens,
          limit: alert.limitTokens,
          taskKey: alert.workItem.type === 'task' ? alert.workItem.taskKey : null,
        }),
        text: `A session used ${alert.countedTokens} tokens, above the warning limit of ${alert.limitTokens}.`,
      };
    case 'provider_rate_limited':
      return {
        notice: 'provider_rate_limited',
        params: present({ provider: alert.provider, until: alert.until, message: cut(alert.message) }),
        text:
          `The ${alert.provider} request limit was reached` +
          `${alert.until ? `; it holds until ${alert.until}` : ''}: ${cut(alert.message)}`,
      };
    case 'refinement':
      if (alert.reason !== 'done') return null;
      return {
        notice: 'refinement_done',
        params: { taskKey: alert.taskKey },
        text: `${alert.taskKey} is worked out.`,
      };
    case 'feedback_forwarded':
      return {
        notice: 'feedback_forwarded',
        params: present({ author: alert.author, excerpt: alert.excerpt, reason: cut(alert.reason) }),
        text: `The feedback processor passed feedback of ${alert.author} on to the owners: ${cut(alert.reason)}`,
      };
    case 'host_request_answered':
      return {
        notice: 'host_request_answered',
        params: present({ title: alert.title, outcome: alert.outcome, answer: cut(alert.answer) }),
        text: `The host ${alert.outcome} the request "${alert.title}"${alert.answer ? `: ${cut(alert.answer)}` : '.'}`,
      };
    case 'email_parked':
      return {
        notice: 'email_parked',
        params: present({
          emailId: alert.emailId,
          from: alert.fromAddress,
          subject: alert.subject,
          reason: alert.reason,
        }),
        text: `An email from ${alert.fromAddress} ("${alert.subject}") was parked: ${alert.reason}.`,
      };
    case 'relation_check': {
      const relations = alert.relations.map(({ kind, key }) => `${kind} ${key}`).join(', ');
      return {
        notice: 'relation_check',
        params: { taskKey: alert.taskKey, relations },
        text: `New relations of ${alert.taskKey} may change its work (${relations}), and no analyst or project manager can check them.`,
      };
    }
    case 'work_outage':
      return {
        notice: 'work_outage',
        params: present({
          outage: alert.outage.kind === 'provider' ? alert.outage.provider : 'engine',
          members: alert.members.join(', '),
          tasks: alert.tasks.join(', '),
          since: alert.outage.since,
          engine: alert.outage.engine?.name,
          problem: alert.outage.kind === 'provider' ? alert.outage.problem : 'engine',
        }),
        text:
          `Work is blocked since ${alert.outage.since} by an outage (${alert.outage.kind === 'provider' ? `${alert.outage.provider}: ${alert.outage.problem}` : 'engine disconnected'})` +
          `${alert.outage.engine ? ` on engine ${alert.outage.engine.name}` : ''}` +
          `${alert.tasks.length > 0 ? `; cards: ${alert.tasks.join(', ')}` : ''}. Restore the provider's subscription login or setup, or reconnect the engine.`,
      };
    default:
      return null;
  }
}

/** What has waited too long in a project: the integrator's todos and the questions the project manager screens. */
export interface WaitingDigestFacts {
  todos: number;
  questions: number;
  /** Whole hours the oldest of them has waited. */
  oldestHours: number;
}

/** The once-a-day notice about what waits more than a day (PM-1250). */
export function waitingDigestNotice(facts: WaitingDigestFacts): SystemNotice {
  const { todos, questions, oldestHours } = facts;
  return {
    notice: 'waiting_digest',
    params: { todos, questions, oldestHours },
    text: `${todos} todo(s) of the integrator and ${questions} question(s) in screening are waiting; the oldest for ${oldestHours} hours.`,
  };
}
