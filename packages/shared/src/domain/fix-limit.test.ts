import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_FIX_ROUNDS, ProjectConfig, TeamLimits } from '../config/schema';
import {
  countFixRounds,
  fixLimitDeciders,
  fixLimitLead,
  fixLimitPlanner,
  fixLimitPlannerForOwner,
  fixLimitReached,
  maxFixRoundsOf,
} from './fix-limit';
import type { TimelineEvent } from './event';

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
    });
  });

  it('counts only what happened after the start of the count', () => {
    expect(countFixRounds(events, config(), at(3))).toEqual({
      rounds: 1,
      changeRequests: 0,
      designChangeRequests: 1,
      sendBacks: 0,
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
});
