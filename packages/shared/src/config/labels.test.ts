import { describe, expect, it } from 'vitest';
import type { Actor } from '../domain/event';
import type { LabelRefusal } from '../domain/label';
import type { Task } from '../domain/task';
import {
  approvalRefusal,
  expiredLabels,
  labelDefinition,
  labelRefusal,
  labelSetters,
  noApproverReason,
  planLabelChange,
} from './labels';
import type { LabelChangePlan } from './labels';
import { ProjectConfig } from './schema';

function config(fourEyes = false) {
  return ProjectConfig.parse({
    schemaVersion: 1,
    project: { key: 'AC', name: 'Acme', workspacePath: '/work/acme', repos: [] },
    team: {
      members: [
        {
          kind: 'human',
          handle: 'owner',
          displayName: 'Owner',
          access: 'owner',
          roles: ['operator', 'product_owner'],
        },
        { kind: 'human', handle: 'ann', displayName: 'Ann', access: 'developer', roles: ['code_review'] },
        { kind: 'human', handle: 'vic', displayName: 'Vic', access: 'viewer' },
        { kind: 'ai', handle: 'dev-1', displayName: 'Developer', role: 'developer', sponsor: 'owner' },
        { kind: 'ai', handle: 'rev', displayName: 'Reviewer', role: 'code_review', sponsor: 'owner' },
      ],
      releaseFourEyes: fourEyes,
      limits: {},
    },
    pipeline: {
      columns: [{ id: 'all', name: 'All' }],
      stages: [
        { id: 'ready', name: 'Ready', kind: 'queue', columnId: 'all' },
        { id: 'dev', name: 'Development', kind: 'work', duty: 'implementation', columnId: 'all' },
        {
          id: 'release',
          name: 'Release',
          kind: 'release',
          columnId: 'all',
          gate: { conditions: [{ type: 'has_label', label: 'release-ok' }] },
        },
        { id: 'done', name: 'Done', kind: 'done', columnId: 'all' },
      ],
      labels: [
        {
          id: 'review-ok',
          name: 'Review ok',
          group: 'review',
          setBy: { duties: ['code_review'] },
          notByAuthor: true,
          clearedWhen: ['moved_back', 'pr_updated'],
        },
        {
          id: 'review-changes',
          name: 'Review: changes',
          group: 'review',
          setBy: { duties: ['code_review'] },
          requiresComment: true,
          notifyAssignee: true,
          clearedWhen: ['moved_back'],
        },
        { id: 'decided', name: 'Decided', setBy: 'humans' },
        { id: 'release-ok', name: 'Release ok', setBy: { duties: ['release_approval'], humansOnly: true } },
        { id: 'merged', name: 'Merged', setBy: 'system' },
        { id: 'waiting', name: 'Waiting', setBy: 'anyone' },
        { id: 'lead-ok', name: 'Lead ok', setBy: { members: ['ann', 'dev-1'] } },
        {
          id: 'lead-human-ok',
          name: 'Lead ok (human)',
          setBy: { members: ['ann', 'dev-1'], humansOnly: true },
        },
      ],
    },
  });
}

/** Assigned to dev-1; ann authored its pull request. A branch link names no author. */
const task: Pick<Task, 'assignee' | 'links'> = {
  assignee: 'dev-1',
  links: [
    { kind: 'pull_request', ref: '7', author: 'ann' },
    { kind: 'branch', ref: 'feature', author: 'vic' },
  ],
};

const human = (handle: string): Actor => ({ kind: 'human', handle });
const ai = (handle: string): Actor => ({ kind: 'ai', handle });
const system: Actor = { kind: 'system', handle: null };

