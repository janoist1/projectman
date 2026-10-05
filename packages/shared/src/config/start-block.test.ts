import { describe, expect, it } from 'vitest';
import type { Task } from '../domain/task';
import { refinementProgress, refinementSteps, startBlock } from './start-block';
import { ProjectConfig } from './schema';

interface Options {
  /** Whether the project has refinement: a refine label and a plan stage. */
  refines?: boolean;
  labels?: Array<Record<string, unknown>>;
  readyConditions?: Array<Record<string, unknown>>;
}

function config({ refines = true, labels = [], readyConditions }: Options = {}) {
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
        { kind: 'ai', handle: 'analyst', displayName: 'Analyst', role: 'business_analyst', sponsor: 'owner' },
        { kind: 'ai', handle: 'designer', displayName: 'Designer', role: 'designer', sponsor: 'owner' },
        { kind: 'ai', handle: 'dev-1', displayName: 'Developer', role: 'developer', sponsor: 'owner' },
      ],
      limits: {},
    },
    pipeline: {
      columns: [{ id: 'all', name: 'All' }],
      stages: [
        { id: 'backlog', name: 'Backlog', kind: 'queue', columnId: 'all' },
        ...(refines
          ? [{ id: 'plan', name: 'Plan', kind: 'step', duty: 'task_breakdown', columnId: 'all' }]
          : []),
        {
          id: 'ready',
          name: 'Ready',
          kind: 'queue',
          columnId: 'all',
          ...((readyConditions?.length ?? 1) > 0 && {
            gate: {
              conditions: readyConditions ?? [
                { type: 'has_label', label: 'scope-ok' },
                { type: 'has_label', label: 'design-ok', when: 'ui' },
              ],
            },
          }),
        },
        { id: 'dev', name: 'Development', kind: 'work', duty: 'implementation', columnId: 'all' },
        { id: 'done', name: 'Done', kind: 'done', columnId: 'all' },
      ],
      labels: [
        ...(refines ? [{ id: 'refine', name: 'Refine', setBy: { duties: ['prioritization'] } }] : []),
        { id: 'scope-ok', name: 'Scope ok', setBy: { members: ['analyst'] } },
        { id: 'design-ok', name: 'Design ok', setBy: { members: ['designer'] } },
        { id: 'approved', name: 'Approved', setBy: 'humans' },
        { id: 'ui', name: 'UI' },
        { id: 'waiting', name: 'Waiting', blocks: true },
        ...labels,
      ],
    },
  });
}

function task(stageId: string, labels: string[], over: Partial<Task> = {}) {
  return {
    status: 'active',
    kind: 'task',
    stageId,
    labels,
    assignee: null,
    links: [],
    ...over,
  } satisfies Pick<Task, 'status' | 'kind' | 'stageId' | 'labels' | 'assignee' | 'links'>;
}

describe('refinementSteps', () => {
  it('lists the labels of the gates up to the work stage, once each, with their state', () => {
    const c = config({
      readyConditions: [
        { type: 'has_label', label: 'scope-ok' },
        { type: 'has_label', label: 'scope-ok' },
        { type: 'lacks_label', label: 'waiting' },
      ],
    });
    expect(refinementSteps(task('backlog', ['scope-ok']), c)).toEqual([{ label: 'scope-ok', done: true }]);
  });

  it('counts a conditional step only when the card carries its when label', () => {
    const c = config();
    expect(refinementSteps(task('backlog', []), c).map((s) => s.label)).toEqual(['scope-ok']);
    expect(refinementSteps(task('backlog', ['ui']), c)).toEqual([
      { label: 'scope-ok', done: false },
      { label: 'design-ok', done: false },
    ]);
  });

  it('leaves out the gates of the stages the card is past', () => {
    expect(refinementSteps(task('dev', ['ui']), config())).toEqual([]);
  });
});

