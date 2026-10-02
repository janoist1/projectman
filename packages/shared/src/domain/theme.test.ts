import { describe, expect, it } from 'vitest';
import { planRelations, relationRefusal } from './relations';
import type { RelationCard } from './relations';
import { isTheme, subtaskParentRefusal } from './task';
import type { Task } from './task';
import { themeCards, themeProgress, themeRefusal } from './theme';

/** Cards for the rules: AR-1 is a theme, AR-9 a closed one, the others are plain cards. */
function card(key: string, extra: Partial<Task> = {}): Task {
  return {
    id: `id-${key}`,
    projectKey: 'AR',
    key,
    title: `Card ${key}`,
    description: '',
    stageId: 'incoming',
    status: 'active',
    assignee: null,
    repo: null,
    priority: null,
    labels: [],
    links: [],
    visibility: 'internal',
    createdBy: 'owner',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    closedAt: null,
    parentKey: null,
    ...extra,
  };
}
const theme = (key: string, extra: Partial<Task> = {}) => card(key, { kind: 'theme', ...extra });

describe('isTheme', () => {
  it('is true for a theme only; a card without a kind is a task', () => {
    expect(isTheme(theme('AR-1'))).toBe(true);
    expect(isTheme(card('AR-2'))).toBe(false);
    expect(isTheme({ kind: 'task' })).toBe(false);
  });
});

describe('themeRefusal', () => {
  const open = theme('AR-1');

  it('lets a card that is not a subtask into an open theme of its project', () => {
    expect(themeRefusal(open, card('AR-2'))).toBeNull();
    // A collecting card (it has subtasks, but is no subtask itself) too.
    expect(themeRefusal(open, card('AR-3', { parentKey: null }))).toBeNull();
  });

  it.each([
    ['a theme', theme('AR-2'), 'theme_on_theme'],
    ['a subtask, which gets its parent’s theme', card('AR-2', { parentKey: 'AR-3' }), 'theme_on_subtask'],
  ] as const)('refuses %s', (_name, subject, code) => {
    expect(themeRefusal(open, subject)).toBe(code);
  });

  it('refuses a theme that is missing, of another project, no theme, or closed', () => {
    const subject = card('AR-2');
    expect(themeRefusal(undefined, subject)).toBe('theme_not_found');
    expect(themeRefusal(null, subject)).toBe('theme_not_found');
    expect(themeRefusal(theme('OT-1', { projectKey: 'OT' }), subject)).toBe('theme_project');
    expect(themeRefusal(card('AR-4'), subject)).toBe('theme_not_a_theme');
    expect(themeRefusal(theme('AR-9', { status: 'cancelled' }), subject)).toBe('theme_closed');
    expect(themeRefusal(theme('AR-9', { status: 'done' }), subject)).toBe('theme_closed');
  });

  it('judges the card before the theme: a subtask is refused whatever theme is meant', () => {
    expect(themeRefusal(undefined, card('AR-2', { parentKey: 'AR-3' }))).toBe('theme_on_subtask');
  });
});

describe('a theme in the subtask rule', () => {
  const plain = card('AR-2');
  const child = { key: 'AR-3', projectKey: 'AR', hasSubtasks: false };

  it('is neither the parent nor the child of a subtask', () => {
    expect(subtaskParentRefusal('AR-1', theme('AR-1'), child)).toBe('subtask_theme');
    expect(subtaskParentRefusal('AR-2', plain, { ...child, kind: 'theme' })).toBe('subtask_theme');
    expect(subtaskParentRefusal('AR-2', plain, { ...child, kind: 'task' })).toBeNull();
  });
});

