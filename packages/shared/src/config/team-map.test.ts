import { describe, expect, it } from 'vitest';
import { templates } from '@projectman/templates';
import { LabelDefinition } from '../domain/label';
import { Stage } from '../domain/pipeline';
import { teamMap } from './team-map';

function config() {
  return templates[0]!.build({
    key: 'AC',
    name: 'Acme',
    workspacePath: '/work/acme',
    language: 'en',
    owner: { handle: 'owner', displayName: 'Owner', email: 'owner@example.com' },
  });
}

describe('teamMap', () => {
  it('resolves stage owners and decisions independently of board columns', () => {
    const project = config();
    const columnId = project.pipeline.columns[0]!.id;
    project.pipeline.labels = [LabelDefinition.parse({ id: 'approved', name: 'Approved', setBy: 'humans' })];
    project.pipeline.stages = [
      Stage.parse({ id: 'start', name: 'Start', kind: 'queue', columnId, owners: ['owner'] }),
      Stage.parse({ id: 'dev', name: 'Dev', kind: 'work', columnId, duty: 'implementation' }),
      Stage.parse({
        id: 'check',
        name: 'Check',
        kind: 'step',
        columnId,
        gate: { conditions: [{ type: 'has_label', label: 'approved', when: 'ui' }] },
      }),
      Stage.parse({ id: 'release', name: 'Release', kind: 'release', columnId }),
      Stage.parse({ id: 'done', name: 'Done', kind: 'done', columnId }),
    ];
    const map = teamMap(project);
    expect(map.stages.map((entry) => entry.ownersFrom)).toEqual(['members', 'duty', 'none', 'none', 'none']);
    expect(map.stages[0]!.owners).toEqual(['owner']);
    expect(map.stages[1]!.owners.length).toBeGreaterThan(0);
    expect(map.stages.map((entry) => entry.humanDecides)).toEqual([false, false, true, true, false]);
    expect(map.stages.map((entry) => entry.nextStageId)).toEqual(['dev', 'check', 'release', 'done', null]);
    expect(map.stages[2]!.approvals).toEqual(['approved']);
    expect(map.refinement).toBeNull();
  });

  it('records both sides of conditional gates and member responsibilities', () => {
    const project = config();
    project.pipeline.labels = [
      LabelDefinition.parse({ id: 'approved', name: 'Approved', setBy: 'humans', notByAuthor: true }),
      LabelDefinition.parse({ id: 'ui', name: 'UI', blocks: true }),
      LabelDefinition.parse({ id: 'system-fact', name: 'System fact', setBy: 'system' }),
    ];
    project.pipeline.stages[0]!.owners = ['owner'];
    project.pipeline.stages[1]!.gate = {
      conditions: [
        { type: 'has_label', label: 'approved', when: 'ui' },
        { type: 'lacks_label', label: 'ui', when: 'approved' },
      ],
    };
    const map = teamMap(project);
    expect(map.labels[0]!.usedBy.map((use) => use.as)).toEqual(['label', 'when']);
    expect(map.labels[1]!.usedBy.map((use) => use.as)).toEqual(['when', 'label']);
    expect(map.labels[0]).toMatchObject({ approval: true, excludesAuthors: true, holders: ['owner'] });
    expect(map.blockingLabels).toEqual(['ui']);
    expect(map.members.find((entry) => entry.member.handle === 'owner')).toMatchObject({
      ownsStages: expect.arrayContaining([project.pipeline.stages[0]!.id]),
      sets: ['approved'],
      approves: ['approved'],
    });
    expect(map.members.find((entry) => entry.member.kind === 'ai')!.sets).toEqual([]);
  });

  it('loops each code review to the nearest earlier work stage', () => {
    const project = config();
    project.pipeline.labels.push(LabelDefinition.parse({ id: 'code-review-changes', name: 'Changes' }));
    const columnId = project.pipeline.columns[0]!.id;
    project.pipeline.stages = ['review_first', 'work_one', 'work_two', 'review_last'].map((id) =>
      Stage.parse({
        id,
        name: id,
        columnId,
        kind: id.startsWith('work') ? 'work' : 'step',
        duty: id.startsWith('review') ? 'code_review' : 'implementation',
      }),
    );
    expect(teamMap(project).fixRounds.loops).toEqual([
      { fromStageId: 'review_last', toStageId: 'work_two', label: 'code-review-changes' },
    ]);
    project.pipeline.labels = [];
    expect(teamMap(project).fixRounds.loops[0]!.label).toBeNull();
  });

  it('uses refinement setter rules and keeps human approvals out of AI turns', () => {
    const project = config();
    project.pipeline.labels.push(
      LabelDefinition.parse({ id: 'refine', name: 'Refine' }),
      LabelDefinition.parse({
        id: 'scope-ok',
        name: 'Scope',
        setBy: { members: project.team.members.map((member) => member.handle), humansOnly: true },
      }),
    );
    project.pipeline.stages[0]!.gate = { conditions: [{ type: 'has_label', label: 'scope-ok', when: 'ui' }] };
    expect(teamMap(project).refinement!.steps[0]).toMatchObject({
      stageId: project.pipeline.stages[0]!.id,
      label: 'scope-ok',
      when: 'ui',
      aiSetters: [],
      humanSetters: ['owner'],
    });
  });
});