describe('labelRefusal', () => {
  it.each<[string, string, Actor, LabelRefusal | null]>([
    ['the system changes any label', 'merged', system, null],
    ['the system changes approvals too', 'release-ok', system, null],
    ['plain tags are open', 'no-definition', ai('dev-1'), null],
    ['only the system sets system labels', 'merged', human('owner'), 'system_only'],
    ['AI members never set labels only humans set', 'decided', ai('rev'), 'humans_only'],
    ['AI duty holders never give approvals', 'release-ok', ai('dev-1'), 'humans_only'],
    ['listed AI members lose a humans-only label', 'lead-human-ok', ai('dev-1'), 'humans_only'],
    ['any human sets a "humans" label, viewers included', 'decided', human('vic'), null],
    ['approval duty holders give approvals', 'release-ok', human('owner'), null],
    ['humans without the duty do not', 'release-ok', human('ann'), 'not_holder'],
    ['duty holders who did not author the task review it', 'review-ok', ai('rev'), null],
    ['a PR author never reviews own work', 'review-ok', human('ann'), 'self_review'],
    ['non-holders are refused before authorship is checked', 'review-ok', ai('dev-1'), 'not_holder'],
    ['members without the duty are not holders', 'review-ok', human('owner'), 'not_holder'],
    ['listed members set the label, the assignee included', 'lead-ok', ai('dev-1'), null],
    ['unlisted members do not', 'lead-ok', human('owner'), 'not_holder'],
    ['anyone sets an open label', 'waiting', ai('dev-1'), null],
  ])('%s', (_name, id, actor, expected) => {
    const c = config();
    expect(labelRefusal(c, labelDefinition(c, id), actor, task)).toBe(expected);
  });

  it('applies four eyes to release approvals only', () => {
    const authored = { ...task, links: [{ kind: 'pull_request' as const, ref: '8', author: 'owner' }] };
    const off = config();
    const on = config(true);
    expect(labelRefusal(off, labelDefinition(off, 'release-ok'), human('owner'), authored)).toBeNull();
    expect(labelRefusal(on, labelDefinition(on, 'release-ok'), human('owner'), authored)).toBe('self_review');
    expect(labelRefusal(on, labelDefinition(on, 'decided'), human('owner'), authored)).toBeNull();
  });
});

describe('labelSetters', () => {
  it.each<[string, string, string[]]>([
    ['duty holders minus the task authors', 'review-ok', ['rev']],
    ['every human for "humans", authors included', 'decided', ['owner', 'ann', 'vic']],
    ['approval duty holders', 'release-ok', ['owner']],
    ['nobody for system labels', 'merged', []],
    ['everyone for open labels', 'waiting', ['owner', 'ann', 'vic', 'dev-1', 'rev']],
    ['listed members', 'lead-ok', ['ann', 'dev-1']],
    ['listed humans only', 'lead-human-ok', ['ann']],
  ])('gives %s', (_name, id, expected) => {
    const c = config();
    expect(labelSetters(c, labelDefinition(c, id)!, task)).toEqual(expected);
  });

  it('drops release approvers who authored the task under four eyes', () => {
    const authored = { assignee: 'owner', links: [] };
    expect(labelSetters(config(), labelDefinition(config(), 'release-ok')!, authored)).toEqual(['owner']);
    expect(labelSetters(config(true), labelDefinition(config(true), 'release-ok')!, authored)).toEqual([]);
    expect(labelSetters(config(true), labelDefinition(config(true), 'decided')!, authored)).toEqual([
      'owner',
      'ann',
      'vic',
    ]);
  });
});

describe('planLabelChange', () => {
  const on = (labels: string[]) => ({ ...task, labels });
  const change = (add: string[], remove: string[] = []) => ({ add, remove });

  it.each<
    [string, string[], { add?: string[]; remove?: string[] }, Actor, string | undefined, LabelChangePlan]
  >([
    [
      'adds an open label',
      [],
      change(['waiting']),
      ai('dev-1'),
      undefined,
      { ok: true, labels: ['waiting'], added: ['waiting'], removed: [], notify: [] },
    ],
    [
      'trims, dedupes and skips labels already on the task',
      ['waiting'],
      change([' waiting ', 'tag', 'tag', ' ']),
      ai('dev-1'),
      undefined,
      { ok: true, labels: ['waiting', 'tag'], added: ['tag'], removed: [], notify: [] },
    ],
    [
      'removes only labels on the task',
      ['tag', 'waiting'],
      change([], ['tag', 'missing', 'tag']),
      ai('dev-1'),
      undefined,
      { ok: true, labels: ['waiting'], added: [], removed: ['tag'], notify: [] },
    ],
    [
      'a grouped label replaces the other labels of its group',
      ['review-changes', 'waiting'],
      change(['review-ok']),
      ai('rev'),
      undefined,
      {
        ok: true,
        labels: ['waiting', 'review-ok'],
        added: ['review-ok'],
        removed: ['review-changes'],
        notify: [],
      },
    ],
    [
      'a label that notifies the assignee is named',
      ['review-ok'],
      change(['review-changes']),
      ai('rev'),
      'Fix the form',
      {
        ok: true,
        labels: ['review-changes'],
        added: ['review-changes'],
        removed: ['review-ok'],
        notify: ['review-changes'],
      },
    ],
    [
      'a label that needs a comment is refused without one',
      [],
      change(['review-changes', 'waiting']),
      ai('rev'),
      '  ',
      { ok: false, refusal: { code: 'comment_required', labels: ['review-changes'] } },
    ],
    [
      'a task author may not review',
      [],
      change(['review-ok']),
      human('ann'),
      undefined,
      { ok: false, refusal: { code: 'self_review_forbidden', label: 'review-ok' } },
    ],
    [
      'one refused label refuses the whole change',
      [],
      change(['waiting', 'review-ok']),
      ai('dev-1'),
      undefined,
      { ok: false, refusal: { code: 'label_not_allowed', label: 'review-ok', reason: 'not_holder' } },
    ],
    [
      'removals follow the rules too',
      ['merged'],
      change([], ['merged']),
      human('owner'),
      undefined,
      { ok: false, refusal: { code: 'label_not_allowed', label: 'merged', reason: 'system_only' } },
    ],
    [
      'the system changes any label',
      ['release-ok'],
      change(['merged'], ['release-ok']),
      system,
      undefined,
      { ok: true, labels: ['merged'], added: ['merged'], removed: ['release-ok'], notify: [] },
    ],
    [
      'nothing to change is an empty plan',
      ['waiting'],
      change(['waiting'], ['tag']),
      ai('dev-1'),
      undefined,
      { ok: true, labels: ['waiting'], added: [], removed: [], notify: [] },
    ],
  ])('%s', (_name, labels, requested, actor, comment, expected) => {
    expect(planLabelChange(config(), on(labels), requested, actor, comment)).toEqual(expected);
  });
});

