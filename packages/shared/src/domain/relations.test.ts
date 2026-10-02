import { describe, expect, it } from 'vitest';
import {
  duplicateMarkRefusal,
  hasRelated,
  openPrerequisites,
  planRelations,
  relationRefusal,
  storedRelation,
  taskRelations,
  THEME_REFUSED_KINDS,
} from './relations';
import type { RelationCard } from './relations';
import type { TaskLink } from './task';

function card(
  key: string,
  extra: Partial<Pick<RelationCard, 'parentKey' | 'status' | 'stageId' | 'projectKey'>> = {},
  links: TaskLink[] = [],
): RelationCard {
  return {
    key,
    title: `Title of ${key}`,
    stageId: 'dev',
    status: 'active',
    projectKey: 'PM',
    parentKey: null,
    links,
    ...extra,
  };
}

const needs = (key: string): TaskLink => ({ kind: 'prerequisite', ref: key });
const related = (key: string): TaskLink => ({ kind: 'related', ref: key });
const duplicateOf = (key: string): TaskLink => ({ kind: 'duplicate_of', ref: key });

describe('taskRelations', () => {
  it('reads every stored kind from both of its cards', () => {
    const tasks = [
      card('PM-1'),
      card('PM-2', { parentKey: 'PM-1' }),
      card('PM-3', {}, [needs('PM-2')]),
      card('PM-4', {}, [related('PM-2')]),
      card('PM-5', {}, [duplicateOf('PM-2')]),
      card('PM-6', {}, [needs('PM-3'), related('PM-1')]),
    ];
    const two = tasks[1]!;
    expect(taskRelations(two, tasks).map((r) => `${r.kind} ${r.key}`)).toEqual([
      'part_of PM-1',
      'prerequisite_of PM-3',
      'related PM-4',
      'duplicated_by PM-5',
    ]);
    const three = tasks[2]!;
    expect(taskRelations(three, tasks).map((r) => `${r.kind} ${r.key}`)).toEqual([
      'prerequisite PM-2',
      'prerequisite_of PM-6',
    ]);
    const one = tasks[0]!;
    expect(taskRelations(one, tasks).map((r) => `${r.kind} ${r.key}`)).toEqual([
      'has_part PM-2',
      'related PM-6',
    ]);
    const five = tasks[4]!;
    expect(taskRelations(five, tasks).map((r) => `${r.kind} ${r.key}`)).toEqual(['duplicate_of PM-2']);
  });

  it('carries the title, stage and status of the other card', () => {
    const tasks = [card('PM-1', {}, [needs('PM-2')]), card('PM-2', { stageId: 'qa', status: 'done' })];
    expect(taskRelations(tasks[0]!, tasks)).toEqual([
      { kind: 'prerequisite', key: 'PM-2', title: 'Title of PM-2', stageId: 'qa', status: 'done' },
    ]);
  });

  it('lists cards by their number, not as text, and a mutual related pair once', () => {
    const tasks = [
      card('PM-1', {}, [related('PM-10'), related('PM-9')]),
      card('PM-9', {}, [related('PM-1')]),
      card('PM-10'),
    ];
    expect(taskRelations(tasks[0]!, tasks).map((r) => r.key)).toEqual(['PM-9', 'PM-10']);
  });

  it('leaves out a card that is not among the given ones', () => {
    const tasks = [card('PM-1', { parentKey: 'PM-9' }, [needs('PM-8'), related('PM-2')]), card('PM-2')];
    expect(taskRelations(tasks[0]!, tasks).map((r) => r.key)).toEqual(['PM-2']);
  });
});

describe('openPrerequisites', () => {
  it('names the prerequisites that are not done or cancelled', () => {
    const tasks = [
      card('PM-2', { status: 'done' }),
      card('PM-3', { status: 'cancelled' }),
      card('PM-4', { status: 'blocked' }),
      card('PM-5'),
    ];
    const task = card('PM-9', {}, [
      needs('PM-5'),
      needs('PM-2'),
      needs('PM-3'),
      needs('PM-4'),
      related('PM-5'),
    ]);
    expect(openPrerequisites(task, tasks).map((c) => c.key)).toEqual(['PM-4', 'PM-5']);
  });

  it('is empty without prerequisites', () => {
    expect(openPrerequisites(card('PM-1'), [card('PM-2')])).toEqual([]);
  });
});

