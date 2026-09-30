import { describe, expect, it } from 'vitest';
import type { LabelDefinition } from '../domain/label';
import type { GateCondition, Stage } from '../domain/pipeline';
import type { Task, TaskLink } from '../domain/task';
import { evaluateMove, gateAcceptsCondition, pullRequestsMerged, stageApprovers, stageIndex } from './gates';
import type { GateEvaluation } from './gates';
import { ProjectConfig } from './schema';

function config(fourEyes = false) {
  return ProjectConfig.parse({
    schemaVersion: 1,
    project: { key: 'AC', name: 'Acme', workspacePath: '/work/acme', repos: [] },
    team: {
      members: [
        { kind: 'human', handle: 'owner', displayName: 'Owner', access: 'owner', roles: ['operator'] },
        { kind: 'human', handle: 'ann', displayName: 'Ann', access: 'admin', roles: ['operator'] },
        { kind: 'ai', handle: 'dev-1', displayName: 'Developer', role: 'developer', sponsor: 'owner' },
        { kind: 'ai', handle: 'rev', displayName: 'Reviewer', role: 'code_review', sponsor: 'owner' },
      ],
      releaseFourEyes: fourEyes,
      limits: {},
    },
    pipeline: {
      columns: [{ id: 'all', name: 'All' }],
      stages: [
        { id: 'backlog', name: 'Backlog', kind: 'queue', columnId: 'all' },
        { id: 'dev', name: 'Development', kind: 'work', duty: 'implementation', columnId: 'all' },
        {
          id: 'review',
          name: 'Review',
          kind: 'step',
          columnId: 'all',
          gate: { conditions: [{ type: 'lacks_label', label: 'wip' }] },
        },
        {
          id: 'merge',
          name: 'Merge',
          kind: 'step',
          columnId: 'all',
          gate: { conditions: [{ type: 'has_label', label: 'review-ok' }] },
        },
        {
          id: 'release',
          name: 'Release',
          kind: 'release',
          columnId: 'all',
          gate: {
            conditions: [
              { type: 'has_label', label: 'merged' },
              { type: 'has_label', label: 'release-ok' },
            ],
          },
        },
        { id: 'done', name: 'Done', kind: 'done', columnId: 'all' },
      ],
      labels: [
        { id: 'review-ok', name: 'Review ok', setBy: { duties: ['code_review'] }, notByAuthor: true },
        { id: 'merged', name: 'Merged', setBy: 'system' },
        { id: 'release-ok', name: 'Release ok', setBy: { duties: ['release_approval'], humansOnly: true } },
        { id: 'waiting', name: 'Waiting', blocks: true },
        { id: 'wip', name: 'Work in progress' },
      ],
    },
  });
}

function task(labels: string[], extra: Partial<Pick<Task, 'assignee' | 'links'>> = {}) {
  return { labels, assignee: null, links: [], ...extra };
}

const lacks = (stageId: string, label: string) => ({
  stageId,
  condition: { type: 'lacks_label' as const, label },
});
const has = (stageId: string, label: string) => ({
  stageId,
  condition: { type: 'has_label' as const, label },
});

