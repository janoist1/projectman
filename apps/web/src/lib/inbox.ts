import {
  alertPayloadOf,
  BoundaryRequest,
  fixLimitDecisionOf,
  loopDecisionOf,
  permissionDelegationOf,
  questionPayloadOf,
  seniorWaitDecisionOf,
} from '@projectman/shared';
import type { InboxItem, InboxOption, LabelView, WorkItemRef } from '@projectman/shared';
import { formatStamp, formatTokens } from '../i18n/format';
import { joinNames, t, tDynamic } from '../i18n/t';
import { toolPresentationFor } from './chat';
import { labelName } from './labels';
import { nameOf, namesOf } from './members';
import type { MemberIndex } from './members';
import { fixRoundParts } from './fixLimit';
import { pairText, watcherName } from './loop';
import type { PipelineIndex } from './pipeline';

/** Option id used for a free-text answer to a question (the text goes in `note`). */
export const FREE_ANSWER_OPTION_ID = 'answer';

const BUILT_IN_OPTIONS = [
  'allow',
  'allow_session',
  'deny',
  'approve',
  'reject',
  'answer',
  'seen',
  'stop_work',
  'let_run',
  'replan',
  'reassign',
  'another_round',
  'wait_for_senior',
  'any_developer',
] as const;
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
  if (item.kind === 'boundary') return t('boundary.heading');
  if (loopDecisionOf(item)) return t('inbox.loop.heading');
  if (fixLimitDecisionOf(item)) return t('inbox.fixLimit.heading');
  if (seniorWaitDecisionOf(item)) return t('inbox.seniorWait.heading');
  if (item.kind === 'alert') {
    const alert = alertPayloadOf(item);
    return alert ? t(`inbox.alerts.${alert.alert}.heading`) : t('inbox.alerts.unknown');
  }
  if (item.kind === 'permission') {
    const tool = permissionTool(item);
    if (tool && (item.title === tool || item.title.startsWith(`${tool}:`))) {
      const summary =
        typeof item.payload.summary === 'string' ? item.payload.summary : (permissionCommand(item) ?? '');
      return t('inbox.permissionHeading', { tool: toolPresentationFor(tool, summary).label });
    }
  }
  if (item.kind === 'question') return splitQuestion(item.title).title ?? t('inbox.question.untitled');
  return item.title;
}

/** A one-line question up to this many plain characters stays whole, as the heading. */
const SHORT_QUESTION_LIMIT = 140;
/** A question mark later than this in the first line does not end the heading. */
const QUESTION_MARK_LIMIT = 220;
/** The abbreviations of the UI language, whose full stop does not end a sentence. */
const abbreviations = () => t('inbox.question.abbreviations').split(' ');
const LIST_OR_CODE = /^\s*([-*•]|\d+[.)])\s+|^```/;
const EMPHASIS_OR_LINK = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|\[[^\]]+\]\((https?:\/\/[^)\s]+)\))/g;

/** Text without the inline markdown marks: emphasis and code lose their marks, a link keeps its label. */
function plainMarkdown(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*\s][^*]*)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

interface InlineSpan {
  start: number;
  end: number;
  /** Code and links: no cut falls inside. Emphasis: a cut inside extends to its end. */
  opaque: boolean;
}

function inlineSpans(line: string): InlineSpan[] {
  return [...line.matchAll(EMPHASIS_OR_LINK)].map((match) => {
    const start = match.index ?? 0;
    return {
      start,
      end: start + match[0].length,
      opaque: match[0].startsWith('`') || match[0].startsWith('['),
    };
  });
}

