import { z } from 'zod';
import { MemberHandle } from '../domain/member';

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
    via: z.literal('integrator').optional(),
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
  /^\[team message from ([a-z0-9-]+)(?<via> via integrator)?(?: about ([A-Z][A-Z0-9]{0,9}-\d+))?\]\n/;

export function formatInjectedTeamMessage(
  from: string,
  body: string,
  taskKey?: string | null,
  via?: 'integrator',
): string {
  return `[team message from ${from}${via ? ' via integrator' : ''}${taskKey ? ` about ${taskKey}` : ''}]\n${body}`;
}

/** Classifies user turns; an injected team message never masquerades as a human prompt. */
export function userTextOrigin(
  text: string,
  firstOrigin: 'brief' | 'human',
): 'brief' | 'human' | 'team_message' {
  return TEAM_MESSAGE_PREFIX_RE.test(text) ? 'team_message' : firstOrigin;
}
