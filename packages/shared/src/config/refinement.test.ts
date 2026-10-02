import { describe, expect, it } from 'vitest';
import type { Task } from '../domain/task';
import { validateProjectConfig } from './invariants';
import { isRefining, projectRefines, refinementTurn } from './refinement';
import { ProjectConfig } from './schema';

type Labels = Array<Record<string, unknown>>;

function config(labels: Labels = [], planGate?: Record<string, unknown>) {
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
        { id: 'plan', name: 'Plan', kind: 'step', duty: 'task_breakdown', columnId: 'all', gate: planGate },
        {
          id: 'ready',
          name: 'Ready',
          kind: 'queue',
          columnId: 'all',
          gate: {
            conditions: [
              { type: 'has_label', label: 'scope-ok' },
              { type: 'has_label', label: 'design-ok', when: 'ui' },
            ],
          },
        },
        { id: 'dev', name: 'Development', kind: 'work', duty: 'implementation', columnId: 'all' },
        { id: 'done', name: 'Done', kind: 'done', columnId: 'all' },
      ],
      labels: [
        { id: 'refine', name: 'Refine', setBy: { duties: ['prioritization'] } },
        { id: 'scope-ok', name: 'Scope ok', setBy: { duties: ['task_breakdown'] } },
        { id: 'design-ok', name: 'Design ok', setBy: { duties: ['ux_design'] } },
        { id: 'ui', name: 'UI' },
        { id: 'waiting', name: 'Waiting', blocks: true },
        ...labels,
      ],
    },
  });
}

function task(stageId: string, labels: string[]) {
  return {
    status: 'active',
    kind: 'task',
    stageId,
    labels,
    assignee: null,
    links: [],
  } satisfies Pick<Task, 'status' | 'kind' | 'stageId' | 'labels' | 'assignee' | 'links'>;
}

describe('isRefining', () => {
  it('holds for a card with the refine label before the work stage', () => {
    expect(isRefining(task('backlog', ['refine']), config())).toBe(true);
  });

  it('holds for a card in a refinement stage, with or without the label', () => {
    expect(isRefining(task('plan', []), config())).toBe(true);
  });

  it('does not hold for a card without the label outside a refinement stage', () => {
    expect(isRefining(task('backlog', []), config())).toBe(false);
  });

  it('does not hold when the project does not know the refine label', () => {
    const plain = config();
    plain.pipeline.labels = plain.pipeline.labels.filter((label) => label.id !== 'refine');
    expect(isRefining(task('backlog', ['refine']), plain)).toBe(false);
    expect(projectRefines(plain)).toBe(true); // the plan stage is a refinement stage
  });

  it('does not hold for a card in or after the work stage, a closed card or a theme', () => {
    expect(isRefining(task('dev', ['refine']), config())).toBe(false);
    expect(isRefining({ ...task('backlog', ['refine']), status: 'done' }, config())).toBe(false);
    expect(isRefining({ ...task('backlog', ['refine']), kind: 'theme' }, config())).toBe(false);
  });
});

describe('refinementTurn', () => {
  it('is null for a card that is not being refined', () => {
    expect(refinementTurn(task('backlog', []), config())).toBeNull();
  });

  it('gives the turn to the first missing label, in the order of the gates', () => {
    expect(refinementTurn(task('backlog', ['refine', 'ui']), config())).toEqual({
      kind: 'step',
      stageId: 'ready',
      label: 'scope-ok',
      aiSetters: ['analyst'],
      humanSetters: [],
    });
  });

  it('goes on to the next label once the earlier one is on, and skips a `when` that does not bind', () => {
    expect(refinementTurn(task('backlog', ['refine', 'ui', 'scope-ok']), config())).toMatchObject({
      kind: 'step',
      label: 'design-ok',
      aiSetters: ['designer'],
    });
    expect(refinementTurn(task('backlog', ['refine', 'scope-ok']), config())).toMatchObject({ kind: 'done' });
  });

  it('goes back to an earlier step when its label is removed', () => {
    expect(refinementTurn(task('backlog', ['refine', 'ui', 'design-ok']), config())).toMatchObject({
      kind: 'step',
      label: 'scope-ok',
    });
  });

  it('is blocked while a blocking label is on the card', () => {
    expect(refinementTurn(task('backlog', ['refine', 'waiting']), config())).toEqual({
      kind: 'blocked',
      label: 'waiting',
    });
  });

  it('is blocked by a label a gate wants absent', () => {
    const forbidding = config([], { conditions: [{ type: 'lacks_label', label: 'ui' }] });
    expect(refinementTurn(task('backlog', ['refine', 'ui', 'scope-ok', 'design-ok']), forbidding)).toEqual({
      kind: 'blocked',
      label: 'ui',
    });
  });

  it('is done with the stage before development as the target', () => {
    expect(refinementTurn(task('backlog', ['refine', 'scope-ok']), config())).toEqual({
      kind: 'done',
      targetStageId: 'ready',
    });
    expect(refinementTurn(task('plan', ['scope-ok']), config())).toEqual({
      kind: 'done',
      targetStageId: 'ready',
    });
  });

  it('is done without a target when the card stands there already', () => {
    expect(refinementTurn(task('ready', ['refine', 'scope-ok']), config())).toEqual({
      kind: 'done',
      targetStageId: null,
    });
  });

  it('gives a label only people may set no AI setter', () => {
    const approved = config([{ id: 'approved', name: 'Approved', setBy: 'humans' }], {
      conditions: [{ type: 'has_label', label: 'approved' }],
    });
    expect(refinementTurn(task('backlog', ['refine']), approved)).toEqual({
      kind: 'step',
      stageId: 'plan',
      label: 'approved',
      aiSetters: [],
      humanSetters: ['owner'],
    });
  });
});

describe('refinement_step_manual warning', () => {
  const codes = (cfg: ReturnType<typeof config>) =>
    validateProjectConfig(cfg).filter((issue) => issue.code === 'refinement_step_manual');

  it('is not raised when AI members can set every label', () => {
    expect(codes(config())).toEqual([]);
  });

  it('warns about a required label no AI member may set, as a warning only', () => {
    const manual = config([{ id: 'sign-off', name: 'Sign-off', setBy: { duties: ['prioritization'] } }], {
      conditions: [{ type: 'has_label', label: 'sign-off' }],
    });
    expect(codes(manual)).toEqual([
      {
        code: 'refinement_step_manual',
        severity: 'warning',
        path: 'pipeline.stages[1].gate.conditions[0]',
        detail: 'sign-off',
      },
    ]);
  });

  it('is not raised for the labels of approvals and of the system', () => {
    const approvals = config(
      [
        { id: 'approved', name: 'Approved', setBy: 'humans' },
        { id: 'merged', name: 'Merged', setBy: 'system' },
      ],
      {
        conditions: [
          { type: 'has_label', label: 'approved' },
          { type: 'has_label', label: 'merged' },
        ],
      },
    );
    expect(codes(approvals)).toEqual([]);
  });
});
