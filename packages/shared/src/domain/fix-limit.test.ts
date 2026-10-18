import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_FIX_ROUNDS, ProjectConfig, TeamLimits } from '../config/schema';
import {
  MAX_FIX_EXTRA_ROUNDS,
  FixLimitAssessment,
  remainingFixExtraRounds,
  countFixRounds,
  fixRoundHistory,
  FixRoundHistoryEntry,
  fixLimitDeciders,
  fixLimitLead,
  fixLimitPlanner,
  fixLimitPlannerForOwner,
  fixLimitReached,
  maxFixRoundsOf,
} from './fix-limit';
import type { TimelineEvent } from './event';
import { CardRounds, countCardRounds } from './card-measure';

function config(members: object[] = []) {
  return ProjectConfig.parse({
    schemaVersion: 1,
    project: { key: 'EX', name: 'Example', workspacePath: '/tmp/example', repos: [] },
    team: {
      members: [
        {
          kind: 'human',
          handle: 'owner',
          displayName: 'Owner',
          access: 'owner',
          roles: ['operator', 'product_owner'],
        },
        { kind: 'ai', handle: 'dev', displayName: 'Dev', role: 'developer', sponsor: 'owner' },
        { kind: 'ai', handle: 'lead', displayName: 'Lead', role: 'lead_developer', sponsor: 'owner' },
        { kind: 'ai', handle: 'arch', displayName: 'Arch', role: 'architect', sponsor: 'owner' },
        ...members,
      ],
      limits: {},
    },
    pipeline: {
      columns: [{ id: 'all', name: 'All' }],
      stages: [
        { id: 'queue', name: 'Queue', kind: 'queue', columnId: 'all' },
        { id: 'dev', name: 'Dev', kind: 'work', owners: ['dev'], columnId: 'all' },
        { id: 'cr', name: 'Review', kind: 'step', owners: ['lead'], columnId: 'all' },
        { id: 'done', name: 'Done', kind: 'done', columnId: 'all' },
      ],
      labels: [],
    },
  });
}

type Event = Pick<TimelineEvent, 'type' | 'data' | 'createdAt'>;
const at = (minutes: number) =>
  new Date(Date.parse('2026-10-03T08:00:00.000Z') + minutes * 60_000).toISOString();
const move = (minutes: number, from: string, to: string): Event => ({
  type: 'task_stage_changed',
  data: { from, to },
  createdAt: at(minutes),
});
const labelled = (minutes: number, ...added: string[]): Event => ({
  type: 'task_labels_changed',
  data: { added, removed: [] },
  createdAt: at(minutes),
});

describe('countFixRounds (PM-262)', () => {
  const events: Event[] = [
    move(0, 'queue', 'dev'),
    move(1, 'dev', 'cr'),
    labelled(2, 'code-review-changes'),
    move(3, 'cr', 'dev'),
    move(4, 'dev', 'cr'),
    labelled(5, 'design-review-changes'),
    labelled(6, 'code-review-ok'),
  ];

  it('counts the change requests of both reviews and the send-backs together', () => {
    expect(countFixRounds(events, config(), null)).toEqual({
      rounds: 3,
      changeRequests: 1,
      designChangeRequests: 1,
      sendBacks: 1,
      testsFailed: 0,
    });
  });

  it('counts only what happened after the start of the count', () => {
    expect(countFixRounds(events, config(), at(3))).toEqual({
      rounds: 1,
      changeRequests: 0,
      designChangeRequests: 1,
      sendBacks: 0,
      testsFailed: 0,
    });
    expect(countFixRounds(events, config(), at(10)).rounds).toBe(0);
  });

  it('ignores other events and a label that was only removed', () => {
    const other: Event[] = [
      { type: 'team_message', data: {}, createdAt: at(1) },
      {
        type: 'task_labels_changed',
        data: { added: [], removed: ['code-review-changes'] },
        createdAt: at(2),
      },
    ];
    expect(countFixRounds(other, config(), null).rounds).toBe(0);
  });
});

