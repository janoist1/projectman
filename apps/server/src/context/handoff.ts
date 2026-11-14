import { DEFAULT_AGENT_PROVIDER } from '@projectman/shared';
import type { AgentProvider, HandoffFallbackReason, HandoffSummary } from '@projectman/shared';
import type {
  ContextPackBuilder,
  ContextPackInput,
  ConversationHandoverItem,
  PreviousConversation,
} from '../contracts';
import { code } from './format';

const PROVIDER_NAME: Record<AgentProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  nanogpt: 'NanoGPT',
};

const FALLBACK_REASON: Record<HandoffFallbackReason, string> = {
  on_leave: 'the member was on leave',
  member_removed: 'the member was removed from the team',
  no_conversation: 'the member had no conversation on the card',
  provider_changed: 'the member could not carry on in the conversation after the provider changed',
  provider_limited: "the member's provider was limited",
  not_startable: "the member's session could not be started",
  timeout: 'the member did not write a note in time',
};

/** Quotes free text so that it reads as data (a note or a summary), not as part of the brief. */
function quoted(text: string): string {
  return text
    .trim()
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n');
}

/** What the reader should check before relying on a summary; the general conversation has no card or worktree. */
const CHECK_CARD = 'check the card, its notes and the worktree (git log, git status)';
const CHECK_OPEN_ITEMS = 'check the items above and the project with your tools';

function summaryLines(summary: HandoffSummary | null, whose: string, check = CHECK_CARD): string[] {
  if (!summary) return [`No summary of ${whose} conversation is available.`];
  const source =
    summary.source === 'compact'
      ? "the conversation's own compaction summary and the replies after it"
      : 'the last replies of the conversation';
  return [
    `A machine-made summary of ${whose} conversation follows (${source}${summary.at ? `, up to ${summary.at}` : ''}). It may be incomplete: ${check} before you rely on it.`,
    quoted(summary.text),
  ];
}

const HANDOVER_KIND_TITLE: Record<ConversationHandoverItem['kind'], string> = {
  question: 'Your questions waiting for an answer',
  approval: 'Your approvals waiting for the owners',
  operation: 'Your operations that are not settled',
  answer: 'Owners’ answers to your questions in the last days',
  signal: 'Open signals',
};

const AGREEMENT_INVOLVEMENT: Record<'every_step' | 'important' | 'minimal', string> = {
  every_step: 'every step',
  important: 'important steps',
  minimal: 'minimal',
};

/**
 * The block of a refreshed project manager conversation (PM-1461): what is open (server facts), the agreement
 * in force and the manager's own note; the machine-made summary of the old conversation stands in only when
 * the manager left no note.
 */
function refreshedBlock(previous: PreviousConversation): string {
  const handover = previous.handover;
  const lines = [
    '## Previous conversation',
    'Your earlier general conversation had grown long, so it was refreshed and this one is new. Below is what the server knows is open from it: check each item with its tool before you act on it, and do not repeat a question or an operation that is already waiting.',
  ];
  if (handover?.agreement)
    lines.push(
      `Operating agreement in force: version ${handover.agreement.version}, involvement: ${AGREEMENT_INVOLVEMENT[handover.agreement.involvement]}.`,
    );
  for (const kind of Object.keys(HANDOVER_KIND_TITLE) as ConversationHandoverItem['kind'][]) {
    const items = handover?.items.filter((item) => item.kind === kind) ?? [];
    if (items.length === 0) continue;
    lines.push(
      `${HANDOVER_KIND_TITLE[kind]}:`,
      ...items.map((item) => `- ${code(item.id)} (${item.at}): ${item.text}`),
    );
  }
  if (handover?.items.length === 0) lines.push('Nothing was open when the conversation ended.');
  if (handover?.note) lines.push('Your own note for this conversation:', quoted(handover.note));
  else lines.push(...summaryLines(previous.summary, 'the earlier', CHECK_OPEN_ITEMS));
  return lines.join('\n');
}