/** Where the heading ends for a sentence mark at `index`; null when the mark is inside code or a link. */
function cutAfter(line: string, index: number, spans: readonly InlineSpan[]): number | null {
  const inside = spans.find((span) => index >= span.start && index < span.end);
  if (inside?.opaque) return null;
  let cut = inside ? inside.end : index + 1;
  while (cut < line.length && /[”"')»]/.test(line.charAt(cut))) cut += 1;
  return cut;
}

function sentenceEnd(line: string): number {
  const spans = inlineSpans(line);
  for (let q = line.indexOf('?'); q >= 0 && q < QUESTION_MARK_LIMIT; q = line.indexOf('?', q + 1)) {
    const cut = cutAfter(line, q, spans);
    if (cut !== null && (cut >= line.length || /\s/.test(line.charAt(cut)))) return cut;
  }
  for (const match of line.matchAll(/[.!]/g)) {
    const index = match.index ?? 0;
    const cut = cutAfter(line, index, spans);
    if (cut === null) continue;
    // Not a sentence end: "v1.2", "e-mail.hu".
    if (cut < line.length && !/\s/.test(line.charAt(cut))) continue;
    const before = line.slice(0, index);
    // Dates and numbered items: "2026. október".
    if (/\d$/.test(before)) continue;
    const word = /(\p{L}+)$/u.exec(before)?.[1] ?? '';
    if (abbreviations().includes(word.toLowerCase())) continue;
    const next = line.slice(cut).trimStart().charAt(0);
    // The next sentence starts with a capital or a mark.
    if (next && !/[\p{Lu}*`„"\d]/u.test(next)) continue;
    return cut;
  }
  return line.length;
}

/**
 * Splits the text of a question into a short plain-text heading and a markdown body. A short
 * one-line question is all heading. Otherwise the heading is the first line up to its first question
 * mark (or its first sentence), never cut inside emphasis, code or a link. A question that starts
 * with a list or a code block has no heading (null): the whole text is the body.
 */
export function splitQuestion(text: string): { title: string | null; body: string | null } {
  const source = text.replace(/\r\n/g, '\n').trim();
  const lines = source.split('\n');
  const first = lines[0] ?? '';
  const rest = lines.slice(1).join('\n');
  // A short date-led question is a heading, even though its year resembles a list marker.
  if (
    lines.length === 1 &&
    /^\d{4}\.\s+\p{L}/u.test(first) &&
    plainMarkdown(source).length <= SHORT_QUESTION_LIMIT
  ) {
    return { title: plainMarkdown(source), body: null };
  }
  // A list, a code block or a heading line is checked first: a short one-line question may be one too.
  if (LIST_OR_CODE.test(first)) return { title: null, body: source };
  const heading = /^#{1,4}\s+(.*)$/.exec(first);
  if (heading) return { title: plainMarkdown(heading[1] ?? '') || null, body: rest.trim() || null };
  if (lines.length === 1 && plainMarkdown(source).length <= SHORT_QUESTION_LIMIT) {
    return { title: plainMarkdown(source) || null, body: null };
  }
  const cut = sentenceEnd(first);
  const title = plainMarkdown(first.slice(0, cut));
  if (!title) return { title: null, body: source };
  const tail = first.slice(cut).trim();
  const body = [tail, rest]
    .filter((part) => part.trim() !== '')
    .join(tail ? '\n' : '')
    .trim();
  return { title, body: body || null };
}

/** What a question from an AI member shows besides its heading and its options' own text. */
export interface QuestionExtras {
  /** Id of the option the member recommends; null when it recommends none that exists. */
  recommendedOptionId: string | null;
  /** One sentence: why that option. Shown with the recommended option. */
  recommendationReason: string | null;
  /** Markdown technical background, shown folded. */
  details: string | null;
}

/**
 * The recommendation and the details of a question. Questions from before these fields existed,
 * and every other kind of item, have none, and render as they always did.
 */
export function questionExtras(item: InboxItem): QuestionExtras {
  const payload = item.kind === 'question' ? questionPayloadOf(item) : null;
  const recommended = payload?.recommended;
  // A recommendation that names no option of the item cannot be marked, so it is left out.
  const recommendedOptionId =
    recommended !== undefined && item.options.some((option) => option.id === recommended)
      ? recommended
      : null;
  return {
    recommendedOptionId,
    recommendationReason: recommendedOptionId ? payload?.recommendationReason?.trim() || null : null,
    details: payload?.details?.trim() || null,
  };
}

function workText(workItem: WorkItemRef): string {
  return workItem.type === 'task'
    ? t('inbox.alerts.work.task', { key: workItem.taskKey })
    : t(`inbox.alerts.work.${workItem.type}`);
}

function gigabytes(bytes: number): string {
  return t('settings.limits.minFreeDiskValue', { count: (bytes / 1024 ** 3).toFixed(1).replace('.', ',') });
}

/**
 * What an alert says, from its payload: for a session over the token warning limit (PM-187) the
 * member, the card or chat, when the session started, what it used and the limit; for a message
 * storm on a card (PM-186) the card, the count, the window and who took part. Null for an item that
 * is no alert, or an alert of a kind this web app does not know.
 */
export function alertText(
  item: InboxItem,
  members: MemberIndex,
  myHandle: string | null,
  labels: readonly LabelView[] = [],
): string | null {
  const alert = alertPayloadOf(item);
  if (!alert) return null;
  if (alert.alert === 'provider_rate_limited')
    return t(
      alert.until ? 'inbox.alerts.provider_rate_limited.body' : 'inbox.alerts.provider_rate_limited.unknown',
      {
        provider: t(`providers.${alert.provider}`),
        member: nameOf(item.source, members, myHandle),
        until: alert.until ? formatStamp(alert.until) : '',
        message: alert.message,
      },
    );
  if (alert.alert === 'message_burst')
    return t('inbox.alerts.message_burst.body', {
      key: alert.taskKey,
      count: alert.count,
      minutes: alert.minutes,
      members: joinNames(namesOf(alert.members, members, myHandle)),
    });
  if (alert.alert === 'refinement')
    return t(`inbox.alerts.refinement.${alert.reason}`, {
      key: alert.taskKey,
      label: alert.label ? labelName(alert.label, labels) : '',
    });
  if (alert.alert === 'disk_low')
    return t('inbox.alerts.disk_low.body', {
      free: gigabytes(alert.freeBytes),
      threshold: gigabytes(alert.thresholdBytes),
    });
  if (alert.alert === 'worktree_kept')
    return t('inbox.alerts.worktree_kept.body', {
      key: alert.taskKey,
      path: alert.path,
      changes: alert.changes,
    });
  if (alert.alert === 'session_input')
    return t('inbox.alerts.session_input.body', {
      member: nameOf(item.source, members, myHandle),
      work: workText(alert.workItem),
      since: formatStamp(alert.since),
      minutes: alert.minutes,
      activity: alert.activity ?? t('inbox.alerts.session_input.noActivity'),
    });
  return t('inbox.alerts.session_tokens.body', {
    member: nameOf(item.source, members, myHandle),
    work: workText(alert.workItem),
    started: formatStamp(alert.sessionStartedAt),
    counted: formatTokens(alert.countedTokens),
    limit: formatTokens(alert.limitTokens),
  });
}

/**
 * What a loop decision says (PM-261): the card, who wrote to each other, how many messages in how
 * long, and why it came to the viewer. Null for an item that is no loop decision.
 */
export function loopDecisionText(
  item: InboxItem,
  members: MemberIndex,
  myHandle: string | null,
): string | null {
  const loop = loopDecisionOf(item);
  if (!loop) return null;
  return t('inbox.loop.body', {
    key: loop.taskKey,
    pair: pairText(loop.members, members, myHandle),
    minutes: loop.minutes,
    count: loop.count,
    reason:
      loop.reason === 'continued'
        ? t('inbox.loop.reasons.continued', { name: watcherName(loop.watcher, members, myHandle) })
        : t('inbox.loop.reasons.no_watcher'),
  });
}

/**
 * What a fix round limit decision says (PM-262): the card, the rounds and what they were, and why it
 * came to the viewer. Null for an item that is no such decision.
 */
export function fixLimitDecisionText(
  item: InboxItem,
  members: MemberIndex,
  myHandle: string | null,
): string | null {
  const limit = fixLimitDecisionOf(item);
  if (!limit) return null;
  const note = limit.note?.trim();
  return t('inbox.fixLimit.body', {
    key: limit.taskKey,
    rounds: limit.rounds,
    parts: fixRoundParts(limit),
    reason:
      limit.reason === 'passed_on'
        ? t('inbox.fixLimit.reasons.passed_on', {
            name: nameOf(limit.decider, members, myHandle),
            note: note ? t('inbox.fixLimit.note', { note }) : '',
          })
        : t(`inbox.fixLimit.reasons.${limit.reason}`),
  });
}

/**
 * What a Senior wait decision says (PM-349): the card, how long it has waited, which Seniors are busy,
 * and the reason of the recommendation when there is one. Null for an item that is no such decision.
 */
export function seniorWaitDecisionText(
  item: InboxItem,
  members: MemberIndex,
  myHandle: string | null,
): string | null {
  const wait = seniorWaitDecisionOf(item);
  if (!wait) return null;
  const reason = wait.reason?.trim();
  return t('inbox.seniorWait.body', {
    key: wait.taskKey,
    minutes: wait.minutes,
    names: joinNames(namesOf(wait.seniors, members, myHandle)),
    reason: reason ? t('inbox.seniorWait.reason', { reason }) : '',
  });
}

const LOOP_OPTIONS = ['stop_work', 'let_run'];
const FIX_LIMIT_OPTIONS = ['replan', 'reassign', 'another_round'];
const SENIOR_WAIT_OPTION_IDS = ['wait_for_senior', 'any_developer'];

/** The options of a loop, fix round limit or Senior wait decision with what each one leads to; other items keep theirs. */
export function withConsequences(item: InboxItem, options: readonly InboxOption[]): InboxOption[] {
  const group = loopDecisionOf(item)
    ? { ids: LOOP_OPTIONS, scope: 'loop' }
    : fixLimitDecisionOf(item)
      ? { ids: FIX_LIMIT_OPTIONS, scope: 'fixLimit' }
      : seniorWaitDecisionOf(item)
        ? { ids: SENIOR_WAIT_OPTION_IDS, scope: 'seniorWait' }
        : null;
  if (!group) return [...options];
  return options.map((option) =>
    group.ids.includes(option.id)
      ? { ...option, consequence: tDynamic(`inbox.${group.scope}.consequence.${option.id}`, '') }
      : option,
  );
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
  const loop = loopDecisionOf(item);
  if (loop) return t('inbox.loop.subject', { key: loop.taskKey });
  const fixLimit = fixLimitDecisionOf(item);
  if (fixLimit) return t('inbox.fixLimit.subject', { key: fixLimit.taskKey });
  const seniorWait = seniorWaitDecisionOf(item);
  if (seniorWait) return t('inbox.seniorWait.subject', { key: seniorWait.taskKey });
  if (item.kind === 'question') return inboxHeading(item);
  return item.title;
}

/** One line of a history list: what was decided · who asked · for which task ("Engedélyezve · Senior Fejlesztő · PM-141"). */
export function decisionLine(item: InboxItem, members: MemberIndex, myHandle: string | null): string {
  // The system raised some items itself (a loop, a fix round limit): its source is no member's handle.
  const source = item.source === 'system' ? null : item.source;
  return [resolutionLabel(item), nameOf(source, members, myHandle), item.taskKey]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
}

export function boundaryOf(item: InboxItem): BoundaryRequest | null {
  const parsed = item.kind === 'boundary' ? BoundaryRequest.safeParse(item.payload.boundary) : null;
  return parsed?.success ? parsed.data : null;
}

const OWNER_CATEGORIES = ['cost', 'production', 'credentials', 'host_expansion'] as const;

/**
 * Who has a permission question and why, when it did not go the plain way (the AI decider, PM-169):
 * with the decider and until when; or with a person because the decider passed it on or did not answer
 * in time; or because it is one an AI never decides. Null for any other item.
 */
export function delegationNote(
  item: InboxItem,
  members: MemberIndex,
  myHandle: string | null,
): string | null {
  if (item.kind !== 'permission') return null;
  const delegation = permissionDelegationOf(item);
  if (delegation?.state === 'pending_lead')
    return t('inbox.delegation.pendingLead', {
      names: joinNames(namesOf(delegation.leads, members, myHandle)),
      time: new Date(delegation.leadDeadline).toLocaleTimeString('hu-HU', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }),
    });
  const escalation = delegation?.escalation;
  if (escalation?.cause === 'lead')
    return t('inbox.delegation.escalatedLead', {
      who: nameOf(escalation.by, members, myHandle),
      reason: escalation.reason ?? '',
    }).trim();
  if (escalation) return t('inbox.delegation.escalatedTimeout');
  const category = OWNER_CATEGORIES.find((known) => known === item.payload.ownerCategory);
  return category
    ? t('inbox.delegation.ownerCategory', { category: t(`boundary.categories.${category}`) })
    : null;
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
/** A permission the system decided by itself (a command-policy rule, or the system in older records). */
export function isAutomaticDecision(item: InboxItem): boolean {
  return (
    item.kind === 'permission' &&
    item.state === 'resolved' &&
    (item.resolution?.rule !== undefined || item.resolution?.by === 'system')
  );
}

export function resolutionLabel(item: InboxItem): string {
  if (item.state === 'expired') return t('inbox.resolutions.expired');
  if (item.state === 'cancelled') return t('inbox.resolutions.cancelled');
  if (item.resolution?.rule === 'loop_ended') return t('inbox.resolutions.loop_ended');
  if (item.resolution?.rule === 'fix_limit_ended') return t('inbox.resolutions.fix_limit_ended');
  if (item.resolution?.rule === 'senior_took') return t('inbox.resolutions.senior_took');
  if (item.resolution?.rule === 'senior_wait_ended') return t('inbox.resolutions.senior_wait_ended');
  const optionId = item.resolution?.optionId;
  if (!optionId) return t('inbox.resolutions.answer');
  if (isAutomaticDecision(item) && (optionId === 'allow' || optionId === 'deny'))
    return t(`inbox.resolutions.automatic_${optionId}`);
  if (isBuiltIn(optionId)) return t(`inbox.resolutions.${optionId}`);
  const option = item.options.find((entry) => entry.id === optionId);
  return option ? t('inbox.resolutions.option', { label: option.label }) : t('inbox.resolutions.answer');
}

/** The short notice after the viewer's own decision went through: "Engedélyezve", "Válasz: B". */
export function decisionToast(item: InboxItem, optionId: string, myHandle: string | null): string {
  const loop = loopDecisionOf(item);
  if (loop && (optionId === 'stop_work' || optionId === 'let_run'))
    return t(`inbox.loop.toast.${optionId}`, { key: loop.taskKey });
  const fixLimit = fixLimitDecisionOf(item);
  if (fixLimit && FIX_LIMIT_OPTIONS.includes(optionId))
    return t(`inbox.fixLimit.toast.${optionId as 'replan' | 'reassign' | 'another_round'}`, {
      key: fixLimit.taskKey,
    });
  const seniorWait = seniorWaitDecisionOf(item);
  if (seniorWait && SENIOR_WAIT_OPTION_IDS.includes(optionId))
    return t(`inbox.seniorWait.toast.${optionId as 'wait_for_senior' | 'any_developer'}`, {
      key: seniorWait.taskKey,
    });
  return resolutionLabel({
    ...item,
    state: 'resolved',
    resolution: { optionId, by: myHandle ?? item.source, at: item.createdAt, note: null },
  });
}

/** Who decided: the rule the system decided by, "Rendszer" for older automatic decisions, or the member. */
export function resolverName(item: InboxItem, members: MemberIndex, myHandle: string | null): string {
  const resolution = item.resolution;
  if (resolution?.via) return t('involvement.integratorFull');
  if (resolution?.rule) return t(`inbox.resolutionRules.${resolution.rule}`);
  return nameOf(resolution && resolution.by !== 'system' ? resolution.by : null, members, myHandle);
}

/** The note written with the decision (an answer, or an older automatic decision's note), or null. */
export function resolutionNote(item: InboxItem): string | null {
  if (item.kind === 'question' && item.resolution?.via && item.resolution.note?.trim())
    return `${t('integratorKey.forwarded')}: ${item.resolution.note.trim()}`;
  if (item.kind === 'boundary' && item.resolution?.note)
    return tDynamic(`boundary.reasons.${item.resolution.note}`, item.resolution.note);
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
