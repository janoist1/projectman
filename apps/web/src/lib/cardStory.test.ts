import { describe, expect, it } from 'vitest';
import type { BoardView, LabelView, TimelineEvent } from '@projectman/shared';
import {
  buildCardStory,
  isListedEvent,
  locateEvent,
  roundRows,
  storyWeight,
  STORY_ROW_LIMIT,
} from './cardStory';
import { indexPipeline } from './pipeline';
import type { TimelineContext } from './timeline';

// A pipeline that is not the standard one: three stages in two columns, so nothing leans on stage ids.
const pipeline = indexPipeline({
  stages: [
    { id: 'draft', name: 'Draft', kind: 'queue', columnId: 'early' },
    { id: 'build', name: 'Build', kind: 'work', columnId: 'late' },
    { id: 'ship', name: 'Ship', kind: 'done', columnId: 'late' },
  ],
  columns: [
    { id: 'early', name: 'Early', color: 'blue', stageIds: ['draft'] },
    { id: 'late', name: 'Late', color: 'green', stageIds: ['build', 'ship'] },
  ],
} as unknown as Pick<BoardView, 'stages' | 'columns'>);
const labels = [
  { id: 'approved', name: 'Approved', group: 'review', holders: [] },
  { id: 'tag', name: 'Tag', holders: [] },
] as unknown as LabelView[];
const ctx: TimelineContext = {
  pipeline,
  labels,
  members: new Map(),
  myHandle: 'me',
  openInboxIds: new Set(),
};

let counter = 0;
const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes)).toISOString();
function event(
  type: string,
  minutes: number,
  data: Record<string, unknown> = {},
  actor: TimelineEvent['actor'] = { kind: 'human', handle: 'owner' },
): TimelineEvent {
  return {
    id: `evt_${++counter}`,
    projectKey: 'AC',
    taskKey: 'AC-1',
    sessionId: null,
    actor,
    type,
    data,
    createdAt: at(minutes),
  } as TimelineEvent;
}
const move = (minutes: number, from: string, to: string, extra: Record<string, unknown> = {}) =>
  event('task_stage_changed', minutes, { from, to, ...extra });
const created = (minutes = 0) => event('task_created', minutes, { title: 'A card' });
const build = (events: TimelineEvent[], task: { stageId: string; status?: string } = { stageId: 'ship' }) =>
  buildCardStory({
    task: { stageId: task.stageId, status: task.status ?? 'active' } as never,
    events,
    ctx,
  });