describe('a theme in the relation rules', () => {
  const cards: RelationCard[] = [theme('AR-1'), theme('AR-2'), card('AR-3'), card('AR-4')];
  const from = (key: string) => ({ key, projectKey: 'AR' });

  it('has no prerequisite relation in either direction', () => {
    expect(relationRefusal('prerequisite', from('AR-1'), 'AR-3', cards)).toEqual({
      code: 'relation_theme',
      kind: 'prerequisite',
    });
    expect(relationRefusal('prerequisite', from('AR-3'), 'AR-1', cards)).toEqual({
      code: 'relation_theme',
      kind: 'prerequisite',
    });
    expect(relationRefusal('prerequisite', from('AR-3'), 'AR-4', cards)).toBeNull();
  });

  it('duplicates only a theme, and a card only a card', () => {
    expect(relationRefusal('duplicate_of', from('AR-2'), 'AR-1', cards)).toBeNull();
    expect(relationRefusal('duplicate_of', from('AR-2'), 'AR-3', cards)).toMatchObject({
      code: 'relation_theme',
    });
    expect(relationRefusal('duplicate_of', from('AR-3'), 'AR-1', cards)).toMatchObject({
      code: 'relation_theme',
    });
  });

  it('is related to anything', () => {
    expect(relationRefusal('related', from('AR-1'), 'AR-3', cards)).toBeNull();
    expect(relationRefusal('related', from('AR-3'), 'AR-1', cards)).toBeNull();
    expect(relationRefusal('related', from('AR-1'), 'AR-2', cards)).toBeNull();
  });

  it('is neither the part nor the whole of a card', () => {
    expect(relationRefusal('part_of', from('AR-1'), 'AR-3', cards)).toEqual({ code: 'subtask_theme' });
    expect(relationRefusal('part_of', from('AR-3'), 'AR-1', cards)).toEqual({ code: 'subtask_theme' });
  });

  it('is judged by the kind of a card that does not exist yet', () => {
    expect(
      relationRefusal('prerequisite', { key: null, projectKey: 'AR', kind: 'theme' }, 'AR-3', cards),
    ).toMatchObject({
      code: 'relation_theme',
    });
    expect(relationRefusal('part_of', { key: null, projectKey: 'AR', kind: 'theme' }, 'AR-3', cards)).toEqual(
      {
        code: 'subtask_theme',
      },
    );
  });

  it('refuses a whole plan on the first relation a theme may not have', () => {
    const plan = planRelations({
      task: cards[0]!,
      cards,
      elsewhere: () => undefined,
      change: {
        add: [
          { kind: 'related', key: 'AR-3' },
          { kind: 'prerequisite', key: 'AR-4' },
        ],
      },
      markDuplicate: () => null,
    });
    expect(plan).toMatchObject({ ok: false, key: 'AR-4', refusal: { code: 'relation_theme' } });
  });
});

describe('the cards of a theme', () => {
  // AR-10 is a theme; AR-1 (a collecting card, done) with its subtasks AR-2 (done) and AR-3 (active)
  // belong to it, and so does AR-4; AR-5 is cancelled; AR-6 belongs to no theme; AR-7 to another theme.
  const tasks = [
    theme('AR-10'),
    theme('AR-11'),
    card('AR-1', { themeKey: 'AR-10', status: 'done' }),
    card('AR-2', { themeKey: 'AR-10', parentKey: 'AR-1', status: 'done' }),
    card('AR-3', { themeKey: 'AR-10', parentKey: 'AR-1' }),
    card('AR-4', { themeKey: 'AR-10' }),
    card('AR-5', { themeKey: 'AR-10', status: 'cancelled' }),
    card('AR-6'),
    card('AR-7', { themeKey: 'AR-11' }),
  ];

  it('lists collecting cards with their subtasks, by number', () => {
    expect(themeCards('AR-10', tasks).map((c) => [c.key, c.subtasks.map((s) => s.key)])).toEqual([
      ['AR-1', ['AR-2', 'AR-3']],
      ['AR-4', []],
      ['AR-5', []],
    ]);
    expect(themeCards('AR-11', tasks).map((c) => c.key)).toEqual(['AR-7']);
    expect(themeCards('AR-9', tasks)).toEqual([]);
  });

  it('lists a subtask on its own when its parent is not among the cards given', () => {
    const visible = tasks.filter((c) => c.key !== 'AR-1');
    expect(themeCards('AR-10', visible).map((c) => c.key)).toEqual(['AR-2', 'AR-3', 'AR-4', 'AR-5']);
  });

  it('counts what is done of the cards that belong to the theme, the cancelled ones left out', () => {
    // AR-1, AR-2 (done), AR-3, AR-4 (not): the cancelled AR-5 counts neither way.
    expect(themeProgress('AR-10', tasks)).toEqual({ done: 2, total: 4 });
    expect(themeProgress('AR-11', tasks)).toEqual({ done: 0, total: 1 });
    expect(themeProgress('AR-9', tasks)).toEqual({ done: 0, total: 0 });
  });

  it('never counts a theme as one of its own cards', () => {
    expect(themeProgress('AR-10', [theme('AR-12', { themeKey: 'AR-10' }), ...tasks])).toEqual({
      done: 2,
      total: 4,
    });
  });
});