describe('relationRefusal', () => {
  const from = { key: 'PM-1', projectKey: 'PM' };

  it.each(['part_of', 'prerequisite', 'related', 'duplicate_of'] as const)(
    'refuses a %s to the card itself',
    (kind) => {
      const tasks = [card('PM-1')];
      const refusal = relationRefusal(kind, from, 'PM-1', tasks);
      expect(refusal?.code).toBe(kind === 'part_of' ? 'subtask_self_parent' : 'relation_self');
    },
  );

  it.each(['prerequisite', 'related', 'duplicate_of'] as const)('refuses a %s to a missing card', (kind) => {
    expect(relationRefusal(kind, from, 'PM-9', [card('PM-1')])?.code).toBe('relation_target_not_found');
  });

  it.each(['prerequisite', 'related', 'duplicate_of'] as const)(
    'refuses a %s to a card of another project',
    (kind) => {
      const tasks = [card('PM-1'), card('OT-2', { projectKey: 'OT' })];
      expect(relationRefusal(kind, from, 'OT-2', tasks)?.code).toBe('relation_target_project');
    },
  );

  it('allows a prerequisite, a related and a duplicate between two cards of the project', () => {
    const tasks = [card('PM-1'), card('PM-2')];
    for (const kind of ['prerequisite', 'related', 'duplicate_of'] as const)
      expect(relationRefusal(kind, from, 'PM-2', tasks)).toBeNull();
  });

  it('refuses on a theme exactly the kinds of THEME_REFUSED_KINDS, and the others to a card', () => {
    const theme = { ...card('PM-1'), kind: 'theme' as const };
    const tasks = [theme, card('PM-2')];
    for (const kind of ['part_of', 'prerequisite', 'related', 'duplicate_of'] as const) {
      const refused = relationRefusal(kind, from, 'PM-2', tasks) !== null;
      // A theme duplicates only a theme, so the card target refuses `duplicate_of` too.
      expect(refused).toBe(THEME_REFUSED_KINDS.includes(kind) || kind === 'duplicate_of');
    }
    expect(relationRefusal('related', from, 'PM-2', tasks)).toBeNull();
  });

  it('refuses a prerequisite that closes a loop of two cards, and names it', () => {
    const tasks = [card('PM-1'), card('PM-2', {}, [needs('PM-1')])];
    expect(relationRefusal('prerequisite', from, 'PM-2', tasks)).toEqual({
      code: 'relation_cycle',
      path: ['PM-1', 'PM-2', 'PM-1'],
    });
  });

  it('refuses a prerequisite that closes a loop through three cards', () => {
    const tasks = [card('PM-1'), card('PM-2', {}, [needs('PM-3')]), card('PM-3', {}, [needs('PM-1')])];
    expect(relationRefusal('prerequisite', from, 'PM-2', tasks)).toEqual({
      code: 'relation_cycle',
      path: ['PM-1', 'PM-2', 'PM-3', 'PM-1'],
    });
  });

  it('allows a prerequisite chain that is not a loop, and a card needed twice', () => {
    const tasks = [
      card('PM-1'),
      card('PM-2', {}, [needs('PM-3'), needs('PM-4')]),
      card('PM-3', {}, [needs('PM-4')]),
      card('PM-4'),
    ];
    expect(relationRefusal('prerequisite', from, 'PM-2', tasks)).toBeNull();
  });

  it('does not take a related or a duplicate link for a prerequisite loop', () => {
    const tasks = [card('PM-1'), card('PM-2', {}, [related('PM-1'), duplicateOf('PM-1')])];
    expect(relationRefusal('prerequisite', from, 'PM-2', tasks)).toBeNull();
  });

  it('refuses a duplicate of a card that is a duplicate itself, and names the original', () => {
    const tasks = [card('PM-1'), card('PM-2', { status: 'cancelled' }, [duplicateOf('PM-3')]), card('PM-3')];
    expect(relationRefusal('duplicate_of', from, 'PM-2', tasks)).toEqual({
      code: 'relation_duplicate_of_duplicate',
      original: 'PM-3',
    });
  });

  it('keeps the subtask rules for part_of', () => {
    const tasks = [
      card('PM-1'),
      card('PM-2', { parentKey: 'PM-3' }),
      card('PM-3'),
      card('PM-4', { parentKey: 'PM-1' }),
    ];
    expect(relationRefusal('part_of', from, 'PM-2', tasks)?.code).toBe('subtask_parent_is_subtask');
    expect(relationRefusal('part_of', from, 'PM-9', tasks)?.code).toBe('subtask_parent_not_found');
    expect(relationRefusal('part_of', from, 'PM-3', tasks)?.code).toBe('subtask_has_children');
  });

  it('refuses part_of to another project, and a second parent', () => {
    const tasks = [
      card('PM-1'),
      card('OT-2', { projectKey: 'OT' }),
      card('PM-3', { parentKey: 'PM-4' }),
      card('PM-4'),
    ];
    expect(relationRefusal('part_of', from, 'OT-2', tasks)?.code).toBe('subtask_parent_project');
    expect(relationRefusal('part_of', { key: 'PM-3', projectKey: 'PM' }, 'PM-1', tasks)).toEqual({
      code: 'relation_parent_exists',
      parent: 'PM-4',
    });
  });

  it('checks a card that is being created: nothing points at it yet', () => {
    const tasks = [card('PM-2', {}, [needs('PM-3')]), card('PM-3')];
    const creating = { key: null, projectKey: 'PM' };
    expect(relationRefusal('prerequisite', creating, 'PM-2', tasks)).toBeNull();
    expect(relationRefusal('prerequisite', creating, 'PM-9', tasks)?.code).toBe('relation_target_not_found');
    expect(relationRefusal('part_of', creating, 'PM-2', tasks)).toBeNull();
  });
});

