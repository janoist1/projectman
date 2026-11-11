import { describe, expect, it } from 'vitest';
import {
  addedCommentMentions,
  canAttachToComment,
  canEditComment,
  canSeeCommentHistory,
  isCardComment,
  isImportedComment,
  isProcessTimelineEvent,
  pageCommentThreads,
  replyParentOf,
  withCommentEdits,
  withGoneCommentFiles,
  withoutCommentHistory,
} from './comments';
import { CreateTaskCommentRequest } from '../api/dto';
import type { TimelineEvent } from './event';
import { visibleTimelineEvent } from './timeline-visibility';

const human = { kind: 'human', handle: 'owner' } as const;
const ai = { kind: 'ai', handle: 'dev' } as const;

describe('comment attachments', () => {
  const id = 'att_commentfile1';
  it('accepts files without text and keeps legacy text requests', () => {
    expect(CreateTaskCommentRequest.parse({ attachmentIds: [id] }).text).toBe('');
    expect(CreateTaskCommentRequest.parse({ text: '  Hello  ' })).toEqual({ text: 'Hello' });
  });
  it.each([
    {},
    { text: '  ' },
    { attachmentIds: [] },
    { attachmentIds: [id, id] },
    { attachmentIds: Array.from({ length: 11 }, (_, i) => `att_commentfile${i}`) },
  ])('rejects an empty or invalid file submission %j', (body) => {
    expect(CreateTaskCommentRequest.safeParse(body).success).toBe(false);
  });
  it.each([
    ['client', true],
    ['viewer', false],
    ['ai', true],
  ] as const)('judges %s upload access', (access, expected) => {
    expect(canAttachToComment({ access, handle: 'author' })).toBe(expected);
  });
  it('projects deleted files without changing the stored event or legacy notes', () => {
    const file = { id, fileName: 'a.pdf', size: 3, mediaType: 'application/pdf', preview: 'pdf' };
    const stored = note('files', { attachments: [file, { ...file, id: 'att_commentfile2' }] });
    const old = note('old');
    const projected = withGoneCommentFiles([stored, old], new Set([id]));
    expect(projected[0]!.data.attachments).toEqual([file, { ...file, id: 'att_commentfile2', gone: true }]);
    expect(stored.data.attachments).toEqual([file, { ...file, id: 'att_commentfile2' }]);
    expect(projected[1]).toBe(old);
  });
});

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

