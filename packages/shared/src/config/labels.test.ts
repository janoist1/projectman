import { describe, expect, it } from 'vitest';
import type { Actor } from '../domain/event';
import type { LabelRefusal } from '../domain/label';
import type { Task } from '../domain/task';
import { labelDefinition, labelRefusal, labelSetters } from './labels';
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
        { id: 'review-ok', name: 'Review ok', setBy: { duties: ['code_review'] }, notByAuthor: true },
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
