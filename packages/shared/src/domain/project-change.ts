import { z } from 'zod';

/**
 * The durable project change journal (PM-761). An entry says only that something changed; the
 * content is read again through the existing reading API. Raw terminal, chat and secret data never
 * go in.
 */
const PROJECT_CHANGE_KINDS = [
  'task',
  'timeline',
  'message',
  'inbox',
  'configuration',
  'pause',
  'engine',
  'handoff',
  'operation',
] as const;
export const ProjectChangeKind = z.enum(PROJECT_CHANGE_KINDS);
export type ProjectChangeKind = z.infer<typeof ProjectChangeKind>;

export const ProjectChangeEvent = z.object({
  /** Opaque: pass it as `after` to continue right behind this entry. */
  cursor: z.string(),
  projectKey: z.string(),
  kind: ProjectChangeKind,
  entityId: z.string().nullable(),
  at: z.string(),
});
export type ProjectChangeEvent = z.infer<typeof ProjectChangeEvent>;

const PROJECT_CHANGE_MAX_LIMIT = 500;
const PROJECT_CHANGE_DEFAULT_LIMIT = 100;
export const PROJECT_CHANGE_MAX_WAIT_MS = 25_000;

/** Query of `GET /api/projects/:key/events`. */
export const ProjectChangeEventsQuery = z.object({
  after: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(PROJECT_CHANGE_MAX_LIMIT).default(PROJECT_CHANGE_DEFAULT_LIMIT),
  waitMs: z.coerce.number().int().min(0).max(PROJECT_CHANGE_MAX_WAIT_MS).default(PROJECT_CHANGE_MAX_WAIT_MS),
});
export type ProjectChangeEventsQuery = z.infer<typeof ProjectChangeEventsQuery>;

export const ProjectChangeEventsResponse = z.object({
  events: z.array(ProjectChangeEvent),
  /** Where to continue: the last returned entry's cursor, or the given one when nothing came. */
  nextCursor: z.string(),
});
export type ProjectChangeEventsResponse = z.infer<typeof ProjectChangeEventsResponse>;

/** What a cursor says. `seq` is the sequence number of the last entry the reader has seen (0: none). */
export interface ProjectEventCursor {
  generation: string;
  projectKey: string;
  seq: number;
}

const SEQ_TEXT = /^(?:0|[1-9][0-9]{0,15})$/;

function toBase64Url(text: string): string {
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    return atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    return null;
  }
}

/** The cursor text: base64url of `{ version: 1, generation, projectKey, seq }`, `seq` a decimal string. */
export function encodeProjectEventCursor(cursor: ProjectEventCursor): string {
  return toBase64Url(
    JSON.stringify({
      version: 1,
      generation: cursor.generation,
      projectKey: cursor.projectKey,
      seq: String(cursor.seq),
    }),
  );
}

/**
 * Reads a cursor, or null when it is not one: not canonical base64url JSON of exactly this shape, an
 * unknown version, or a `seq` that is not a decimal text of a safe integer. The text must be exactly
 * what `encodeProjectEventCursor` writes, so two spellings never mean one position.
 */
export function decodeProjectEventCursor(text: string): ProjectEventCursor | null {
  const json = fromBase64Url(text);
  if (json === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  const parsed = z
    .object({
      version: z.literal(1),
      generation: z.string().min(1).max(128),
      projectKey: z.string().min(1).max(64),
      seq: z.string().regex(SEQ_TEXT),
    })
    .strict()
    .safeParse(value);
  if (!parsed.success) return null;
  const seq = Number(parsed.data.seq);
  if (!Number.isSafeInteger(seq)) return null;
  const cursor = { generation: parsed.data.generation, projectKey: parsed.data.projectKey, seq };
  return encodeProjectEventCursor(cursor) === text ? cursor : null;
}
