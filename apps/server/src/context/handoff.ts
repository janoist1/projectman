import { DEFAULT_AGENT_PROVIDER } from '@projectman/shared';
import type { AgentProvider, HandoffFallbackReason, HandoffSummary } from '@projectman/shared';
import type { ContextPackBuilder, ContextPackInput } from '../contracts';
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

function summaryLines(summary: HandoffSummary | null, whose: string): string[] {
  if (!summary) return [`No summary of ${whose} conversation is available.`];
  const source =
    summary.source === 'compact'
      ? "the conversation's own compaction summary and the replies after it"
      : 'the last replies of the conversation';
  return [
    `A machine-made summary of ${whose} conversation follows (${source}${summary.at ? `, up to ${summary.at}` : ''}). It may be incomplete: check the card, its notes and the worktree (git log, git status) before you rely on it.`,
    quoted(summary.text),
  ];
}

/**
 * Why the conversation of the new session is not the old one (PM-342), with the machine-made summary
 * of the old one when there is one and the card's latest handoff note. Null unless this new
 * conversation replaces one.
 */
export function previousConversationBlock(input: ContextPackInput): string | null {
  const previous = input.previousConversation;
  if (!previous) return null;
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
    'Commit your work on your own branch, then call the hand_off tool with a note: what is done, what is left, pitfalls, the files involved, open questions and the last commit. Name anything that stays uncommitted.',
    ...(input.deadlineAt ? [`The note is due by ${input.deadlineAt}.`] : []),
    'If the receiver runs on another provider, they get only your note, not your conversation: write it so it stands alone.',
  ].join(' ');

/** What a session is told when the handover of its card is called off (PM-342). */
export const handoffCancelled: ContextPackBuilder['handoffCancelled'] = (input) =>
  `The handover of ${input.taskKey} is called off: the card stays with you. Carry on where you left off.`;
