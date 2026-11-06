import { describe, expect, it } from 'vitest';
import { isCardComment, pageCommentThreads, replyParentOf } from './comments';
import type { TimelineEvent } from './event';

const human = { kind: 'human', handle: 'owner' } as const;
const ai = { kind: 'ai', handle: 'dev' } as const;

function note(
  id: string,
  data: Record<string, unknown> = {},
  actor: TimelineEvent['actor'] = human,
  taskKey = 'PM-1',
): TimelineEvent {
  return {
    id,
    projectKey: 'PM',
    taskKey,
    sessionId: null,
    actor,
    type: 'task_note',
    data: { text: id, ...data },
    createdAt: '2026-11-06T10:00:00.000Z',
  };
}

describe('isCardComment', () => {
  it('follows the stored mark whoever wrote the note', () => {
    expect(isCardComment(note('a', { comment: true }, ai))).toBe(true);
    expect(isCardComment(note('b', { comment: false }, human))).toBe(false);
  });

  it('treats an old reply or import as a comment', () => {
    expect(isCardComment(note('a', { replyTo: 'x' }, ai))).toBe(true);
    expect(isCardComment(note('b', { importedAuthor: 'Eve' }, ai))).toBe(true);
  });

  it('treats an old note by a person as a comment and one by an AI or the integrator as process', () => {
    expect(isCardComment(note('a', {}, human))).toBe(true);
    expect(isCardComment(note('b', {}, ai))).toBe(false);
    expect(isCardComment(note('c', {}, { ...human, via: 'integrator' }))).toBe(false);
  });

  it('is false for any other event type', () => {
    expect(isCardComment({ ...note('a', { comment: true }), type: 'task_updated' })).toBe(false);
  });
});

describe('replyParentOf', () => {
  const top = note('top', { comment: true });
  const reply = note('reply', { comment: true, replyTo: 'top' });

  it('answers a top-level comment itself and a reply through its parent', () => {
    expect(replyParentOf(top, 'PM-1')).toBe('top');
    expect(replyParentOf(reply, 'PM-1')).toBe('top');
  });

  it('refuses a missing target, another card and a process note', () => {
    expect(replyParentOf(null, 'PM-1')).toBeNull();
    expect(replyParentOf(top, 'PM-2')).toBeNull();
    expect(replyParentOf(note('p', { comment: false }), 'PM-1')).toBeNull();
  });
});

describe('pageCommentThreads', () => {
  // c1..c5 are top-level comments; c3 has two replies; a process note and a reply of c1 sit among them.
  const notes = [
    note('c1', { comment: true }),
    note('p1', { comment: false }),
    note('c2', { comment: true }),
    note('r3a', { comment: true, replyTo: 'c3' }),
    note('c3', { comment: true }),
    note('r3b', { comment: true, replyTo: 'c3' }),
    note('c4', { comment: true }),
    note('r1', { comment: true, replyTo: 'c1' }),
    note('c5', { comment: true }),
  ];
  const ids = (page: ReturnType<typeof pageCommentThreads>) => page?.threads.map((t) => t.comment.id);

  it('gives the newest threads with every reply and no process note', () => {
    const page = pageCommentThreads(notes, { limit: 2 });
    expect(ids(page)).toEqual(['c4', 'c5']);
    expect(page?.nextBefore).toBe('c4');
    const all = pageCommentThreads(notes, { limit: 50 });
    expect(all?.threads.find((t) => t.comment.id === 'c3')?.replies.map((r) => r.id)).toEqual(['r3a', 'r3b']);
    expect(all?.threads.find((t) => t.comment.id === 'c1')?.replies.map((r) => r.id)).toEqual(['r1']);
    expect(all?.nextBefore).toBeNull();
  });

  it('pages back from a top-level comment', () => {
    const page = pageCommentThreads(notes, { before: 'c4', limit: 2 });
    expect(ids(page)).toEqual(['c2', 'c3']);
    expect(page?.nextBefore).toBe('c2');
  });

  it('centres on the thread of a reply', () => {
    const page = pageCommentThreads(notes, { around: 'r3b', limit: 3 });
    expect(ids(page)).toEqual(['c2', 'c3', 'c4']);
  });

  it('returns null for an unknown anchor', () => {
    expect(pageCommentThreads(notes, { before: 'nope', limit: 2 })).toBeNull();
    expect(pageCommentThreads(notes, { around: 'p1', limit: 2 })).toBeNull();
  });
});
