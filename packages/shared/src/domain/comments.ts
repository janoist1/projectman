import type { CommentRevision, TimelineEvent } from './event';
import { canUploadAttachment } from './attachment';
import type { AttachmentViewer, CommentAttachmentRef } from './attachment';
import { canCommentOnTask } from '../config/communication';
import { isOwnActor } from './actor-origin';
import { commentMentions } from './mentions';
import type { TaskViewer } from './task';

export function canAttachToComment(viewer: AttachmentViewer): boolean {
  return canUploadAttachment(viewer) && canCommentOnTask(viewer.access);
}

/** Deleted state is projected on read; the stored timeline remains append-only. */
export function withGoneCommentFiles(
  events: readonly TimelineEvent[],
  live: ReadonlySet<string>,
): TimelineEvent[] {
  return events.map((event) => {
    if (event.type !== 'task_note' || !Array.isArray(event.data.attachments)) return event;
    const attachments = (event.data.attachments as CommentAttachmentRef[]).map((file) => {
      const { gone: _, ...ref } = file;
      return live.has(file.id) ? ref : { ...ref, gone: true as const };
    });
    return { ...event, data: { ...event.data, attachments } };
  });
}

type CommentNote = Pick<TimelineEvent, 'type' | 'data' | 'actor'>;

/** Whether the comment was imported from another tool (PM-1277): it has an imported author or time. */
export function isImportedComment(note: Pick<TimelineEvent, 'data'>): boolean {
  return note.data.importedAuthor !== undefined || note.data.importedAt !== undefined;
}

/**
 * Whether `editor` may edit the comment's text (PM-1277). Only a card comment (never a Process note), and
 * never by an AI member or a viewer. An imported comment is the owner's or an admin's to edit, whoever
 * imported it; any other comment only its own human author may edit.
 */
export function canEditComment(editor: TaskViewer, note: CommentNote): boolean {
  if (!isCardComment(note)) return false;
  if (editor.access === 'ai' || !canCommentOnTask(editor.access)) return false;
  if (isImportedComment(note)) return editor.access === 'owner' || editor.access === 'admin';
  return note.actor.kind === 'human' && isOwnActor(note.actor, editor.handle);
}

/**
 * Whether `viewer` may read a comment's earlier versions (PM-1277): the owner and admins always; an
 * imported comment's history nobody else; otherwise the comment's own (human) author.
 */
export function canSeeCommentHistory(viewer: TaskViewer, note: CommentNote): boolean {
  if (viewer.access === 'owner' || viewer.access === 'admin') return true;
  if (isImportedComment(note)) return false;
  return viewer.access !== 'ai' && isOwnActor(note.actor, viewer.handle);
}

/**
 * The mentions an edit adds (PM-1277): those of `text` that no earlier version had. `earlier` is the
 * `mentions` of every earlier version; the difference is against their union, so a mention that was
 * taken out and put back does not notify twice.
 */
export function addedCommentMentions(input: {
  text: string;
  handles: readonly string[];
  editor: string | null;
  earlier: readonly (readonly string[])[];
}): string[] {
  const seen = new Set(input.earlier.flat().map((handle) => handle.toLowerCase()));
  return commentMentions(input.text, input.handles, input.editor).filter(
    (handle) => !seen.has(handle.toLowerCase()),
  );
}

/**
 * Projects the edits on read (PM-1277); the stored notes stay as written. Every `task_note` with edits gets
 * its latest `text` and `mentions`, `edited` and `revisions`; an edit event in `events` shrinks to its
 * `noteId`. `edits` are the `task_note_edited` events in the order they were written.
 */
export function withCommentEdits(
  events: readonly TimelineEvent[],
  edits: readonly TimelineEvent[],
): TimelineEvent[] {
  const byNote = new Map<string, TimelineEvent[]>();
  for (const edit of edits) {
    const noteId = String(edit.data.noteId);
    byNote.set(noteId, [...(byNote.get(noteId) ?? []), edit]);
  }
  return events.map((event) => {
    if (event.type === 'task_note_edited') return { ...event, data: { noteId: event.data.noteId } };
    const list = event.type === 'task_note' ? byNote.get(event.id) : undefined;
    if (!list?.length) return event;
    const latest = list.at(-1)!;
    const original: CommentRevision = {
      id: event.id,
      text: String(event.data.text ?? ''),
      mentions: Array.isArray(event.data.mentions) ? (event.data.mentions as string[]) : [],
      at: String(event.data.importedAt ?? event.createdAt),
      actor: event.actor,
      original: true,
    };
    // Earlier versions only (the latest is the note's own text now): newest first, the original last.
    const revisions: CommentRevision[] = [...list.slice(0, -1).reverse().map(revisionOf), original];
    return {
      ...event,
      data: {
        ...event.data,
        text: latest.data.text,
        mentions: latest.data.mentions,
        edited: { revisionId: latest.id, at: latest.createdAt, actor: latest.actor, count: list.length },
        revisions,
      },
    };
  });
}

/**
 * The events without the earlier versions of their comments (PM-1277): what an AI member reads (its
 * context pack and tools) is the comment as it stands, never the text that was taken out.
 */
