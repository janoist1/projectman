import { formatTimestamp, oneLine, PLAIN_STYLE, type TextStyle } from './text';

/** Longer questions and answers are cut in the lines; the whole text reads with get_task `event_id`. */
const QUESTION_TEXT_LIMIT = 160;
const ANSWER_TEXT_LIMIT = 240;

/** What the lines need of a member working on a card (`CardWorker` of the context contract). */
export interface CardWorkerText {
  handle: string;
  role: string;
  state: string;
  doing?: { summary: string };
}

/** What the lines need of a question on a card (`CardQuestion` of the context contract). */
export interface CardQuestionText {
  asker: string;
  question: string;
  askedAt: string;
  askedEventId: string | null;
  state: 'open' | 'answered';
  answer?: { by: string; text: string; at: string; eventId: string | null };
}

/** `idle`, `waiting permission`: a session state as a reader takes it. */
export function stateText(state: string): string {
  return state.replace(/_/g, ' ');
}

/**
 * The other members working on a card (PM-249), one line each: `- designer (UI/UX designer, working):
 * the sentence they gave`. The brief, the message a resumed session gets first and get_task share them.
 */
export function cardWorkerLines(
  workers: readonly CardWorkerText[],
  style: TextStyle = PLAIN_STYLE,
): string[] {
  return workers.map(
    (w) =>
      `- ${style.code(w.handle)} (${w.role}, ${stateText(w.state)})${w.doing ? `: ${oneLine(w.doing.summary, 200)}` : ''}`,
  );
}

/** The text cut to `limit` characters, with how to read it whole when it was cut and an event has it. */
function quoted(text: string, limit: number, taskKey: string, eventId: string | null): string {
  const flat = oneLine(text, Number.MAX_SAFE_INTEGER);
  const cut = oneLine(flat, limit);
  if (cut === flat) return `"${flat}"`;
  const hint = eventId ? ` (read it whole: get_task task_key ${taskKey}, event_id ${eventId})` : '';
  return `"${cut}${hint}"`;
}

/**
 * The questions asked on a card (PM-249), one line each, in the order they come in:
 * `- analyst asked (2026-10-03 11:20 UTC): "…" → owner answered: "…"`, or `→ open`.
 */
export function cardQuestionLines(
  questions: readonly CardQuestionText[],
  taskKey: string,
  style: TextStyle = PLAIN_STYLE,
): string[] {
  return questions.map((q) => {
    const asked = `- ${style.code(q.asker)} asked (${formatTimestamp(q.askedAt)}): ${quoted(q.question, QUESTION_TEXT_LIMIT, taskKey, q.askedEventId)}`;
    if (q.state !== 'answered' || !q.answer) return `${asked} → open`;
    return `${asked} → ${style.code(q.answer.by)} answered: ${quoted(q.answer.text, ANSWER_TEXT_LIMIT, taskKey, q.answer.eventId)}`;
  });
}
