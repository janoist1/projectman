import { describe, expect, it } from 'vitest';
import { ProjectConfig } from '../config/schema';
import type { InboxItem } from './inbox';
import { mentionExcerpt, mentionItemTargets, mentionsClosedByReply } from './mention-items';

const config = ProjectConfig.parse({
  schemaVersion: 1,
  project: { key: 'AC', name: 'Acme', workspacePath: '/work/acme', repos: [] },
  team: {
    members: [
      { kind: 'human', handle: 'owner', displayName: 'Owner', access: 'owner' },
      { kind: 'human', handle: 'robin', displayName: 'Robin', access: 'developer' },
      { kind: 'human', handle: 'cleo', displayName: 'Cleo', access: 'client' },
      { kind: 'human', handle: 'kata', displayName: 'Kata', access: 'admin' },
      { kind: 'ai', handle: 'dev-1', displayName: 'Developer', role: 'developer', sponsor: 'owner' },
    ],
    contacts: ['robin'],
    limits: {},
  },
  pipeline: {
    columns: [{ id: 'todo', name: 'To do' }],
    stages: [
      { id: 'ready', name: 'Ready', kind: 'queue', owners: [], columnId: 'todo' },
      { id: 'done', name: 'Done', kind: 'done', owners: [], columnId: 'todo' },
    ],
  },
});

describe('mentionItemTargets', () => {
  const targets = (
    mentions: string[],
    author: { kind: 'human' | 'ai' | 'system'; handle?: string } = { kind: 'human', handle: 'owner' },
    imported = false,
  ) => mentionItemTargets({ config, author: author as never, mentions, imported });

  it('takes the mentioned humans once each, never the author or an AI member', () => {
    expect(targets(['robin', 'dev-1', 'owner', 'robin', 'kata'])).toEqual(['robin', 'kata']);
  });

  it('lets an AI author open items for humans', () => {
    expect(targets(['robin'], { kind: 'ai', handle: 'dev-1' })).toEqual(['robin']);
  });

  it.each([
    ['an import', ['robin'], { kind: 'human', handle: 'owner' }, true],
    ['a system author', ['robin'], { kind: 'system' }, false],
    ['an unknown handle', ['nobody'], { kind: 'human', handle: 'owner' }, false],
  ] as const)('opens none for %s', (_name, mentions, author, imported) => {
    expect(targets([...mentions], author, imported)).toEqual([]);
  });

  it('keeps a client to the contacts', () => {
    expect(targets(['robin', 'kata'], { kind: 'human', handle: 'cleo' })).toEqual(['robin']);
  });
});

describe('mentionExcerpt', () => {
  it('keeps a short text whole', () => {
    expect(mentionExcerpt('@robin look', 'robin')).toBe('@robin look');
  });

  it('cuts a long text to 600 characters with a mark at the end', () => {
    const text = `@robin ${'x'.repeat(900)}`;
    const excerpt = mentionExcerpt(text, 'robin');
    expect(excerpt).toHaveLength(600);
    expect(excerpt.startsWith('@robin x')).toBe(true);
    expect(excerpt.endsWith('…')).toBe(true);
  });

  it('starts before a mention that comes late, marking both cuts', () => {
    const text = `${'x'.repeat(700)} @robin ${'y'.repeat(700)}`;
    const excerpt = mentionExcerpt(text, 'robin');
    expect(excerpt).toHaveLength(600);
    expect(excerpt.startsWith('…')).toBe(true);
    expect(excerpt.endsWith('…')).toBe(true);
    expect(excerpt).toContain('@robin');
  });

  it('marks only the start when the text ends inside the excerpt', () => {
    const text = `${'x'.repeat(700)} @robin end`;
    const excerpt = mentionExcerpt(text, 'robin');
    expect(excerpt.startsWith('…')).toBe(true);
    expect(excerpt.endsWith('@robin end')).toBe(true);
  });
});

describe('mentionsClosedByReply', () => {
  const item = (id: string, overrides: Partial<InboxItem> = {}, threadId: string | null = 't1'): InboxItem =>
    ({
      id,
      kind: 'mention',
      assignees: ['robin'],
      taskKey: 'AC-1',
      state: 'open',
      createdAt: '2026-11-06T10:00:00.000Z',
      payload: { eventId: 'e1', place: 'comment', threadId },
      ...overrides,
    }) as InboxItem;
  const reply = { author: 'robin', taskKey: 'AC-1', threadId: 't1', at: '2026-11-06T10:05:00.000Z' };

  it('closes the replier’s open items of the thread', () => {
    expect(mentionsClosedByReply([item('a'), item('b')], reply).map((i) => i.id)).toEqual(['a', 'b']);
  });

  it.each([
    ['another thread', item('a', {}, 't2')],
    ['a standalone note', item('a', {}, null)],
    ['another person', item('a', { assignees: ['owner'] })],
    ['another card', item('a', { taskKey: 'AC-2' })],
    ['a closed item', item('a', { state: 'resolved' })],
    ['an item raised after the reply', item('a', { createdAt: '2026-11-06T10:05:00.000Z' })],
  ])('leaves %s open', (_name, other) => {
    expect(mentionsClosedByReply([other], reply)).toEqual([]);
  });
});