export function withoutCommentHistory(events: readonly TimelineEvent[]): TimelineEvent[] {
  return events.map(withoutRevisions);
}

/** One event without the earlier versions of its comment; any other event stays as it is (PM-1277). */
export function withoutRevisions(event: TimelineEvent): TimelineEvent {
  if (event.type !== 'task_note' || event.data?.revisions === undefined) return event;
  const { revisions: _revisions, ...data } = event.data;
  return { ...event, data };
}

function revisionOf(edit: TimelineEvent): CommentRevision {
  return {
    id: edit.id,
    text: String(edit.data.text ?? ''),
    mentions: Array.isArray(edit.data.mentions) ? (edit.data.mentions as string[]) : [],
    at: edit.createdAt,
    actor: edit.actor,
  };
}

/**
 * Whether a timeline event is a comment on the card (PM-1290): the Comments column, as opposed to a
 * Process note. The stored `comment` mark decides; an event written before the mark existed is
 * classified by who wrote it. The server, the web and the web's test fake all use this one rule.
 */
export function isCardComment(event: Pick<TimelineEvent, 'type' | 'data' | 'actor'>): boolean {
  if (event.type !== 'task_note') return false;
  if (typeof event.data.comment === 'boolean') return event.data.comment;
  // An old event: a reply or an import, and a person's own note, is a comment; an AI's or the
  // integrator's note is Process.
  if (event.data.replyTo || event.data.importedAuthor) return true;
  return event.actor.kind === 'human' && !event.actor.via;
}

/**
 * Whether a timeline event belongs in the card's Process story (PM-1290): not a comment (the Comments
 * column has it) and not a person's direct message (their conversation, not the card's). The web's
 * Process story filters the card's timeline with this one rule.
 */
export function isProcessTimelineEvent(event: Pick<TimelineEvent, 'type' | 'data' | 'actor'>): boolean {
  if (isCardComment(event) || event.type === 'task_note_edited') return false;
  return !(event.type === 'team_message' && event.data.conversation === 'direct');
}

/** The id of the top-level comment a reply answers, or undefined for a top-level comment. */
function commentReplyTo(event: Pick<TimelineEvent, 'data'>): string | undefined {
  const replyTo = event.data.replyTo;
  return typeof replyTo === 'string' && replyTo ? replyTo : undefined;
}

/**
 * The comment id a reply to `target` lands on (PM-1290): the target itself, or its parent when it is a
 * reply (one level, as on GitHub). Null when the target is not a comment of the card at all.
 */
export function replyParentOf(
  target: Pick<TimelineEvent, 'type' | 'data' | 'actor' | 'id' | 'taskKey'> | null,
  taskKey: string,
): string | null {
  if (!target || target.taskKey !== taskKey || !isCardComment(target)) return null;
  return commentReplyTo(target) ?? target.id;
}

export interface CommentThreadsPage {
  threads: { comment: TimelineEvent; replies: TimelineEvent[] }[];
  nextBefore: string | null;
}

/**
 * One page of a card's comment threads (PM-1290) from all the card's notes, oldest first. The page holds
 * `limit` top-level comments with every reply of theirs, so no reply is cut off from its comment. `before`
 * pages back from a top-level comment, `around` centres the page on the thread of a comment or a reply, and
 * neither gives the newest threads. Null when `before` or `around` names no comment of the card.
 */
export function pageCommentThreads(
  notes: readonly TimelineEvent[],
  query: { before?: string | undefined; around?: string | undefined; limit: number },
): CommentThreadsPage | null {
  const comments = notes.filter(isCardComment);
  const tops = comments.filter((event) => commentReplyTo(event) === undefined);
  const repliesByParent = new Map<string, TimelineEvent[]>();
  for (const reply of comments) {
    const parent = commentReplyTo(reply);
    if (parent === undefined) continue;
    repliesByParent.set(parent, [...(repliesByParent.get(parent) ?? []), reply]);
  }
  const indexOfThread = (id: string): number => {
    const own = tops.findIndex((event) => event.id === id);
    if (own >= 0) return own;
    const reply = comments.find((event) => event.id === id);
    const parent = reply && commentReplyTo(reply);
    return parent === undefined ? -1 : tops.findIndex((event) => event.id === parent);
  };
  let start: number;
  let end: number;
  if (query.around !== undefined) {
    const at = indexOfThread(query.around);
    if (at < 0) return null;
    start = Math.max(0, at - Math.floor(query.limit / 2));
    end = Math.min(tops.length, start + query.limit);
    start = Math.max(0, end - query.limit);
  } else if (query.before !== undefined) {
    end = tops.findIndex((event) => event.id === query.before);
    if (end < 0) return null;
    start = Math.max(0, end - query.limit);
  } else {
    end = tops.length;
    start = Math.max(0, end - query.limit);
  }
  return {
    threads: tops
      .slice(start, end)
      .map((comment) => ({ comment, replies: repliesByParent.get(comment.id) ?? [] })),
    nextBefore: start > 0 ? tops[start]!.id : null,
  };
}
