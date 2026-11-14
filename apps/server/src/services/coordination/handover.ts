import {
  CONVERSATION_HANDOVER_ANSWER_DAYS,
  CONVERSATION_HANDOVER_ITEM_LIMIT,
  questionPayloadOf,
} from '@projectman/shared';
import type { InboxItem } from '@projectman/shared';
import type { ConversationHandover, ConversationHandoverItem } from '../../contracts';
import type { DomainContext } from '../../core/base';
import type { ProjectManagerKnowledge } from './knowledge';

/** The longest question and answer text of an item, in characters. */
const QUESTION_TEXT_MAX = 200;
const ANSWER_TEXT_MAX = 300;
const DAY_MS = 24 * 60 * 60_000;

/** The first `max` characters of the text, its line breaks as spaces. */
function cut(text: string, max: number): string {
  return Array.from(text.replace(/\s+/g, ' ').trim()).slice(0, max).join('');
}

/** The question a question item asks: the payload's question, else its title. */
function questionOf(item: InboxItem): string {
  return cut(questionPayloadOf(item)?.question ?? item.title, QUESTION_TEXT_MAX);
}

/** The answer an owner gave: the chosen option's label and their note. */
function answerOf(item: InboxItem): string {
  const resolution = item.resolution;
  if (!resolution) return '';
  const label = item.options.find((option) => option.id === resolution.optionId)?.label;
  return cut([label, resolution.note].filter(Boolean).join(': '), ANSWER_TEXT_MAX);
}

/**
 * What the project manager's next conversation must know of the old one (PM-1461), from server facts only: its
 * open questions and approvals, the super operations it started that are not settled, the owners' answers of
 * the last days, the open signals and the agreement in force, plus the note it wrote itself. Each kind lists at
 * most `CONVERSATION_HANDOVER_ITEM_LIMIT` items. Nothing of the old conversation's text goes into it.
 */
export class ConversationHandovers {
  private readonly deps: { ctx: DomainContext; knowledge: Pick<ProjectManagerKnowledge, 'read'> };

  constructor(deps: ConversationHandovers['deps']) {
    this.deps = deps;
  }

  async build(input: {
    projectKey: string;
    /** The project manager's handle. */
    member: string;
    /** The project manager's general session; the operations it started are keyed by it. */
    sessionId: string;
    note: string | null;
  }): Promise<ConversationHandover> {
    const { ctx } = this.deps;
    const { repos } = ctx;
    const { projectKey, member } = input;
    const limit = CONVERSATION_HANDOVER_ITEM_LIMIT;
    const items: ConversationHandoverItem[] = [];
    const add = (list: ConversationHandoverItem[]) => items.push(...list.slice(0, limit));

    const open = repos.inbox.list(projectKey, { state: 'open' }).filter((item) => item.source === member);
    const operations = repos.superHandoffs.openOperationsOfKey(projectKey, input.sessionId);
    // The question an operation waits on is told with the operation, not twice.
    const operationQuestions = new Set(
      operations.flatMap((op) => (op.ownerQuestionId ? [op.ownerQuestionId] : [])),
    );
    add(
      open
        .filter((item) => item.kind === 'question' && !operationQuestions.has(item.id))
        .map((item) => ({ kind: 'question', id: item.id, text: questionOf(item), at: item.createdAt })),
    );
    add(
      open
        .filter((item) => item.kind === 'approval' && !operationQuestions.has(item.id))
        .map((item) => ({
          kind: 'approval',
          id: item.id,
          text: cut(item.title, QUESTION_TEXT_MAX),
          at: item.createdAt,
        })),
    );
    add(
      operations.map((op) => {
        const question = op.ownerQuestionId ? repos.inbox.get(op.ownerQuestionId) : null;
        const waiting =
          question && op.state === 'waiting_owner' ? ` — waiting for the owner: ${questionOf(question)}` : '';
        return {
          kind: 'operation',
          id: op.id,
          text: `${op.command.kind} (${op.state})${waiting}`,
          at: op.createdAt,
        };
      }),
    );
    const since = new Date(ctx.now().getTime() - CONVERSATION_HANDOVER_ANSWER_DAYS * DAY_MS).toISOString();
    add(
      repos.inbox
        .listAnsweredQuestions(projectKey, since, true)
        .filter((item) => item.source === member && item.resolution)
        .slice(-limit)
        .map((item) => ({
          kind: 'answer',
          id: item.id,
          text: `${questionOf(item)} → ${answerOf(item)}`,
          at: item.resolution?.at ?? item.createdAt,
        })),
    );
    add(
      repos.projectManagerSignals.listOpen(projectKey).map((signal) => ({
        kind: 'signal',
        id: signal.id,
        text: signal.taskKey ? `${signal.kind} (${signal.taskKey})` : signal.kind,
        at: signal.raisedAt,
      })),
    );

    const knowledge = await this.deps.knowledge.read(projectKey);
    return {
      agreement: knowledge.agreement
        ? { version: knowledge.agreement.version, involvement: knowledge.agreement.data.involvement }
        : null,
      items,
      note: input.note,
    };
  }
}