describe('the rounds of a card (PM-1160)', () => {
  it('cuts the events at the stage moves and numbers a stage the card came back to', () => {
    const story = build(
      [created(), move(10, 'draft', 'build'), move(20, 'build', 'draft'), move(30, 'draft', 'build')],
      { stageId: 'build' },
    );
    expect(story.rounds.map((round) => [round.stageName, round.number, round.numbered])).toEqual([
      ['Draft', 1, true],
      ['Build', 1, true],
      ['Draft', 2, true],
      ['Build', 2, true],
    ]);
    expect(story.rounds.map((round) => round.outcome.kind)).toEqual([
      'forward',
      'back',
      'forward',
      'running',
    ]);
    // The colour of a round is its stage's column, from the pipeline.
    expect(story.rounds.map((round) => round.color)).toEqual(['blue', 'green', 'blue', 'green']);
    // The move starts the new round; it is that round's first event.
    expect(story.rounds[1]!.events[0]!.type).toBe('task_stage_changed');
  });

  it('does not number a stage the card visited once', () => {
    const story = build([created(), move(10, 'draft', 'build')], { stageId: 'build' });
    expect(story.rounds.map((round) => round.numbered)).toEqual([false, false]);
  });

  it('calls a move to a stage the pipeline no longer has "moved", and keeps the id as its name', () => {
    const story = build([created(), move(10, 'draft', 'gone')], { stageId: 'gone' });
    expect(story.rounds[0]!.outcome).toEqual({ kind: 'moved', stageId: 'gone' });
    expect(story.rounds[1]).toMatchObject({ stageName: 'gone', color: null });
  });

  it.each([
    ['done', false],
    ['cancelled', true],
  ])('ends the last round of a %s card as closed', (status, cancelled) => {
    const story = build([created(), move(10, 'draft', 'ship')], { stageId: 'ship', status });
    expect(story.rounds.at(-1)!.outcome).toEqual({ kind: 'closed', cancelled });
  });

  it('lists the people who wrote the round, not the system', () => {
    const story = build(
      [
        created(),
        event('session_started', 1, {}, { kind: 'system', handle: null }),
        event('task_note', 2, { text: 'x' }, { kind: 'ai', handle: 'dev' }),
        event('task_note', 3, { text: 'y' }, { kind: 'ai', handle: 'dev' }),
      ],
      { stageId: 'draft' },
    );
    expect(story.rounds[0]!.actors).toEqual(['owner', 'dev']);
  });

  it('gives a theme one round without a stage', () => {
    const story = buildCardStory({
      task: { stageId: 'draft', status: 'active' } as never,
      events: [created(), move(10, 'draft', 'build')],
      theme: true,
      ctx,
    });
    expect(story.rounds).toHaveLength(1);
    expect(story.rounds[0]).toMatchObject({ stageId: null, stageName: '' });
  });

  it('works without a pipeline: the stage ids name the rounds, every move is "moved"', () => {
    const story = buildCardStory({
      task: { stageId: 'build', status: 'active' } as never,
      events: [created(), move(10, 'draft', 'build')],
      ctx: { ...ctx, pipeline: null },
    });
    expect(story.rounds.map((round) => round.stageName)).toEqual(['draft', 'build']);
    expect(story.rounds[0]!.outcome.kind).toBe('moved');
  });
});

describe('what a round amounts to', () => {
  const summary = (events: TimelineEvent[]) =>
    build([created(), ...events, move(90, 'draft', 'build')], { stageId: 'build' }).rounds[0]!.summary;

  it('takes a result label first, with the note of its event', () => {
    expect(
      summary([
        event('task_note', 5, { text: 'A later note' }),
        event('task_labels_changed', 6, {
          added: ['approved'],
          removed: [],
          noteExcerpt: 'Looks fine\nmore',
        }),
      ]),
    ).toBe('Approved: Looks fine');
  });

  it('takes the note of the closing move next, then the last note', () => {
    const closing = move(90, 'draft', 'build', { noteExcerpt: 'Sent on' });
    const withClosing = build([created(), event('task_note', 5, { text: 'Own note' }), closing], {
      stageId: 'build',
    });
    expect(withClosing.rounds[0]!.summary).toBe('Sent on');
    expect(
      summary([event('task_note', 5, { text: 'First' }), event('task_note', 6, { text: 'Last\nline' })]),
    ).toBe('Last');
  });

  it('takes a failed or handed-over step before other events, and any essence after that', () => {
    const failed = event('task_full_test', 5, { outcome: 'failed' });
    expect(summary([failed, event('task_assigned', 6, { assignee: 'dev' })])).toBeTruthy();
    expect(summary([event('task_assigned', 6, { assignee: 'dev' })])).toEqual(expect.any(String));
  });

  it('is empty when only noise happened', () => {
    expect(summary([event('session_started', 5, {})])).toBeNull();
  });
});