describe('isProcessTimelineEvent', () => {
  const message = (data: Record<string, unknown>): TimelineEvent => ({
    ...note('m'),
    type: 'team_message',
    data,
  });

  it('keeps a comment out of the Process', () => {
    expect(isProcessTimelineEvent(note('a', { comment: true }))).toBe(false);
    expect(isProcessTimelineEvent(note('b', { comment: false }))).toBe(true);
  });

  it('keeps a direct message out of the Process and a machine message in it', () => {
    expect(isProcessTimelineEvent(message({ conversation: 'direct' }))).toBe(false);
    expect(isProcessTimelineEvent(message({}))).toBe(true);
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

describe('editing a comment (PM-1277)', () => {
  const connected = {
    kind: 'human',
    handle: 'kata',
    via: 'integrator',
    through: { holder: 'kata', credential: { id: 'key_1', prefix: 'pmk_1' } },
  } as const;
  const imported = { importedAuthor: 'Dani', importedAt: '2026-01-01T00:00:00.000Z' };
  const own = note('c1', { comment: true }, { kind: 'human', handle: 'kata' });

  it.each([
    ['its author', { access: 'developer', handle: 'kata' }, own, true],
    [
      'its author through their own connected Claude',
      { access: 'developer', handle: 'kata' },
      note('c1', { comment: true }, connected),
      true,
    ],
    ['another person', { access: 'developer', handle: 'bela' }, own, false],
    ['the owner, for another person', { access: 'owner', handle: 'owner' }, own, false],
    [
      'an AI member, for its own comment',
      { access: 'ai', handle: 'dev' },
      note('c1', { comment: true }, ai),
      false,
    ],
    ['a viewer, for their own comment', { access: 'viewer', handle: 'kata' }, own, false],
    ['a client, for their own comment', { access: 'client', handle: 'kata' }, own, true],
    [
      'the author of an imported comment',
      { access: 'developer', handle: 'kata' },
      note('c1', { comment: true, ...imported }, { kind: 'human', handle: 'kata' }),
      false,
    ],
    [
      'the owner, for an imported comment',
      { access: 'owner', handle: 'owner' },
      note('c1', { comment: true, ...imported }, ai),
      true,
    ],
    [
      'an admin, for an imported comment',
      { access: 'admin', handle: 'ada' },
      note('c1', { comment: true, ...imported }),
      true,
    ],
    [
      'its author, for a process note',
      { access: 'developer', handle: 'kata' },
      note('p1', { comment: false }, { kind: 'human', handle: 'kata' }),
      false,
    ],
  ] as const)('%s: canEditComment', (_who, editor, target, expected) => {
    expect(canEditComment(editor, target)).toBe(expected);
  });

  it.each([
    ['owner', { access: 'owner', handle: 'owner' }, own, true],
    ['admin', { access: 'admin', handle: 'ada' }, own, true],
    ['the author', { access: 'developer', handle: 'kata' }, own, true],
    ['another developer', { access: 'developer', handle: 'bela' }, own, false],
    ['an AI member', { access: 'ai', handle: 'kata' }, own, false],
    [
      'the author of an imported comment',
      { access: 'developer', handle: 'kata' },
      note('c1', imported, { kind: 'human', handle: 'kata' }),
      false,
    ],
    ['the owner of an imported comment', { access: 'owner', handle: 'owner' }, note('c1', imported), true],
  ] as const)('%s: canSeeCommentHistory', (_who, viewer, target, expected) => {
    expect(canSeeCommentHistory(viewer, target)).toBe(expected);
  });

  it('knows an imported comment by its author or its time', () => {
    expect(isImportedComment(note('c', { importedAuthor: 'Dani' }))).toBe(true);
    expect(isImportedComment(note('c', { importedAt: '2026-01-01T00:00:00.000Z' }))).toBe(true);
    expect(isImportedComment(note('c'))).toBe(false);
  });

  describe('addedCommentMentions', () => {
    const base = { handles: ['ada', 'bela', 'cili'], editor: 'kata' };
    it('keeps only the mentions no earlier version had', () => {
      expect(addedCommentMentions({ ...base, text: '@ada @bela', earlier: [['ada']] })).toEqual(['bela']);
    });
    it('does not notify again a mention that was taken out and put back', () => {
      // v1 had ada, v2 dropped her, v3 puts her back: the union of v1 and v2 still holds her.
      expect(addedCommentMentions({ ...base, text: '@ada', earlier: [['ada'], []] })).toEqual([]);
    });
    it('never adds the editor themselves', () => {
      expect(addedCommentMentions({ ...base, text: '@kata @cili', earlier: [[]] })).toEqual(['cili']);
    });
  });

  describe('withCommentEdits', () => {
    const original = note('c1', { comment: true, mentions: ['ada'] });
    const edit = (id: string, text: string, mentions: string[], at: string): TimelineEvent => ({
      id,
      projectKey: 'PM',
      taskKey: 'PM-1',
      sessionId: null,
      actor: { kind: 'human', handle: 'owner' },
      type: 'task_note_edited',
      data: { noteId: 'c1', text, mentions, base: 'c1', added: [] },
      createdAt: at,
    });
    const e1 = edit('e1', 'second', ['bela'], '2026-11-07T10:00:00.000Z');
    const e2 = edit('e2', 'third', [], '2026-11-08T10:00:00.000Z');

    it('gives a comment the latest text and the earlier versions newest first, the original last', () => {
      const [projected] = withCommentEdits([original], [e1, e2]);
      expect(projected!.data).toMatchObject({
        text: 'third',
        mentions: [],
        edited: { revisionId: 'e2', at: e2.createdAt, count: 2 },
      });
      expect((projected!.data.revisions as { id: string }[]).map((r) => r.id)).toEqual(['e1', 'c1']);
      expect((projected!.data.revisions as { original?: true }[]).at(-1)!.original).toBe(true);
    });
    it('leaves a comment without edits and the stored note untouched', () => {
      expect(withCommentEdits([original], [])[0]).toBe(original);
      withCommentEdits([original], [e1]);
      expect(original.data.text).toBe('c1');
    });
    it('shrinks an edit event to its note id', () => {
      expect(withCommentEdits([e1], [e1])[0]!.data).toEqual({ noteId: 'c1' });
    });
    it('is not a Process line', () => {
      expect(isProcessTimelineEvent(e1)).toBe(false);
    });
    it('drops the earlier versions for an AI reader and keeps the current text', () => {
      const [stripped] = withoutCommentHistory(withCommentEdits([original], [e1]));
      expect(stripped!.data.revisions).toBeUndefined();
      expect(stripped!.data).toMatchObject({ text: 'second', edited: { count: 1 } });
      expect(withoutCommentHistory([original])[0]).toBe(original);
    });

    describe('visibleTimelineEvent', () => {
      const projected = withCommentEdits(
        [note('c1', { comment: true }, { kind: 'human', handle: 'kata' })],
        [e1],
      )[0]!;
      const see = (viewer: Parameters<typeof visibleTimelineEvent>[0], event: TimelineEvent) =>
        visibleTimelineEvent(viewer, event, () => null);
      it('hides the earlier versions from those who may not read them', () => {
        expect(see({ access: 'developer', handle: 'bela' }, projected).data.revisions).toBeUndefined();
        expect(see({ access: 'ai', handle: 'dev' }, projected).data.revisions).toBeUndefined();
      });
      it('keeps them for the author and the owner', () => {
        expect(see({ access: 'developer', handle: 'kata' }, projected).data.revisions).toBeDefined();
        expect(see({ access: 'owner', handle: 'owner' }, projected).data.revisions).toBeDefined();
      });
      it('narrows the raw edit event to its note id for everyone', () => {
        expect(see({ access: 'owner', handle: 'owner' }, e1).data).toEqual({ noteId: 'c1' });
      });
    });
  });
});
