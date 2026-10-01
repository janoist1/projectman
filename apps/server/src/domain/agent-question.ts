import type { QuestionOptionInput } from '@projectman/shared';
import type { ToolContext } from '../contracts';
import type { DomainContext } from './context';

/**
 * A question an agent CLI puts to whoever sits at its terminal (Claude Code's AskUserQuestion,
 * PM-199): nobody sits there, and a dialog in a terminal shows up nowhere in the app, so the
 * session would wait unseen. The runner turns such a call away and hands the questions to the
 * domain, which asks the humans in their inbox exactly as an `ask_human` call would; the answer
 * comes back to the member as a team message.
 */

export interface AgentQuestion {
  question: string;
  options: QuestionOptionInput[];
  details: string;
}

const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 8;
const MAX_TEXT = 2_000;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, MAX_TEXT) : '';
}

/** The questions of a question tool's input (`{ questions: [{ question, options: [{ label, description }] }] }`). */
export function agentQuestionsOf(toolName: string, toolInput: unknown): AgentQuestion[] {
  const raw = (toolInput as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(raw)) return [];
  const questions: AgentQuestion[] = [];
  for (const entry of raw.slice(0, MAX_QUESTIONS)) {
    const item = entry as { question?: unknown; header?: unknown; multiSelect?: unknown; options?: unknown };
    const question = text(item?.question);
    if (!question) continue;
    const options: QuestionOptionInput[] = [];
    for (const option of Array.isArray(item.options) ? item.options.slice(0, MAX_OPTIONS) : []) {
      const label = typeof option === 'string' ? text(option) : text((option as { label?: unknown })?.label);
      if (!label) continue;
      const description =
        typeof option === 'string' ? '' : text((option as { description?: unknown })?.description);
      options.push(description ? { label, consequence: description } : label);
    }
    const header = text(item.header);
    questions.push({
      question,
      options,
      details: [
        `Asked with the ${toolName} tool; the runner forwarded it to the inbox, because nobody reads the member's terminal.`,
        ...(header ? [`Topic: ${header}`] : []),
        ...(item.multiSelect === true
          ? ['The member allows several answers: answer in your own words.']
          : []),
      ].join('\n\n'),
    });
  }
  return questions;
}

type AskHuman = (
  ctx: ToolContext,
  args: { question: string; options?: QuestionOptionInput[]; details?: string },
) => Promise<unknown>;

/** Turns a member's terminal questions into inbox questions. */
export class AgentQuestions {
  private readonly ctx: DomainContext;
  private readonly askHuman: AskHuman;

  constructor(deps: { ctx: DomainContext; askHuman: AskHuman }) {
    this.ctx = deps.ctx;
    this.askHuman = deps.askHuman;
  }

  /**
   * True when the call's questions are in the inbox; false when it asked none, the session is unknown,
   * or the first one could not be asked. A failure after some were asked still counts as forwarded:
   * those are in the list already, and the call must not be asked again at the terminal.
   */
  async forward(sessionId: string, toolName: string, toolInput: unknown): Promise<boolean> {
    const session = this.ctx.repos.sessions.get(sessionId);
    const questions = agentQuestionsOf(toolName, toolInput);
    if (!session || questions.length === 0) return false;
    const context: ToolContext = {
      sessionId: session.id,
      projectKey: session.projectKey,
      member: session.member,
      taskKey: session.workItem.type === 'task' ? session.workItem.taskKey : null,
    };
    let asked = 0;
    for (const { question, options, details } of questions) {
      try {
        await this.askHuman(context, { question, ...(options.length ? { options } : {}), details });
        asked += 1;
      } catch (err) {
        if (asked === 0) throw err;
        this.ctx.logger.warn(
          { err, sessionId, asked, of: questions.length },
          'only some questions of the call reached the inbox',
        );
        break;
      }
    }
    return true;
  }
}