describe('storedRelation', () => {
  const tasks = [
    card('PM-1'),
    card('PM-2', { parentKey: 'PM-1' }, [needs('PM-3'), duplicateOf('PM-4'), related('PM-5')]),
    card('PM-3'),
    card('PM-4'),
    card('PM-5'),
  ];
  const [one, two, three, four, five] = tasks as [
    RelationCard,
    RelationCard,
    RelationCard,
    RelationCard,
    RelationCard,
  ];

  it('finds where each view kind is stored, from either card', () => {
    expect(storedRelation('part_of', two, one)).toEqual({ stored: 'parent', owner: 'PM-2', target: 'PM-1' });
    expect(storedRelation('has_part', one, two)).toEqual({ stored: 'parent', owner: 'PM-2', target: 'PM-1' });
    expect(storedRelation('prerequisite', two, three)).toEqual({
      stored: 'prerequisite',
      owner: 'PM-2',
      target: 'PM-3',
    });
    expect(storedRelation('prerequisite_of', three, two)).toEqual({
      stored: 'prerequisite',
      owner: 'PM-2',
      target: 'PM-3',
    });
    expect(storedRelation('duplicate_of', two, four)).toEqual({
      stored: 'duplicate_of',
      owner: 'PM-2',
      target: 'PM-4',
    });
    expect(storedRelation('duplicated_by', four, two)).toEqual({
      stored: 'duplicate_of',
      owner: 'PM-2',
      target: 'PM-4',
    });
    expect(storedRelation('related', five, two)).toEqual({
      stored: 'related',
      owner: 'PM-2',
      target: 'PM-5',
    });
    expect(storedRelation('related', two, five)).toEqual({
      stored: 'related',
      owner: 'PM-2',
      target: 'PM-5',
    });
  });

  it('is null when the cards have no such relation, in that direction', () => {
    expect(storedRelation('prerequisite', three, two)).toBeNull();
    expect(storedRelation('part_of', one, two)).toBeNull();
    expect(storedRelation('related', one, three)).toBeNull();
    expect(storedRelation('part_of', one, undefined)).toBeNull();
  });
});

describe('hasRelated', () => {
  it('sees a related pair stored on either card', () => {
    const a = card('PM-1', {}, [related('PM-2')]);
    const b = card('PM-2');
    expect(hasRelated(a, b)).toBe(true);
    expect(hasRelated(b, a)).toBe(true);
    expect(hasRelated(a, card('PM-3'))).toBe(false);
  });
});

describe('duplicateMarkRefusal', () => {
  const open = { status: 'active' } as const;

  it('lets anyone who may edit mark a card that has not started: waiting in a queue, no live session', () => {
    expect(
      duplicateMarkRefusal({ task: open, stageKind: 'queue', hasLiveSession: false, mayCancel: false }),
    ).toBeNull();
  });

  it('lets only whoever may cancel mark a card with a live session', () => {
    const input = { task: open, stageKind: 'queue', hasLiveSession: true } as const;
    expect(duplicateMarkRefusal({ ...input, mayCancel: false })).toBe('duplicate_not_allowed');
    expect(duplicateMarkRefusal({ ...input, mayCancel: true })).toBeNull();
  });

  it.each(['work', 'step', 'release'] as const)(
    'lets only whoever may cancel mark a card in a %s stage',
    (stageKind) => {
      const input = { task: open, stageKind, hasLiveSession: false } as const;
      expect(duplicateMarkRefusal({ ...input, mayCancel: false })).toBe('duplicate_not_allowed');
      expect(duplicateMarkRefusal({ ...input, mayCancel: true })).toBeNull();
    },
  );

  it('treats a card in a stage the pipeline does not have as started', () => {
    expect(
      duplicateMarkRefusal({ task: open, stageKind: undefined, hasLiveSession: false, mayCancel: false }),
    ).toBe('duplicate_not_allowed');
  });

  it.each(['done', 'cancelled'] as const)(
    'needs no right to cancel for a %s card: only the relation is made',
    (status) => {
      expect(
        duplicateMarkRefusal({ task: { status }, stageKind: 'work', hasLiveSession: true, mayCancel: false }),
      ).toBeNull();
    },
  );
});