describe('the weight of an event', () => {
  it.each([
    ['a note', event('task_note', 1, { text: 'x' }), 'essence'],
    ['a result label', event('task_labels_changed', 1, { added: ['approved'] }), 'essence'],
    ['a plain label', event('task_labels_changed', 1, { added: ['tag'] }), 'noise'],
    [
      'a label with a note',
      event('task_labels_changed', 1, { added: ['tag'], noteExcerpt: 'why' }),
      'essence',
    ],
    ['a plain move', move(1, 'draft', 'build'), 'noise'],
    ['a move with a note', move(1, 'draft', 'build', { noteExcerpt: 'why' }), 'essence'],
    ['a failed step', event('task_full_test', 1, { outcome: 'failed' }), 'essence'],
    ['a step that ran', event('task_full_test', 1, { outcome: 'passed' }), 'noise'],
    ['a type it does not know', event('something_new', 1, {}), 'noise'],
    ['a message from a member', event('team_message', 1, { text: 'x' }), 'essence'],
    [
      'a message the system sent',
      event('team_message', 1, { text: 'x' }, { kind: 'system', handle: null }),
      'noise',
    ],
  ] as const)('is %s: %s', (_name, subject, expected) => {
    expect(storyWeight(subject, ctx)).toBe(expected);
  });

  it('leaves out a session restart and nothing else', () => {
    expect(isListedEvent(event('session_ended', 1, { stop: { kind: 'restart' } }))).toBe(false);
    expect(isListedEvent(event('session_ended', 1, { stop: { kind: 'finished' } }))).toBe(true);
  });
});

describe('the events before the loaded window', () => {
  it('puts them in their rounds, oldest first, and marks only the rounds that miss events', () => {
    const early = [move(10, 'draft', 'build')];
    const story = buildCardStory({
      task: { stageId: 'ship', status: 'active' } as never,
      earlierEvents: early,
      events: [event('task_note', 20, { text: 'in build' }), move(30, 'build', 'ship')],
      ctx,
    });
    expect(story.rounds.map((round) => [round.stageName, round.partial])).toEqual([
      ['Build', true],
      ['Ship', false],
    ]);
    expect(story.rounds[0]!.events.map((entry) => entry.type)).toEqual(['task_stage_changed', 'task_note']);
  });

  it('shows no partial mark when the creation is known', () => {
    const story = build([created(), move(10, 'draft', 'build')], { stageId: 'build' });
    expect(story.rounds.some((round) => round.partial)).toBe(false);
  });

  it('lists an event that is in both lists once', () => {
    const shared = move(10, 'draft', 'build');
    const story = buildCardStory({
      task: { stageId: 'build', status: 'active' } as never,
      earlierEvents: [shared],
      events: [shared],
      ctx,
    });
    expect(story.rounds.flatMap((round) => round.events)).toHaveLength(1);
  });
});

describe('the first story of a card', () => {
  it('is "first" while nothing but the creation is there, and not after a note', () => {
    expect(build([created()], { stageId: 'draft' }).first).toBe(true);
    expect(build([created(), event('task_note', 1, { text: 'x' })], { stageId: 'draft' }).first).toBe(false);
  });
});

describe('the rows of a round', () => {
  const noisy = () => [
    created(),
    event('session_started', 1, {}),
    event('session_started', 2, {}),
    event('task_note', 3, { text: 'x' }),
    event('session_started', 4, {}),
  ];

  it('folds the noise between the essence into runs, and shows everything in the "all" view', () => {
    const [round] = build(noisy(), { stageId: 'draft' }).rounds;
    expect(
      roundRows(round!, 'essence', ctx).map((row) => [
        row.kind,
        row.kind === 'noise' ? row.events.length : 1,
      ]),
    ).toEqual([
      ['event', 1],
      ['noise', 2],
      ['event', 1],
      ['noise', 1],
    ]);
    expect(roundRows(round!, 'all', ctx).every((row) => row.kind === 'event')).toBe(true);
  });

  it('finds where an event hides: in a noise run, or behind the older rows', () => {
    const events = [created(), event('session_started', 1, {})];
    for (let index = 0; index < STORY_ROW_LIMIT + 2; index++)
      events.push(event('task_note', 2 + index, { text: 'n' }));
    const story = build(events, { stageId: 'draft' });
    const round = story.rounds[0]!;
    expect(locateEvent(story, events[1]!.id, 'essence', ctx)).toEqual({
      roundKey: round.key,
      noise: true,
      earlier: true,
    });
    expect(locateEvent(story, events.at(-1)!.id, 'essence', ctx)).toMatchObject({
      noise: false,
      earlier: false,
    });
    expect(locateEvent(story, 'nothing', 'essence', ctx)).toBeNull();
  });
});