describe('refinementProgress', () => {
  it('is null for a card that is not being refined', () => {
    expect(refinementProgress(task('backlog', []), config())).toBeNull();
  });

  it('gives the steps, the turn and the stage the card moves to', () => {
    const progress = refinementProgress(task('backlog', ['refine']), config());
    expect(progress?.steps).toEqual([{ label: 'scope-ok', done: false }]);
    expect(progress?.turn).toMatchObject({ kind: 'step', label: 'scope-ok' });
    expect(progress?.targetStageId).toBe('ready');
  });

  it('has no target stage when the card stands in the last stage before the work stage', () => {
    expect(refinementProgress(task('ready', ['refine']), config())?.targetStageId).toBeNull();
  });
});

describe('startBlock', () => {
  it('is null for a closed card, a theme, and a card in or after the work stage', () => {
    const c = config();
    expect(startBlock(task('backlog', ['refine'], { status: 'done' }), c)).toBeNull();
    expect(startBlock(task('backlog', ['refine'], { kind: 'theme' }), c)).toBeNull();
    expect(startBlock(task('dev', ['refine']), c)).toBeNull();
    expect(startBlock(task('done', []), c)).toBeNull();
  });

  it('is null when the pipeline has no work stage', () => {
    const c = config();
    const noWork = ProjectConfig.parse({
      ...c,
      pipeline: { ...c.pipeline, stages: c.pipeline.stages.filter((s) => s.kind !== 'work') },
    });
    expect(startBlock(task('backlog', []), noWork)).toBeNull();
  });

  it('refuses a card that is being refined, with its progress', () => {
    const block = startBlock(task('backlog', ['refine']), config());
    expect(block).toMatchObject({ kind: 'refining', refinement: { turn: { kind: 'step' } } });
  });

  it('refuses a refined card the system is just moving on', () => {
    const block = startBlock(task('backlog', ['refine', 'scope-ok']), config());
    expect(block).toMatchObject({ kind: 'refining', refinement: { turn: { kind: 'done' } } });
  });

  it('refuses a card a blocking label holds, when it is not being refined', () => {
    expect(startBlock(task('ready', ['scope-ok', 'waiting']), config())).toEqual({
      kind: 'held',
      labels: ['waiting'],
    });
  });

  it('names the approval its own column lacks and who gives it', () => {
    const c = config({ readyConditions: [{ type: 'has_label', label: 'approved' }] });
    expect(startBlock(task('ready', []), c)).toEqual({
      kind: 'approval',
      label: 'approved',
      approvers: ['owner'],
    });
  });

  it('does not refuse for the approval of a later column', () => {
    const c = config({ readyConditions: [] });
    expect(startBlock(task('backlog', []), c)).toBeNull();
    const later = ProjectConfig.parse({
      ...c,
      pipeline: {
        ...c.pipeline,
        stages: c.pipeline.stages.map((s) =>
          s.id === 'dev' ? { ...s, gate: { conditions: [{ type: 'has_label', label: 'approved' }] } } : s,
        ),
      },
    });
    expect(startBlock(task('ready', []), later)).toBeNull();
  });

  it('names the labels a card lacks that is not refined, in a project with refinement', () => {
    expect(startBlock(task('backlog', ['ui']), config())).toEqual({
      kind: 'unmet',
      labels: ['scope-ok', 'design-ok'],
      refines: true,
    });
  });

  it('is null when every label is on', () => {
    expect(startBlock(task('ready', ['scope-ok']), config())).toBeNull();
  });

  it('lets the Start through in a project without refinement when AI members set the labels', () => {
    expect(startBlock(task('backlog', []), config({ refines: false }))).toBeNull();
  });

  it('refuses in a project without refinement when nobody who is an AI member sets a label', () => {
    const c = config({
      refines: false,
      readyConditions: [{ type: 'has_label', label: 'approved-by-team' }],
      labels: [{ id: 'approved-by-team', name: 'Approved by team', setBy: { members: ['owner'] } }],
    });
    expect(startBlock(task('backlog', []), c)).toEqual({
      kind: 'unmet',
      labels: ['approved-by-team'],
      refines: false,
    });
  });
});