describe('planRelations', () => {
  const cards = [
    card('PM-1'),
    card('PM-2', {}, [needs('PM-3')]),
    card('PM-3'),
    card('PM-4', { parentKey: 'PM-1' }),
    card('OT-1', { projectKey: 'OT' }),
  ];
  const plan = (
    key: string,
    change: Parameters<typeof planRelations>[0]['change'],
    markDuplicate: () => 'duplicate_not_allowed' | null = () => null,
  ) =>
    planRelations({
      task: cards.find((c) => c.key === key)!,
      cards: cards.filter((c) => c.projectKey === 'PM'),
      elsewhere: (other) => cards.find((c) => c.key === other),
      change,
      markDuplicate,
    });

  it('plans removals before additions, against what the earlier steps left', () => {
    expect(
      plan('PM-2', {
        remove: [{ kind: 'prerequisite', key: 'PM-3' }],
        add: [{ kind: 'related', key: 'PM-3' }],
      }),
    ).toEqual({
      ok: true,
      closes: false,
      steps: [
        { type: 'link_remove', owner: 'PM-2', kind: 'prerequisite', ref: 'PM-3' },
        { type: 'link_add', owner: 'PM-2', kind: 'related', ref: 'PM-3' },
      ],
    });
  });

  it('refuses the later of two steps of one call that contradict each other', () => {
    expect(
      plan('PM-3', {
        add: [
          { kind: 'prerequisite', key: 'PM-1' },
          { kind: 'prerequisite', key: 'PM-2' },
        ],
      }),
    ).toMatchObject({ ok: false, key: 'PM-2', refusal: { code: 'relation_cycle' } });
  });

  it('skips what is stored already, and asks about the duplicate only when it marks one', () => {
    const asked: string[] = [];
    const ask = () => {
      asked.push('asked');
      return null;
    };
    expect(plan('PM-2', { add: [{ kind: 'prerequisite', key: 'PM-3' }] }, ask)).toMatchObject({
      ok: true,
      steps: [],
    });
    expect(asked).toEqual([]);
    expect(plan('PM-2', { add: [{ kind: 'duplicate_of', key: 'PM-3' }] }, ask)).toMatchObject({
      ok: true,
      closes: true,
      steps: [{ type: 'link_add' }, { type: 'duplicate_close', original: 'PM-3' }],
    });
    expect(asked).toEqual(['asked']);
  });

  it('refuses a duplicate the actor may not mark, a missing relation, and a card of another project', () => {
    expect(
      plan('PM-2', { add: [{ kind: 'duplicate_of', key: 'PM-3' }] }, () => 'duplicate_not_allowed'),
    ).toEqual({ ok: false, key: 'PM-3', refusal: { code: 'duplicate_not_allowed' } });
    expect(plan('PM-2', { remove: [{ kind: 'related', key: 'PM-3' }] })).toEqual({
      ok: false,
      key: 'PM-3',
      refusal: { code: 'relation_not_found', kind: 'related' },
    });
    expect(plan('PM-2', { add: [{ kind: 'related', key: 'OT-1' }] })).toMatchObject({
      ok: false,
      refusal: { code: 'relation_target_project' },
    });
  });

  it('plans a subtask removed from its parent, and a card moved to another parent in one call', () => {
    expect(plan('PM-1', { remove: [{ kind: 'has_part', key: 'PM-4' }] })).toMatchObject({
      ok: true,
      steps: [{ type: 'parent', child: 'PM-4', parent: null }],
    });
    expect(
      plan('PM-4', {
        remove: [{ kind: 'part_of', key: 'PM-1' }],
        add: [{ kind: 'part_of', key: 'PM-3' }],
      }),
    ).toMatchObject({
      ok: true,
      steps: [
        { type: 'parent', child: 'PM-4', parent: null },
        { type: 'parent', child: 'PM-4', parent: 'PM-3' },
      ],
    });
  });
});