describe('round sources (PM-800)', () => {
  const event = (
    id: string,
    type: TimelineEvent['type'],
    data: Record<string, unknown>,
    minute = 1,
  ): TimelineEvent => ({
    id,
    type,
    data,
    createdAt: at(minute),
    projectKey: 'EX',
    taskKey: 'EX-1',
    sessionId: null,
    actor: { kind: 'ai', handle: 'lead' },
  });
  const technical = event('technical', 'task_stage_changed', {
    from: 'cr',
    to: 'dev',
    branchMoved: { branch: 'task', pinned: 'old', head: 'new' },
  });

  it('excludes technical send-backs and handovers, preserving review entry counts', () => {
    const events = [move(0, 'dev', 'cr'), technical, move(2, 'dev', 'cr')];
    expect(countFixRounds(events, config(), null).rounds).toBe(0);
    expect(countCardRounds(events, config())).toMatchObject({
      reviewRounds: 2,
      sendBacks: 0,
      testsFailed: 0,
    });
  });

  it('counts failed tests once, both review labels individually and manual send-backs', () => {
    const events = [
      technical,
      event('test', 'task_stage_changed', {
        from: 'cr',
        to: 'dev',
        testsFailed: { runId: 'r', commit: 'c', branch: 'b' },
      }),
      labelled(1, 'code-review-changes', 'design-review-changes'),
      move(1, 'cr', 'dev'),
    ];
    expect(countFixRounds(events, config(), null)).toEqual({
      rounds: 4,
      changeRequests: 1,
      designChangeRequests: 1,
      sendBacks: 2,
      testsFailed: 1,
    });
    expect(countFixRounds(events, config(), at(1)).rounds).toBe(0);
    expect(CardRounds.parse({ reviewRounds: 0, changeRequests: 0, sendBacks: 0 }).testsFailed).toBe(0);
    expect(
      CardRounds.safeParse({ reviewRounds: 0, changeRequests: 0, sendBacks: 0, testsFailed: -1 }).success,
    ).toBe(false);
  });

  it('keeps source order at equal times and joins the exact run, preserving technical and grant rows', () => {
    const events = [
      event('result', 'task_full_test', { runId: 'r1', command: 'npm test', failedFiles: ['right.test.ts'] }),
      event('other', 'task_full_test', { runId: 'r2', command: 'wrong', failedFiles: ['wrong.test.ts'] }),
      event('labels', 'task_labels_changed', {
        added: ['code-review-changes', 'design-review-changes'],
        noteExcerpt: '  \n First reason\nSecond reason',
      }),
      event('failure', 'task_stage_changed', {
        from: 'cr',
        to: 'dev',
        testsFailed: { runId: 'r1', commit: 'c1', branch: 'task' },
      }),
      technical,
      event('grant', 'task_fix_limit', {
        phase: 'decided',
        decision: 'another_round',
        note: '  More time\nDetails',
      }),
      event('planner', 'task_fix_limit', { phase: 'decided', decision: 'continue' }),
      event('grant2', 'task_fix_limit', { phase: 'decided', decision: 'another_round' }),
      event('unrelated-note', 'task_note', { text: 'Do not infer this reason' }),
      event('manual', 'task_stage_changed', { from: 'cr', to: 'dev' }),
    ];
    const history = fixRoundHistory(events, config(), null);
    expect(history.map((entry) => [entry.eventId, entry.kind, entry.round])).toEqual([
      ['labels', 'code_review', 1],
      ['labels', 'design_review', 2],
      ['failure', 'tests_failed', 3],
      ['technical', 'branch_moved', null],
      ['grant', 'extra_round', null],
      ['grant2', 'extra_round', null],
      ['manual', 'send_back', 4],
    ]);
    expect(history[0]?.note).toBe('First reason');
    expect(history[2]).toMatchObject({
      runId: 'r1',
      commit: 'c1',
      command: 'npm test',
      failedFiles: ['right.test.ts'],
      note: null,
    });
    expect(history[3]).toMatchObject({ branch: 'task', pinned: 'old', head: 'new' });
    expect(history[4]).toMatchObject({ extraRound: 1, note: 'More time' });
    expect(history[5]).toMatchObject({ extraRound: 2, note: null });
    expect(history[6]?.note).toBeNull();
    expect(history.every((entry) => FixRoundHistoryEntry.safeParse(entry).success)).toBe(true);
    expect(fixRoundHistory(events, config(), at(1))).toEqual([]);
  });

  it('keeps missing legacy failure details absent and restarts numbering after since', () => {
    const history = fixRoundHistory(
      [
        event('old', 'task_fix_limit', { phase: 'decided', decision: 'another_round' }, 0),
        event(
          'failure',
          'task_stage_changed',
          { from: 'cr', to: 'dev', testsFailed: { runId: 'missing', branch: 'b', commit: 'c' } },
          2,
        ),
        event('grant', 'task_fix_limit', { phase: 'decided', decision: 'another_round' }, 2),
      ],
      config(),
      at(0),
    );
    expect(history[0]).toMatchObject({ round: 1, runId: 'missing', commit: 'c', note: null });
    expect(history[0]).not.toHaveProperty('command');
    expect(history[0]).not.toHaveProperty('failedFiles');
    expect(history[1]?.extraRound).toBe(1);
  });
});

