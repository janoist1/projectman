import { describe, expect, it } from 'vitest';
import { ProjectConfig } from '../config/schema';
import {
  acceptanceLabels,
  acceptanceRefusal,
  MAX_ACCEPTANCE_ITEMS,
  type AcceptanceChange,
  type AcceptanceItem,
} from './acceptance';
import { itemProgress } from './item-state';
import type { Task } from './task';

function config() {
  return ProjectConfig.parse({
    schemaVersion: 1,
    project: { key: 'AC', name: 'Acme', workspacePath: '/work/acme', repos: [] },
    team: {
      members: [
        { kind: 'human', handle: 'owner', displayName: 'Owner', access: 'owner', roles: ['operator'] },
        { kind: 'ai', handle: 'dev-1', displayName: 'Developer', role: 'developer', sponsor: 'owner' },
        { kind: 'ai', handle: 'rev', displayName: 'Reviewer', role: 'code_review', sponsor: 'owner' },
      ],
      limits: {},
    },
    pipeline: {
      columns: [{ id: 'all', name: 'All' }],
      stages: [
        { id: 'backlog', name: 'Backlog', kind: 'queue', columnId: 'all' },
        { id: 'dev', name: 'Development', kind: 'work', duty: 'implementation', columnId: 'all' },
        { id: 'review', name: 'Review', kind: 'step', columnId: 'all' },
        {
          id: 'done',
          name: 'Done',
          kind: 'done',
          columnId: 'all',
          gate: { conditions: [{ type: 'has_label', label: 'review-ok' }] },
        },
      ],
      labels: [{ id: 'review-ok', name: 'Review ok', setBy: { duties: ['code_review'] }, notByAuthor: true }],
    },
  });
}

const task = (extra: Partial<Task> = {}) =>
  ({
    key: 'AC-1',
    projectKey: 'AC',
    kind: 'task',
    status: 'active',
    stageId: 'dev',
    assignee: 'dev-1',
    labels: [],
    links: [],
    ...extra,
  }) as unknown as Task;

const item = (extra: Partial<AcceptanceItem> = {}): AcceptanceItem => ({
  id: 'acc_abcdefghij',
  position: 0,
  text: 'It works',
  state: 'open',
  evidence: null,
  reason: null,
  movedTo: null,
  origin: null,
  markedBy: null,
  markedAt: null,
  confirmedBy: null,
  confirmedAt: null,
  createdBy: null,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
  ...extra,
});

const ID = 'acc_abcdefghij';
const human = { kind: 'human', handle: 'owner' } as const;
const dev = { kind: 'ai', handle: 'dev-1' } as const;
const reviewer = { kind: 'ai', handle: 'rev' } as const;
const target: Pick<Task, 'key' | 'projectKey' | 'status' | 'kind'> = {
  key: 'AC-2',
  projectKey: 'AC',
  status: 'active',
  kind: 'task',
};

type Case = [
  string,
  {
    change: AcceptanceChange;
    actor: { kind: 'human' | 'ai'; handle: string };
    task?: Task;
    item?: AcceptanceItem;
    count?: number;
    target?: Pick<Task, 'key' | 'projectKey' | 'status' | 'kind'> | null;
  },
  string | null,
];