describe('expiredLabels', () => {
  it.each([
    ['moved_back', ['review-ok', 'review-changes']],
    ['pr_updated', ['review-ok']],
  ] as const)('lists the labels that come off when %s', (trigger, expected) => {
    const labels = ['review-ok', 'review-changes', 'waiting', 'plain'];
    expect(expiredLabels(config(), { labels }, trigger)).toEqual(expected);
  });
});

describe('approvalRefusal', () => {
  const authoredBy = (handle: string) => ({
    assignee: null,
    links: [{ kind: 'pull_request' as const, ref: '9', author: handle }],
  });

  it.each<[string, boolean, string, string, Pick<Task, 'assignee' | 'links'> | null, string | null]>([
    ['a holder approves', false, 'release-ok', 'owner', task, null],
    ['a human who does not hold the label may not', false, 'release-ok', 'ann', task, 'not_an_assignee'],
    [
      'an author approves the release without four eyes',
      false,
      'release-ok',
      'owner',
      authoredBy('owner'),
      null,
    ],
    ['four eyes refuses the author', true, 'release-ok', 'owner', authoredBy('owner'), 'release_four_eyes'],
    ['a label that excludes authors refuses them', false, 'review-ok', 'ann', task, 'self_review_forbidden'],
    ['an unknown label is no refusal', true, 'gone', 'vic', task, null],
    ['a missing task has no authors', true, 'release-ok', 'owner', null, null],
  ])('%s', (_name, fourEyes, label, approver, target, expected) => {
    expect(approvalRefusal(config(fourEyes), label, approver, target)).toBe(expected);
  });
});

describe('noApproverReason', () => {
  const authoredBy = (...handles: string[]) => ({
    assignee: handles[0] ?? null,
    links: handles.map((author, i) => ({ kind: 'pull_request' as const, ref: String(i), author })),
  });
  const unheld = (c: ProjectConfig) => {
    c.team.members = c.team.members.filter((m) => m.handle !== 'owner' || m.kind !== 'human');
    return c;
  };

  it.each<[string, ProjectConfig, string, Pick<Task, 'assignee' | 'links'>, string | null]>([
    ['a holder who did not author the task may approve', config(true), 'release-ok', task, null],
    [
      'four eyes leaves only the author',
      config(true),
      'release-ok',
      authoredBy('owner'),
      'release_four_eyes',
    ],
    ['without four eyes the author approves', config(false), 'release-ok', authoredBy('owner'), null],
    [
      "the label's own rule leaves only authors",
      config(),
      'review-ok',
      authoredBy('ann', 'rev'),
      'self_review_forbidden',
    ],
    ['nobody holds the label', unheld(config()), 'release-ok', task, 'missing_duty_holder'],
    ['an unknown label needs no approver', config(), 'gone', task, null],
  ])('%s', (_name, c, label, target, expected) => {
    expect(noApproverReason(c, label, target)).toBe(expected);
  });
});