describe('the limit', () => {
  it('is three by default and can be set from one to ten', () => {
    expect(DEFAULT_MAX_FIX_ROUNDS).toBe(3);
    expect(maxFixRoundsOf(undefined)).toBe(3);
    expect(maxFixRoundsOf({})).toBe(3);
    expect(maxFixRoundsOf({ maxFixRounds: 5 })).toBe(5);
    expect(TeamLimits.safeParse({ maxFixRounds: 0 }).success).toBe(false);
    expect(TeamLimits.safeParse({ maxFixRounds: 11 }).success).toBe(false);
    expect(TeamLimits.safeParse({ maxFixRounds: 1.5 }).success).toBe(false);
    expect(TeamLimits.safeParse({ maxFixRounds: 10 }).success).toBe(true);
  });

  it('holds at the limit plus the extra rounds people gave', () => {
    expect(fixLimitReached(2, 3, 0)).toBe(false);
    expect(fixLimitReached(3, 3, 0)).toBe(true);
    expect(fixLimitReached(3, 3, 1)).toBe(false);
    expect(fixLimitReached(4, 3, 1)).toBe(true);
  });
});

describe('who decides', () => {
  it('picks the AI member with technical direction and code review who is not the assignee', () => {
    expect(fixLimitLead(config(), ['dev'])).toBe('lead');
    expect(fixLimitLead(config(), ['lead'])).toBeNull();
  });

  it('skips a lead on leave', () => {
    const away = config().team.members.map((member) =>
      member.handle === 'lead' ? { ...member, onLeave: true } : member,
    );
    const onLeave = ProjectConfig.parse({ ...config(), team: { ...config().team, members: away } });
    expect(fixLimitLead(onLeave, ['dev'])).toBeNull();
  });

  it('picks the planner among the others with technical direction', () => {
    expect(fixLimitPlanner(config(), ['dev', 'lead'])).toBe('arch');
    expect(fixLimitPlanner(config(), ['dev', 'lead', 'arch'])).toBeNull();
  });

  it('asks for the more exact plan of a person from the planner, not the lead who passed the card on', () => {
    expect(fixLimitPlannerForOwner(config(), 'dev')).toBe('arch');
    expect(fixLimitPlannerForOwner(config(), 'arch')).toBeNull();
  });

  it('sends the people decision to the owners with the duty, else to the owners', () => {
    expect(fixLimitDeciders(config(), ['owner'])).toEqual(['owner']);
    const admin = {
      kind: 'human',
      handle: 'boss',
      displayName: 'Boss',
      access: 'admin',
      roles: ['lead_developer'],
    };
    expect(fixLimitDeciders(config([admin]), ['owner'])).toEqual(['boss']);
  });

  it('counts the lead’s extra rounds against a fixed cap of three', () => {
    expect(MAX_FIX_EXTRA_ROUNDS).toBe(3);
    expect([0, 1, 2, 3, 4].map(remainingFixExtraRounds)).toEqual([3, 2, 1, 0, 0]);
  });

  it('requires every part of the assessment, trimmed, and an executable outcome id', () => {
    const good = {
      recurrence: ' The same test fails again. ',
      currentState: 'Half done.',
      recommendation: { optionId: 'reassign', reason: 'A fresh view.' },
    };
    expect(FixLimitAssessment.parse(good).recurrence).toBe('The same test fails again.');
    for (const bad of [
      {},
      { ...good, recurrence: '   ' },
      { ...good, currentState: undefined },
      { ...good, recommendation: undefined },
      { ...good, recommendation: { optionId: 'to_owner', reason: 'x' } },
      { ...good, recommendation: { optionId: 'reassign', reason: '' } },
      { ...good, recurrence: 'x'.repeat(2001) },
    ])
      expect(FixLimitAssessment.safeParse(bad).success).toBe(false);
  });
});
