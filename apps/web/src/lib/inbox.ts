import type { InboxItem, InboxOption } from '@projectman/shared';
import { t } from '../i18n/t';
import { toolPresentationFor } from './chat';
import { nameOf } from './members';
import type { MemberIndex } from './members';
import type { PipelineIndex } from './pipeline';

/** Option id used for a free-text answer to a question (the text goes in `note`). */
export const FREE_ANSWER_OPTION_ID = 'answer';

const BUILT_IN_OPTIONS = ['allow', 'allow_session', 'deny', 'approve', 'reject', 'answer'] as const;
type BuiltInOption = (typeof BUILT_IN_OPTIONS)[number];

function isBuiltIn(id: string): id is BuiltInOption {
  return (BUILT_IN_OPTIONS as readonly string[]).includes(id);
}

/** Built-in option ids are translated (the server repeats the id as label); agent options are shown as sent. */
export function optionLabel(option: InboxOption): string {
  return isBuiltIn(option.id) ? t(`inbox.options.${option.id}`) : option.label;
}

/**
 * Heading of an item. Permission requests arrive titled "<Tool>: <command>"; the command is
 * shown in monospace anyway, so the heading names the kind of tool instead.
 */
export function inboxHeading(item: InboxItem): string {
  if (item.kind === 'permission') {
    const tool = permissionTool(item);
    if (tool && (item.title === tool || item.title.startsWith(`${tool}:`))) {
      const summary =
        typeof item.payload.summary === 'string' ? item.payload.summary : (permissionCommand(item) ?? '');
      return t('inbox.permissionHeading', { tool: toolPresentationFor(tool, summary).label });
    }
  }
  return item.title;
}

interface GatePayload {
  fromStageId?: unknown;
  toStageId?: unknown;
}

/** "Továbblépés: Merge → Élesítés" for gate approval decisions. */
export function gateMoveText(item: InboxItem, pipeline: PipelineIndex | null | undefined): string | null {
  const gate = item.payload.gate as GatePayload | undefined;
  if (!gate || typeof gate !== 'object' || typeof gate.toStageId !== 'string') return null;
  const name = (id: unknown) => (typeof id === 'string' ? (pipeline?.stageById.get(id)?.name ?? id) : '');
  return t('inbox.gateMove', { from: name(gate.fromStageId), to: name(gate.toStageId) });
}

/** Short text of what was decided, for history lists. */
export function decisionSubject(item: InboxItem): string {
  if (item.kind === 'permission') return permissionCommand(item) ?? item.title;
  return item.title;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function permissionTool(item: InboxItem): string | null {
  const name = item.payload.toolName;
  return typeof name === 'string' ? name : null;
}

/** The command or target of a permission request, for a monospace preview. */
export function permissionCommand(item: InboxItem): string | null {
  const input = record(item.payload.toolInput);
  if (!input) return null;
  for (const field of ['command', 'file_path', 'path', 'url', 'pattern']) {
    const value = input[field];
    if (typeof value === 'string' && value.trim()) return value;
  }
  const json = JSON.stringify(input);
  return json === '{}' ? null : json;
}

/** Monospace detail of decisions and approvals when the payload carries one. */
export function payloadCode(item: InboxItem): string | null {
  if (item.kind === 'permission') return permissionCommand(item);
  for (const field of ['command', 'code', 'diff']) {
    const value = item.payload[field];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

/** "git push" out of "git push origin 21-confirmation-pages". */
export function shortCommand(command: string | null): string | null {
  if (!command) return null;
  // A directory change only sets up the command people are being asked to approve.
  const substantive = command
    .trim()
    .replace(/^(?:cd\s+(?:'[^']*'|"(?:\\.|[^"\\])*"|(?:\\.|[^\s'";&|])+)[ \t]*&&\s*)+/, '');
  const words = substantive.split(/\s+/);
  const first = words[0] ?? '';
  if (
    words.length > 1 &&
    /^[a-z][\w-]*$/.test(words[1] ?? '') &&
    ['git', 'npm', 'gh', 'docker', 'yarn', 'pnpm', 'make', 'kubectl'].includes(first)
  ) {
    return `${first} ${words[1]}`;
  }
  return first.length > 32 ? `${first.slice(0, 31)}…` : first;
}

/** How an item was closed: "Engedélyezve", "Válasz: B", "Lejárt". */
export function resolutionLabel(item: InboxItem): string {
  if (item.state === 'expired') return t('inbox.resolutions.expired');
  if (item.state === 'cancelled') return t('inbox.resolutions.cancelled');
  const optionId = item.resolution?.optionId;
  if (!optionId) return t('inbox.resolutions.answer');
  if (
    item.kind === 'permission' &&
    (item.resolution?.rule !== undefined || item.resolution?.by === 'system') &&
    (optionId === 'allow' || optionId === 'deny')
  )
    return t(`inbox.resolutions.automatic_${optionId}`);
  if (isBuiltIn(optionId)) return t(`inbox.resolutions.${optionId}`);
  const option = item.options.find((entry) => entry.id === optionId);
  return option ? t('inbox.resolutions.option', { label: option.label }) : t('inbox.resolutions.answer');
}

/** Who decided: the rule the system decided by, "Rendszer" for older automatic decisions, or the member. */
export function resolverName(item: InboxItem, members: MemberIndex, myHandle: string | null): string {
  const resolution = item.resolution;
  if (resolution?.rule) return t(`inbox.resolutionRules.${resolution.rule}`);
  return nameOf(resolution && resolution.by !== 'system' ? resolution.by : null, members, myHandle);
}

/** The note written with the decision (an answer, or an older automatic decision's note), or null. */
export function resolutionNote(item: InboxItem): string | null {
  return item.resolution?.note?.trim() || null;
}

export function isPositiveResolution(item: InboxItem): boolean {
  const optionId = item.resolution?.optionId;
  return item.state === 'resolved' && optionId !== 'deny' && optionId !== 'reject';
}

export function openItems(items: readonly InboxItem[] | undefined): InboxItem[] {
  return (items ?? []).filter((item) => item.state === 'open');
}

export function isAssignedTo(item: InboxItem, handle: string | null): boolean {
  return !handle || item.assignees.includes(handle);
}

/** Ids of every open item (the timeline marks requests that still wait). */
export function openItemIds(items: readonly InboxItem[] | undefined): Set<string> {
  return new Set(openItems(items).map((item) => item.id));
}

/** Open items waiting for this member (every open item when the handle is unknown). */
export function openItemsFor(items: readonly InboxItem[] | undefined, handle: string | null): InboxItem[] {
  return openItems(items).filter((item) => isAssignedTo(item, handle));
}

export function newestFirst<T extends { createdAt: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Where "Részletek" leads: the session that asked, else the task. */
export function detailsHrefFor(item: InboxItem, projectKey: string): string | null {
  if (item.sessionId) return `/p/${projectKey}/sessions/${item.sessionId}`;
  if (item.taskKey) return `/p/${projectKey}/tasks/${item.taskKey}`;
  return null;
}
