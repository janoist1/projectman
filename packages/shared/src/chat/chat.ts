import { z } from 'zod';
import { MemberHandle } from '../domain/member';
import type { CardVersion, MessageKind, StaleReason } from '../domain/message';

/**
 * Normalised conversation items parsed from Claude Code transcripts (JSONL).
 * The web UI renders these as a chat; the raw terminal is available separately.
 */
const base = {
  /** Stable id (transcript entry uuid, suffixed for multi-block entries). */
  id: z.string(),
  ts: z.string(),
};

export const ChatItem = z.discriminatedUnion('kind', [
  z.object({
    ...base,
    kind: z.literal('user_text'),
    text: z.string(),
    origin: z.enum(['brief', 'human', 'team_message']).default('human'),
  }),
  z.object({ ...base, kind: z.literal('assistant_text'), text: z.string() }),
  z.object({
    ...base,
    kind: z.literal('tool_call'),
    toolUseId: z.string(),
    name: z.string(),
    /** One-line human summary, e.g. "npm run build" or "src/app.ts". */
    summary: z.string(),
    input: z.unknown(),
  }),
  z.object({
    ...base,
    kind: z.literal('tool_result'),
    toolUseId: z.string(),
    ok: z.boolean(),
    summary: z.string(),
  }),
  /** Team messages: "in" were injected into this session, "out" were sent via the team tools. */
  z.object({
    ...base,
    kind: z.literal('team_message'),
    direction: z.enum(['in', 'out']),
    from: MemberHandle,
    to: z.array(MemberHandle),
    text: z.string(),
  }),
  z.object({ ...base, kind: z.literal('system_note'), text: z.string() }),
]);
export type ChatItem = z.infer<typeof ChatItem>;

/**
 * Prefix put in front of team messages typed into a session, so the transcript parser
 * can recognise them: "[team message from qa about AR-21]\n<body>".
 */
export const TEAM_MESSAGE_PREFIX_RE =
  /^\[team message from ([a-z0-9-]+)(?: about ([A-Z][A-Z0-9]{0,9}-\d+))?\]\n/;

export function formatInjectedTeamMessage(from: string, body: string, taskKey?: string | null): string {
  return `[team message from ${from}${taskKey ? ` about ${taskKey}` : ''}]\n${body}`;
}

export const TEAM_MESSAGE_BATCH_PREFIX_RE = /^\[team messages(?: about ([A-Z][A-Z0-9]{0,9}-\d+))?\]\n/;
export interface TeamMessageBatchCard {
  stageId: string;
  stageName: string;
  commit: string | null;
  labels: string[];
}
export interface TeamMessageBatchItem {
  from: string;
  taskKey: string | null;
  body: string;
  kind: MessageKind;
  sentAt: string;
  version?: CardVersion;
  stale?: StaleReason;
  staleDetail?: string;
}

export function formatTeamMessageBatch(
  taskKey: string | null,
  card: TeamMessageBatchCard | null,
  items: TeamMessageBatchItem[],
): string {
  const staleCount = items.filter((item) => item.stale).length;
  const header = [
    `[team messages${taskKey ? ` about ${taskKey}` : ''}]`,
    ...(card
      ? [
          `The card now: stage ${card.stageName} (${card.stageId}), commit ${card.commit?.slice(0, 7) ?? 'unknown'}, labels: ${card.labels.join(', ') || 'none'}.`,
        ]
      : []),
    `${items.length} ${items.length === 1 ? 'message' : 'messages'} waited for you.${staleCount > 0 ? ` ${staleCount} ${staleCount === 1 ? 'is' : 'are'} out of date: read the out-of-date messages, but do not act on or answer those messages.` : ''}`,
  ].join('\n');
  const reasons = (item: TeamMessageBatchItem): string => {
    switch (item.stale) {
      case 'card_closed':
        return 'the card is closed';
      case 'stage_moved':
        return `the card has moved to ${item.staleDetail ?? 'another stage'}`;
      case 'superseded':
        return `${item.from} sent a newer request`;
      case 'sender_result':
        return `${item.from} has since recorded ${item.staleDetail ?? 'a result'} on the card`;
      case 'result_recorded':
        return 'you already recorded your result for this commit';
      case 'permission_closed':
        return 'the permission request no longer waits for you';
      default:
        return '';
    }
  };
  return [
    header,
    ...items.map((item) => {
      const version = item.version
        ? `at stage ${item.version.stageId}, commit ${item.version.commit?.slice(0, 7) ?? 'unknown'}, review commit ${item.version.reviewCommit?.slice(0, 7) ?? 'none'}`
        : 'version unknown';
      const meta = `${item.kind} · sent ${item.sentAt.slice(0, 16).replace('T', ' ')} UTC ${version}${item.stale ? ` · OUT OF DATE: ${reasons(item)}` : ''}`;
      return formatInjectedTeamMessage(item.from, `${meta}\n${item.body}`, item.taskKey);
    }),
  ].join('\n\n');
}

export function splitTeamMessageBatch(
  text: string,
): { header: string; items: { from: string; taskKey: string | null; body: string }[] } | null {
  if (!TEAM_MESSAGE_BATCH_PREFIX_RE.test(text)) return null;
  const markers = [
    ...text.matchAll(/^\[team message from ([a-z0-9-]+)(?: about ([A-Z][A-Z0-9]{0,9}-\d+))?\]\n/gm),
  ];
  const first = markers[0];
  if (!first) return null;
  return {
    header: text.slice(0, first.index).trimEnd(),
    items: markers.map((marker, index) => ({
      from: marker[1]!,
      taskKey: marker[2] ?? null,
      body: text.slice(marker.index! + marker[0].length, markers[index + 1]?.index ?? text.length).trimEnd(),
    })),
  };
}

/** Classifies user turns; an injected team message never masquerades as a human prompt. */
export function userTextOrigin(
  text: string,
  firstOrigin: 'brief' | 'human',
): 'brief' | 'human' | 'team_message' {
  return TEAM_MESSAGE_PREFIX_RE.test(text) || TEAM_MESSAGE_BATCH_PREFIX_RE.test(text)
    ? 'team_message'
    : firstOrigin;
}
