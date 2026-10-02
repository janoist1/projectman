import type { InboxItem, MemberStatus, MemberView, RoleView } from '@projectman/shared';
import type { IconName } from '../components/Icon';
import { t } from '../i18n/t';
import { aiRoleView, humanRoleName } from './roles';
import type { RoleTone } from './roles';

export type { RoleTone } from './roles';

/** Enough of a member to draw it; MemberView and member configs both fit. */
export interface MemberLike {
  handle: string;
  displayName: string;
  kind: 'human' | 'ai';
  role: string;
  specialty?: string | null;
}

export function toneFor(member: MemberLike | null | undefined): RoleTone {
  if (!member) return 'system';
  if (member.kind === 'human') return member.role === 'owner' ? 'owner' : 'human';
  return aiRoleView(member.role, member.specialty).tone;
}

export function iconFor(member: MemberLike | null | undefined): IconName {
  if (!member) return 'sparkle';
  if (member.kind === 'human') return 'user';
  return aiRoleView(member.role, member.specialty).icon;
}

/** "CR" for code-review, "FE" for fe-1, "K" for Kata, "TE" for yourself. */
export function initialsFor(
  member: MemberLike | null | undefined,
  isMe = false,
  fallbackHandle = '?',
): string {
  if (isMe) return t('common.youInitials');
  if (!member) return fallbackHandle.slice(0, 2).toUpperCase();
  const words = member.displayName.split(/[\s·_]+/).filter(Boolean);
  if (member.kind === 'human') {
    const letters = words.slice(0, 2).map((word) => word[0] ?? '');
    return letters.join('').toUpperCase() || member.handle.slice(0, 1).toUpperCase();
  }
  const parts = member.handle.split('-').filter((part) => /^[a-z]+$/.test(part));
  if (parts.length >= 2) return `${parts[0]![0]}${parts[1]![0]}`.toUpperCase();
  if (parts.length === 1 && parts[0]!.length <= 2) return parts[0]!.toUpperCase();
  if (words.length >= 2) return `${words[0]![0]}${words[1]![0]}`.toUpperCase();
  return (words[0] ?? member.handle).slice(0, 2).toUpperCase();
}

/** Role label in the UI language: "Tulajdonos", "Code review", "Frontend fejlesztő". */
export function roleLabel(
  member: MemberLike | null | undefined,
  catalogue: readonly RoleView[] = [],
): string {
  if (!member) return '';
  return member.kind === 'human'
    ? humanRoleName(member.role)
    : aiRoleView(member.role, member.specialty, catalogue).name;
}

export type MemberIndex = ReadonlyMap<string, MemberView>;

export function indexMembers(members: readonly MemberView[] | undefined): MemberIndex {
  return new Map((members ?? []).map((member) => [member.handle, member]));
}

/** Display name, with "Te" for the current user. */
export function nameOf(
  handle: string | null | undefined,
  index: MemberIndex,
  myHandle: string | null,
): string {
  if (!handle) return t('common.system');
  if (handle === myHandle) return t('common.you');
  return index.get(handle)?.displayName ?? handle;
}

export function namesOf(handles: readonly string[], index: MemberIndex, myHandle: string | null): string[] {
  return handles.map((handle) => nameOf(handle, index, myHandle));
}

/** Open inbox items raised by this member that are assigned to me. */
export function isWaitingForMe(
  member: MemberView,
  inbox: readonly InboxItem[] | undefined,
  myHandle: string | null,
): boolean {
  if (!inbox || !myHandle) return false;
  return inbox.some(
    (item) => item.state === 'open' && item.source === member.handle && item.assignees.includes(myHandle),
  );
}

/** Status key for data-status plus its label; "waiting for a human" becomes "Rád vár" when it is you. */
export function memberStatusView(
  member: MemberView,
  inbox: readonly InboxItem[] | undefined,
  myHandle: string | null,
): { status: MemberStatus | 'needs_you'; label: string } {
  if (member.status === 'waiting_for_human' && isWaitingForMe(member, inbox, myHandle)) {
    return { status: 'needs_you', label: t('memberStatus.needsYou') };
  }
  return { status: member.status, label: t(`memberStatus.${member.status}`) };
}

/**
 * Whose subscriptions run the AI members: `mixed` when more than one does (or some has none set),
 * else `only` is the one sponsor handle (null when no AI member has one). While mixed, `usual` is
 * the sponsor most of them share (null on a tie or when it is "none set"); the roster names the
 * others. One rule for the page subtitle and the roster.
 */
export function aiSponsors(members: readonly MemberView[]): {
  mixed: boolean;
  only: string | null;
  usual: string | null;
} {
  const counts = new Map<string, number>();
  for (const member of members)
    if (member.kind === 'ai') counts.set(member.sponsor || '', (counts.get(member.sponsor || '') ?? 0) + 1);
  const top = Math.max(0, ...counts.values());
  const leaders = [...counts].filter(([, count]) => count === top).map(([sponsor]) => sponsor);
  const mixed = counts.size > 1;
  return {
    mixed,
    only: counts.size === 1 ? [...counts.keys()][0] || null : null,
    usual: mixed && leaders.length === 1 ? leaders[0] || null : null,
  };
}

/** The cards a member works on right now (a running task session each), without repeats. */
export function workingCardKeys(member: Pick<MemberView, 'taskWork'>): string[] {
  return [...new Set((member.taskWork ?? []).map((work) => work.taskKey))];
}

/**
 * Who works on a card right now: the AI members with a running task session, in the team's order.
 * The same data the cards use for "X is working on it", so the board and its team strip agree.
 */
export function workingNow(members: readonly MemberView[]): MemberView[] {
  return members.filter((member) => member.kind === 'ai' && workingCardKeys(member).length > 0);
}

/**
 * The cards in one line, by how many there are: one with its title, two by key, more by the first
 * two keys and the rest counted. Null without a card (the caller says "no task").
 */
export function cardsLine(keys: readonly string[], titles: ReadonlyMap<string, string>): string | null {
  if (keys.length === 0) return null;
  if (keys.length === 1)
    return t('team.cardsOne', { key: keys[0]!, title: titles.get(keys[0]!) ?? '' }).trim();
  const shown = keys.slice(0, 2).join(t('common.listSeparator'));
  return keys.length === 2 ? shown : t('team.cardsMore', { keys: shown, more: keys.length - 2 });
}