/**
 * Why the conversation of the new session is not the old one (PM-342), with the machine-made summary
 * of the old one when there is one and the card's latest handoff note. Null unless this new
 * conversation replaces one.
 */
export function previousConversationBlock(input: ContextPackInput): string | null {
  const previous = input.previousConversation;
  if (!previous) return null;
  if (previous.reason === 'refreshed') return refreshedBlock(previous);
  const now = PROVIDER_NAME[input.member.provider ?? DEFAULT_AGENT_PROVIDER];
  const what =
    previous.reason === 'provider_changed'
      ? `Your provider changed${previous.fromProvider ? ` from ${PROVIDER_NAME[previous.fromProvider]}` : ''} to ${now}. A conversation cannot be carried on by another provider, so this one is new.`
      : previous.reason === 'lost'
        ? 'Your earlier conversation on this card was lost (its file is gone or was never written), so this one is new.'
        : 'Your earlier conversation on this card ran in another working directory, so it cannot be carried on here and this one is new.';
  return [
    '## Previous conversation',
    what,
    ...summaryLines(previous.summary, 'the earlier'),
    ...(previous.lastNote
      ? [
          `The latest handoff note on this card, from ${code(previous.lastNote.from)} at ${previous.lastNote.endedAt}:`,
          quoted(previous.lastNote.text),
        ]
      : []),
  ].join('\n');
}

/**
 * The card handed over to the member (PM-342): who handed it over and when, the note they wrote or,
 * without one, why, and the state of the worktree. Shown in the kick-off brief and in the first
 * message of a resumed conversation, until the handover is taken over.
 */
export function handoffBlock(input: ContextPackInput): string | null {
  const handoff = input.handoff;
  if (!handoff) return null;
  const note = handoff.outcome === 'note' ? handoff.note?.trim() : null;
  const tree = [
    ...(handoff.branch ? [`branch ${code(handoff.branch)}`] : []),
    ...(handoff.lastCommit ? [`last commit ${code(handoff.lastCommit)}`] : []),
  ];
  return [
    '## Handoff',
    `This card was handed over to you by ${code(handoff.from)} (${PROVIDER_NAME[handoff.fromProvider]}) at ${handoff.endedAt}. You run on ${PROVIDER_NAME[handoff.toProvider]}.`,
    ...(tree.length > 0 ? [`Their work tree: ${tree.join(', ')}.`] : []),
    ...(handoff.uncommitted ? ['Uncommitted changes were left in the worktree.'] : []),
    ...(note
      ? [`Their handoff note:`, quoted(note)]
      : [
          `There is no handoff note: ${handoff.fallbackReason ? FALLBACK_REASON[handoff.fallbackReason] : 'none was written'}.`,
          ...summaryLines(handoff.summary, 'their'),
        ]),
  ].join('\n');
}

/** What a session is told when its card is being handed over (PM-342). */
export const handoffInstruction: ContextPackBuilder['handoffInstruction'] = (input) =>
  [
    `The card ${input.taskKey} is being handed over${input.to ? ` to ${code(input.to)}${input.toProvider ? ` (${PROVIDER_NAME[input.toProvider]})` : ''}` : ' to nobody for now'}.`,
    'Do not start new work.',
    'Commit your work on your own branch, then call the hand_off tool with a note: what is done, what is left, pitfalls, the files involved, open questions and the last commit. Name anything that stays uncommitted. The tool records the note and closes your session: do nothing after it.',
    ...(input.deadlineAt ? [`The note is due by ${input.deadlineAt}.`] : []),
    'If the receiver runs on another provider, they get only your note, not your conversation: write it so it stands alone.',
  ].join(' ');

/** What a session is told when the handover of its card is called off (PM-342). */
export const handoffCancelled: ContextPackBuilder['handoffCancelled'] = (input) =>
  `The handover of ${input.taskKey} is called off: the card stays with you. Carry on where you left off.`;