describe('acceptanceRefusal', () => {
  it.each<Case>([
    [
      'a closed card takes no change',
      { change: { op: 'add', text: 'x' }, actor: human, task: task({ status: 'done' }) },
      'card_closed',
    ],
    ['an item can be added', { change: { op: 'add', text: 'x' }, actor: dev }, null],
    [
      'the item limit holds',
      { change: { op: 'add', text: 'x' }, actor: dev, count: MAX_ACCEPTANCE_ITEMS },
      'too_many',
    ],
    [
      'only an open item can be edited',
      {
        change: { op: 'edit', itemId: ID, text: 'y' },
        actor: dev,
        item: item({ state: 'done', evidence: 'e' }),
      },
      'not_open',
    ],
    [
      'an item can be removed before the work starts',
      { change: { op: 'remove', itemId: ID }, actor: dev, task: task({ stageId: 'backlog' }) },
      null,
    ],
    [
      'an AI cannot remove an item once the work started',
      { change: { op: 'remove', itemId: ID }, actor: dev },
      'remove_after_start',
    ],
    ['a person can always remove an item', { change: { op: 'remove', itemId: ID }, actor: human }, null],
    [
      'the assignee marks an item done',
      { change: { op: 'done', itemId: ID, evidence: 'e' }, actor: dev, item: item() },
      null,
    ],
    [
      'somebody else cannot mark an item',
      { change: { op: 'done', itemId: ID, evidence: 'e' }, actor: reviewer, item: item() },
      'not_marker',
    ],
    [
      'an item moves to another open card of the project',
      { change: { op: 'move', itemId: ID, taskKey: 'AC-2' }, actor: dev, item: item(), target },
      null,
    ],
    [
      'an item does not move to a closed card',
      {
        change: { op: 'move', itemId: ID, taskKey: 'AC-2' },
        actor: dev,
        item: item(),
        target: { ...target, status: 'done' },
      },
      'move_target',
    ],
    [
      'an item does not move to its own card',
      {
        change: { op: 'move', itemId: ID, taskKey: 'AC-1' },
        actor: dev,
        item: item(),
        target: { ...target, key: 'AC-1' },
      },
      'move_target',
    ],
    [
      'an item does not move to a theme',
      {
        change: { op: 'move', itemId: ID, taskKey: 'AC-2' },
        actor: dev,
        item: item(),
        target: { ...target, kind: 'theme' },
      },
      'move_target',
    ],
    [
      'the owner of the step reopens an item',
      {
        change: { op: 'reopen', itemId: ID },
        actor: reviewer,
        task: task({ stageId: 'review' }),
        item: item({ state: 'done', evidence: 'e' }),
      },
      null,
    ],
    [
      'the owner of the step confirms a settled item',
      {
        change: { op: 'confirm', itemId: ID },
        actor: reviewer,
        task: task({ stageId: 'review' }),
        item: item({ state: 'done', evidence: 'e', markedBy: 'dev-1' }),
      },
      null,
    ],
    [
      'an AI that owns no step cannot confirm',
      {
        change: { op: 'confirm', itemId: ID },
        actor: dev,
        task: task({ assignee: 'rev', stageId: 'dev' }),
        item: item({ state: 'done', evidence: 'e' }),
      },
      'not_confirmer',
    ],
    [
      'the assignee cannot confirm their own work',
      {
        change: { op: 'confirm', itemId: ID },
        actor: human,
        task: task({ assignee: 'owner' }),
        item: item({ state: 'done', evidence: 'e' }),
      },
      'own_work',
    ],
    [
      'the marker cannot confirm the item',
      {
        change: { op: 'confirm', itemId: ID },
        actor: human,
        item: item({ state: 'done', evidence: 'e', markedBy: 'owner' }),
      },
      'own_work',
    ],
    [
      'an open item cannot be confirmed',
      { change: { op: 'confirm', itemId: ID }, actor: human, item: item() },
      'not_settled',
    ],
  ])('%s', (_name, c, expected) => {
    expect(
      acceptanceRefusal({
        config: config(),
        task: c.task ?? task(),
        item: c.item,
        count: c.count ?? 1,
        change: c.change,
        actor: c.actor,
        target: c.target,
      }),
    ).toBe(expected);
  });
});

describe('acceptanceLabels', () => {
  const settled = (confirmedBy: string | null) => item({ state: 'done', evidence: 'e', confirmedBy });

  it.each<[string, AcceptanceItem[], { open: boolean; unconfirmed: boolean }]>([
    ['a card without items has neither label', [], { open: false, unconfirmed: false }],
    ['an open item calls for both', [item()], { open: true, unconfirmed: true }],
    [
      'a settled item without confirmation calls for the unconfirmed label only',
      [settled(null)],
      { open: false, unconfirmed: true },
    ],
    ['confirmed items call for none', [settled('rev')], { open: false, unconfirmed: false }],
  ])('%s', (_name, items, expected) => {
    expect(acceptanceLabels(items)).toEqual(expected);
  });
});

describe('itemProgress', () => {
  it('counts the settled items and tells when all of them are', () => {
    expect(itemProgress([{ state: 'done' }, { state: 'open' }])).toEqual({
      settled: 1,
      total: 2,
      complete: false,
    });
    expect(itemProgress([{ state: 'moved' }, { state: 'not_needed' }]).complete).toBe(true);
  });
});