describe('evaluateMove', () => {
  it.each<[string, string[], string, string, GateEvaluation]>([
    ['an ungated step is free', [], 'backlog', 'dev', { unmet: [], approvals: [] }],
    ['a lacks_label condition holds without the label', [], 'dev', 'review', { unmet: [], approvals: [] }],
    [
      'a label the gate forbids blocks entry',
      ['wip'],
      'dev',
      'review',
      { unmet: [lacks('review', 'wip')], approvals: [] },
    ],
    [
      'a missing label blocks entry',
      [],
      'review',
      'merge',
      { unmet: [has('merge', 'review-ok')], approvals: [] },
    ],
    ['a present label opens the gate', ['review-ok'], 'review', 'merge', { unmet: [], approvals: [] }],
    [
      'skipping ahead evaluates every stage passed',
      ['wip'],
      'backlog',
      'merge',
      { unmet: [lacks('review', 'wip'), has('merge', 'review-ok')], approvals: [] },
    ],
    [
      'a missing label only humans set is an approval to request',
      ['review-ok', 'merged'],
      'merge',
      'release',
      { unmet: [], approvals: [{ stageId: 'release', label: 'release-ok', approvers: ['owner', 'ann'] }] },
    ],
    [
      'a missing system label is unmet, never an approval',
      ['release-ok'],
      'merge',
      'release',
      { unmet: [has('release', 'merged')], approvals: [] },
    ],
    [
      'a blocking label holds a forward move at the first stage entered',
      ['waiting'],
      'backlog',
      'dev',
      { unmet: [lacks('dev', 'waiting')], approvals: [] },
    ],
    [
      'a blocking label does not hold a backward move',
      ['waiting'],
      'merge',
      'dev',
      { unmet: [], approvals: [] },
    ],
    [
      'moving back enters only the target stage',
      ['wip'],
      'release',
      'merge',
      { unmet: [has('merge', 'review-ok')], approvals: [] },
    ],
    ['an unknown target enters nothing', ['waiting'], 'dev', 'nowhere', { unmet: [], approvals: [] }],
  ])('%s', (_name, labels, from, to, expected) => {
    expect(evaluateMove(task(labels), config(), from, to)).toEqual(expected);
  });

  it('asks only the approvers who did not author the task under four eyes', () => {
    const authored = task(['review-ok', 'merged'], { assignee: 'owner' });
    expect(evaluateMove(authored, config(true), 'merge', 'release').approvals).toEqual([
      { stageId: 'release', label: 'release-ok', approvers: ['ann'] },
    ]);
    expect(evaluateMove(authored, config(false), 'merge', 'release').approvals).toEqual([
      { stageId: 'release', label: 'release-ok', approvers: ['owner', 'ann'] },
    ]);
  });
});

describe('stageIndex', () => {
  it.each([
    ['backlog', 0],
    ['release', 4],
    ['nowhere', -1],
  ])('places %s at %i', (id, index) => {
    expect(stageIndex(config().pipeline, id)).toBe(index);
  });
});

describe('stageApprovers', () => {
  it.each([
    ['release', ['owner', 'ann']],
    ['merge', []],
    ['backlog', []],
  ])('lists the humans who approve entering %s', (id, approvers) => {
    const c = config();
    expect(
      stageApprovers(
        c,
        c.pipeline.stages.find((s) => s.id === id)!,
      ),
    ).toEqual(approvers);
  });
});

describe('pullRequestsMerged', () => {
  const pr = (state?: string): TaskLink => ({ kind: 'pull_request', ref: '1', ...(state ? { state } : {}) });
  it.each<[string, TaskLink[], boolean]>([
    ['no pull request', [], false],
    ['one merged', [pr('merged')], true],
    ['merged and closed', [pr('merged'), pr('closed')], true],
    ['only closed', [pr('closed')], false],
    ['one still open', [pr('merged'), pr('open')], false],
    ['an unknown state counts as open', [pr('merged'), pr()], false],
    ['branches do not count', [pr('merged'), { kind: 'branch', ref: 'feature' }], true],
  ])('%s: %s', (_name, links, expected) => {
    expect(pullRequestsMerged({ links })).toBe(expected);
  });
});

describe('gateAcceptsCondition (decision 19)', () => {
  type Case = [
    string,
    Pick<Stage, 'kind'>,
    Pick<GateCondition, 'type'>,
    Pick<LabelDefinition, 'setBy'>,
    boolean,
  ];
  const release = { kind: 'release' } as const;
  const merge = { kind: 'step' } as const;
  const has = { type: 'has_label' } as const;
  const lacks = { type: 'lacks_label' } as const;
  const approval: Pick<LabelDefinition, 'setBy'> = {
    setBy: { duties: ['release_approval'], humansOnly: true },
  };
  const everyHuman: Pick<LabelDefinition, 'setBy'> = { setBy: 'humans' };
  const namedHumans: Pick<LabelDefinition, 'setBy'> = { setBy: { members: ['ann'], humansOnly: true } };
  const fact: Pick<LabelDefinition, 'setBy'> = { setBy: 'anyone' };

  it.each<Case>([
    ['a release gate requires the release approval', release, has, approval, true],
    ['a release gate requires a fact', release, has, fact, true],
    ['a release gate requires what every human may set', release, has, everyHuman, false],
    ['a release gate requires what named humans may set', release, has, namedHumans, false],
    ['a release gate forbids what every human may set', release, lacks, everyHuman, true],
    ['a merge gate requires what every human may set', merge, has, everyHuman, true],
  ])('%s: %s', (_name, stage, condition, label, expected) => {
    expect(gateAcceptsCondition(stage, condition, label)).toBe(expected);
  });
});
