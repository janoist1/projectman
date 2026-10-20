import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HistoryViewer } from '@projectman/shared';
import type { DomainHarness } from './helpers/domain-harness';
import { as, historyHarness, OWNER_ACTOR } from './helpers/history';

const OWNER = { handle: 'owner', access: 'owner' as const };
const ASK = { handle: 'owner', access: 'owner' as const };

/** Every source of the fixture carries the marker "zebra" and a tag word that names it. */
const TAG = /tag[a-z0-9]+/;

/**
 * The tag of a hit. Resolving a question also records the answer message that quotes it, which is a source of
 * its own with the question's tag: it is told apart by its type.
 */
const keyOf = (match: { excerpt: string; sourceType: string }) =>
  `${TAG.exec(match.excerpt)![0]}${match.sourceType === 'message' && match.excerpt.includes('tagq') ? '-answer' : ''}`;

describe('history search and read visibility', () => {
  let h: DomainHarness;
  /** Source ids by tag, as the owner finds them. */
  let ids: Record<string, string>;

  const record = (
    from: string,
    to: string[],
    tag: string,
    extra: { taskKey?: string | null; origin?: object; answer?: object } = {},
  ) =>
    h.domain.messages.record({
      projectKey: 'AR',
      from,
      to,
      taskKey: extra.taskKey ?? null,
      body: `zebra ${tag}`,
      actor: OWNER_ACTOR,
      humanRecipients: [from, ...to].filter((handle) =>
        ['owner', 'admin', 'dev', 'reader', 'acme', 'beta'].includes(handle),
      ),
      delivered: true,
      ...(extra.origin ? { origin: extra.origin as never } : {}),
      ...(extra.answer ? { answer: extra.answer as never } : {}),
    });

  async function closedQuestion(
    tag: string,
    assignees: string[],
    taskKey: string | null,
    payload: Record<string, unknown> = {},
  ) {
    const item = h.domain.inbox.create({
      projectKey: 'AR',
      kind: 'question',
      source: 'dev-1',
      assignees,
      taskKey,
      title: `zebra ${tag}`,
      payload: { question: `zebra ${tag}`, ...payload },
      options: [{ id: 'yes', label: 'Yes', style: 'primary' }],
    });
    await h.domain.inbox.resolve('AR', item.id, { optionId: 'yes' }, ASK);
    return item;
  }

  const tagsOf = async (viewer: HistoryViewer) =>
    (await h.domain.history.search('AR', viewer, { query: 'zebra', limit: 50 })).matches.map(keyOf).sort();

  beforeEach(async () => {
    h = await historyHarness();
    const internal = await h.domain.tasks.create('AR', { title: 'zebra tagt1' }, OWNER_ACTOR);
    const shared = await h.domain.tasks.create(
      'AR',
      { title: 'zebra tagt2', visibility: 'shared' },
      OWNER_ACTOR,
    );
    const noteInternal = await h.domain.tasks.addNote('AR', internal.key, 'zebra tagn1', OWNER_ACTOR);
    await h.domain.tasks.addNote('AR', shared.key, 'zebra tagn2', OWNER_ACTOR);
    record('dev-1', ['cr'], 'tagm1');
    record('owner', ['acme'], 'tagm2');
    record('dev-1', ['dev'], 'tagm3');
    record('reader', ['owner'], 'tagm4');
    record('dev-1', ['acme'], 'tagm5', { taskKey: internal.key });
    record('dev-1', ['acme'], 'tagm6', { taskKey: shared.key });
    record('dev-1', ['acme'], 'tagm7', { origin: { kind: 'note', eventId: noteInternal.id } });
    const q1 = await closedQuestion('tagq1', ['owner'], internal.key);
    await closedQuestion('tagq2', ['acme'], shared.key);
    const q4 = await closedQuestion('tagq4', ['owner'], null, { operatorKnowledge: { id: 'ok_1' } });
    // An open question is no history yet.
    h.domain.inbox.create({
      projectKey: 'AR',
      kind: 'question',
      source: 'dev-1',
      assignees: ['owner'],
      taskKey: null,
      title: 'zebra tagq3',
      payload: { question: 'zebra tagq3' },
      options: [{ id: 'yes', label: 'Yes', style: 'primary' }],
    });
    record('dev-1', ['acme'], 'tagm8', {
      answer: { inboxItemId: q1.id, question: 'zebra', answer: 'zebra' },
    });
    record('dev-1', ['owner'], 'tagm9', {
      origin: { kind: 'operator_knowledge_approval', inboxItemId: q4.id },
    });
    h.domain.history.flush();
    ids = {};
    const everyMatch = await h.domain.history.search('AR', OWNER, { query: 'zebra', limit: 50 });
    for (const match of everyMatch.matches) ids[keyOf(match)] = match.sourceId;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await h.cleanup();
  });

  const everything = [
    'tagm1',
    'tagm2',
    'tagm3',
    'tagm4',
    'tagm5',
    'tagm6',
    'tagm7',
    'tagm8',
    'tagm9',
    'tagn1',
    'tagn2',
    'tagq1',
    'tagq2',
    'tagq4',
    'tagq1-answer',
    'tagq2-answer',
    'tagq4-answer',
    'tagt1',
    'tagt2',
  ];

  const matrix: Array<[string, string[]]> = [
    ['owner', everything],
    ['admin', everything],
    // A developer sees what is not private: every card, note and question, and their own messages.
    ['dev', ['tagm3', 'tagn1', 'tagn2', 'tagq1', 'tagq2', 'tagt1', 'tagt2']],
    ['reader', ['tagm4', 'tagn1', 'tagn2', 'tagq1', 'tagq2', 'tagt1', 'tagt2']],
    // An AI member: the messages it sent or got; the Operator knowledge approval and its copy stay private.
    [
      'dev-1',
      [
        ...['tagm1', 'tagm3', 'tagm5', 'tagm6', 'tagm7', 'tagm8', 'tagn1', 'tagn2', 'tagq1', 'tagq2'],
        ...['tagq1-answer', 'tagq2-answer', 'tagt1', 'tagt2'],
      ],
    ],
    ['cr', ['tagm1', 'tagn1', 'tagn2', 'tagq1', 'tagq2', 'tagt1', 'tagt2']],
    ['dev-2', ['tagn1', 'tagn2', 'tagq1', 'tagq2', 'tagt1', 'tagt2']],
    // A client: the shared card, its message and their own question; no note, no internal card, no private copy.
    ['acme', ['tagm2', 'tagm6', 'tagq2', 'tagt2']],
    ['beta', ['tagt2']],
  ];

  it('does not index an open question', () => {
    expect(Object.keys(ids)).not.toContain('tagq3');
  });

  it.each(matrix)('searches exactly what %s may read', async (handle, expected) => {
    expect(await tagsOf(as(handle))).toEqual([...expected].sort());
  });

  it.each(matrix)(
    'reads exactly what %s may read, and nothing else is told apart from a missing source',
    (handle, expected) => {
      for (const [tag, sourceId] of Object.entries(ids)) {
        const read = () => h.domain.history.read('AR', as(handle), { sourceId });
        if (expected.includes(tag)) expect(read().text).toContain('zebra');
        else expect(read).toThrowError(expect.objectContaining({ status: 404, code: 'not_found' }));
      }
      expect(() => h.domain.history.read('AR', as(handle), { sourceId: 'hsrc_unknown' })).toThrowError(
        expect.objectContaining({ status: 404, code: 'not_found' }),
      );
    },
  );

  it('hides the Operator knowledge approval and its copy from the integrator, even for the owner', async () => {
    const via: HistoryViewer = { ...OWNER, via: 'integrator' };
    const hidden = ['tagq4', 'tagq4-answer', 'tagm9'];
    expect(await tagsOf(via)).toEqual(everything.filter((tag) => !hidden.includes(tag)).sort());
    expect(() => h.domain.history.read('AR', via, { sourceId: ids.tagq4! })).toThrowError(
      expect.objectContaining({ status: 404 }),
    );
  });

  it('takes the access from the current roster, not from the caller', async () => {
    const claimed: HistoryViewer = { handle: 'acme', access: 'owner' };
    expect(await tagsOf(claimed)).toEqual(['tagm2', 'tagm6', 'tagq2', 'tagt2']);
  });

  it('refuses a non-member, a removed member and another project the same way', async () => {
    const refused = expect.objectContaining({ status: 403, code: 'insufficient_access' });
    await expect(h.domain.history.search('AR', as('stranger'), { query: 'zebra' })).rejects.toThrowError(
      refused,
    );
    expect(() => h.domain.history.read('AR', as('stranger'), { sourceId: ids.tagt2! })).toThrowError(refused);
    await expect(h.domain.history.search('NOPE', OWNER, { query: 'zebra' })).rejects.toThrowError(refused);
    expect(await tagsOf(as('beta'))).toEqual(['tagt2']);
    await h.domain.projects.update(
      'AR',
      { actor: OWNER_ACTOR, author: { name: 'Owner', email: 'owner@example.com' } },
      (draft) => {
        draft.team.members = draft.team.members.filter((member) => member.handle !== 'beta');
        return 'Remove a fictional member';
      },
    );
    await expect(h.domain.history.search('AR', as('beta'), { query: 'zebra' })).rejects.toThrowError(refused);
    expect(() => h.domain.history.read('AR', as('beta'), { sourceId: ids.tagt2! })).toThrowError(refused);
  });

  it('follows a change of the card visibility on the very next call, without any reindexing', async () => {
    expect(await tagsOf(as('acme'))).toContain('tagt2');
    await h.domain.tasks.update('AR', 'AR-2', { visibility: 'internal' }, OWNER_ACTOR);
    // Nothing is flushed here: the access is decided from the card as it is now.
    expect(await tagsOf(as('acme'))).toEqual(['tagm2']);
    expect(() => h.domain.history.read('AR', as('acme'), { sourceId: ids.tagt2! })).toThrowError(
      expect.objectContaining({ status: 404 }),
    );
    await h.domain.tasks.update('AR', 'AR-1', { visibility: 'shared' }, OWNER_ACTOR);
    expect(await tagsOf(as('acme'))).toEqual(['tagm2', 'tagm5', 'tagt1']);
  });

  it('shows a client a grouped question as its original, never the combined one', async () => {
    const group = await closedQuestion('tagq5', ['acme'], 'AR-2', {
      group: {
        primaryItemId: 'inb_primary',
        itemIds: ['inb_primary', 'inb_other'],
        combinedQuestion: 'zebra combined internal wording',
        originalQuestion: 'zebra original wording',
      },
    });
    h.domain.history.flush();
    const found = await h.domain.history.search('AR', as('acme'), { query: 'combined' });
    expect(found.matches).toEqual([]);
    const own = await h.domain.history.search('AR', as('acme'), { query: 'original' });
    expect(own.matches).toHaveLength(1);
    const read = h.domain.history.read('AR', as('acme'), { sourceId: own.matches[0]!.sourceId });
    expect(read.text).not.toContain('combined');
    expect(group.id).toBeTruthy();
  });

  it('keeps a hit out of a viewer who is not allowed to read it, however much better it ranks', async () => {
    // The client searching for a word of an internal card gets nothing, not an empty "hidden" marker.
    const result = await h.domain.history.search('AR', as('acme'), { query: 'tagt1' });
    expect(result).toEqual({ projectKey: 'AR', matches: [], hasMore: false, documents: [] });
  });
});
