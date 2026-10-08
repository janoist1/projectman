import type { AgentProvider, HandoffFallbackReason, TaskHandoff } from '@projectman/shared';
import { t, tDynamic } from '../i18n/t';
import { nameOf } from './members';
import type { MemberIndex } from './members';

/** The display name of a provider ("Claude", "Codex"). */
export function providerName(provider: AgentProvider | string): string {
  return tDynamic(`providers.${provider}`, provider);
}

/** "Claude → Codex" when the two differ, else null: a chip is only drawn for a change of provider. */
export function providerShift(from: AgentProvider, to: AgentProvider | null): string | null {
  return to && from !== to
    ? t('handoff.providerShift', { from: providerName(from), to: providerName(to) })
    : null;
}

/** The mark a member's option wears when its provider cannot go on with the old assignee's conversation. */
export function otherProviderSuffix(): string {
  return ` · ${t('handoff.otherProvider')}`;
}

/**
 * Why there is no note, as a part of a sentence ("Nem volt leadás: …"; PM-342). One key set serves
 * the toast, the box, the window and the timeline; no reason, or one from a newer server, reads
 * "nem volt leadás".
 */
export function fallbackReasonText(
  reason: HandoffFallbackReason | string | undefined,
  from: string | null | undefined,
  members: MemberIndex,
  myHandle: string | null,
): string {
  const unknown = t('handoff.fallbackReason.unknown');
  if (!reason) return unknown;
  return tDynamic(`handoff.fallbackReason.${reason}`, unknown, { from: nameOf(from, members, myHandle) });
}

/** The most characters of a handoff note a timeline row shows before it is cut. */
const EXCERPT_MAX = 120;

/** A Markdown line as plain text: no heading, quote or list marker, no emphasis or code marks. */
function plainLine(line: string): { text: string; heading: boolean } {
  const heading = /^\s{0,3}#{1,6}\s/.test(line);
  const text = line
    .replace(/^\s{0,3}(#{1,6}|>+|[-*+]|\d+[.)])\s+/, '')
    .replace(/(\*\*|__|`)/g, '')
    .trim();
  return { text, heading };
}

/**
 * The start of a note as plain text for a timeline row, cut to a short length with an ellipsis.
 * It is the first line; a heading is joined with the line under it ("Állapot · A kosár kész").
 */
export function noteExcerpt(note: string): string {
  const lines = note
    .split(/\r?\n/)
    .map(plainLine)
    .filter((line) => line.text !== '');
  const first = lines[0];
  if (!first) return '';
  const excerpt = first.heading && lines[1] ? `${first.text} · ${lines[1].text}` : first.text;
  return excerpt.length > EXCERPT_MAX ? `${excerpt.slice(0, EXCERPT_MAX - 1)}…` : excerpt;
}

/** The member name of a handoff end, or "nincs felelős" when the card goes to nobody. */
export function handoffEndName(
  handle: string | null | undefined,
  members: MemberIndex,
  myHandle: string | null,
): string {
  return handle ? nameOf(handle, members, myHandle) : t('handoff.noOne');
}

/** "A → B" for the two ends of a handoff. */
export function handoffPair(
  handoff: { from: string; to: string | null },
  members: MemberIndex,
  myHandle: string | null,
): string {
  return t('handoff.pair', {
    from: nameOf(handoff.from, members, myHandle),
    to: handoffEndName(handoff.to, members, myHandle),
  });
}

/**
 * The milliseconds left of an open handoff's time at `now`: null while no clock runs (paused,
 * closing), 0 when it ran out.
 */
export function handoffMsLeft(handoff: Pick<TaskHandoff, 'deadlineAt'>, now: number): number | null {
  if (!handoff.deadlineAt) return null;
  return Math.max(0, Date.parse(handoff.deadlineAt) - now);
}

/** Which step line a handoff shows. */
export type HandoffLine = 'waiting_point' | 'writing' | 'closing_timeout' | 'closing_reason' | 'closing_note';

/** A waiting or writing handoff whose time ran out reads as a closing one that timed out. */
export function handoffLine(handoff: TaskHandoff, now: number): HandoffLine {
  if (handoff.step === 'closing') {
    if (handoff.fallbackReason === 'timeout') return 'closing_timeout';
    return handoff.fallbackReason ? 'closing_reason' : 'closing_note';
  }
  if (handoff.step !== 'paused' && handoffMsLeft(handoff, now) === 0) return 'closing_timeout';
  return handoff.step === 'writing' ? 'writing' : 'waiting_point';
}
