import { describe, expect, it } from 'vitest';
import type { LabelDefinition } from '../domain/label';
import type { GateCondition, Stage } from '../domain/pipeline';
import type { Task, TaskLink } from '../domain/task';
import {
  aiLabelSetters,
  evaluateMove,
  evaluateStart,
  gateAcceptsCondition,
  gateAcceptsWhen,
  pullRequestsMerged,
  stageAdvance,
  stageApprovers,
  stageIndex,
} from './gates';
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
const has = (stageId: string, label: string, setters: string[] = []) => ({
  stageId,
  condition: { type: 'has_label' as const, label },
  setters,
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
      { unmet: [has('merge', 'review-ok', ['rev'])], approvals: [] },
    ],
    ['a present label opens the gate', ['review-ok'], 'review', 'merge', { unmet: [], approvals: [] }],
    [
      'skipping ahead evaluates every stage passed',
      ['wip'],
      'backlog',
      'merge',
      { unmet: [lacks('review', 'wip'), has('merge', 'review-ok', ['rev'])], approvals: [] },
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
      { unmet: [has('merge', 'review-ok', ['rev'])], approvals: [] },
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

describe('evaluateMove with a condition bound to a label (when)', () => {
  /** The "merge" stage needs design-ok on UI cards; the "review" stage forbids the "wip" tag on them. */
  function conditional() {
    const base = config();
    return ProjectConfig.parse({
      ...base,
      team: {
        ...base.team,
        members: [
          ...base.team.members,
          { kind: 'ai', handle: 'des', displayName: 'Designer', role: 'designer', sponsor: 'owner' },
        ],
      },
      pipeline: {
        ...base.pipeline,
        stages: base.pipeline.stages.map((stage) =>
          stage.id === 'merge'
            ? {
                ...stage,
                gate: {
                  conditions: [
                    ...(stage.gate?.conditions ?? []),
                    { type: 'has_label', label: 'design-ok', when: 'ui' },
                    { type: 'lacks_label', label: 'wip', when: 'ui' },
                  ],
                },
              }
            : stage,
        ),
        labels: [
          ...base.pipeline.labels,
          { id: 'ui', name: 'UI' },
          { id: 'design-ok', name: 'Design ok', setBy: { duties: ['ux_design'] } },
        ],
      },
    });
  }
  const designOk = {
    stageId: 'merge',
    condition: { type: 'has_label' as const, label: 'design-ok', when: 'ui' },
    setters: ['des'],
  };
  const noWip = {
    stageId: 'merge',
    condition: { type: 'lacks_label' as const, label: 'wip', when: 'ui' },
  };

  it.each<[string, string[], string, string, GateEvaluation['unmet']]>([
    ['a card without the when label is not bound', ['review-ok'], 'review', 'merge', []],
    [
      'a UI card without the label is held, naming who may set it',
      ['review-ok', 'ui'],
      'review',
      'merge',
      [designOk],
    ],
    ['a UI card with the label passes', ['review-ok', 'ui', 'design-ok'], 'review', 'merge', []],
    [
      'a lacks_label condition binds the UI card',
      ['review-ok', 'ui', 'design-ok', 'wip'],
      'review',
      'merge',
      [noWip],
    ],
    ['a lacks_label condition spares the other cards', ['review-ok', 'wip'], 'review', 'merge', []],
    ['moving back into the stage checks it too', ['review-ok', 'ui'], 'release', 'merge', [designOk]],
    ['moving forward through the stage checks it', ['review-ok', 'ui'], 'dev', 'merge', [designOk]],
    ['moving away from the stage does not', ['ui'], 'merge', 'dev', []],
  ])('%s', (_name, labels, from, to, unmet) => {
    expect(evaluateMove(task(labels), conditional(), from, to).unmet).toEqual(unmet);
  });

  describe('aiLabelSetters', () => {
    const missing = (labels: string[], from = 'review', to = 'merge') =>
      evaluateMove(task(labels), conditional(), from, to).unmet;
    const none = () => false;

    it('names the AI member who sets the only missing label', () => {
      const setters = aiLabelSetters(conditional(), missing(['review-ok', 'ui']), none);
      expect(setters?.labels).toEqual(['design-ok']);
      expect(setters?.members.map((m) => m.handle)).toEqual(['des']);
    });

    it('refuses a gate that also holds back for a condition no AI member can meet', () => {
      expect(aiLabelSetters(conditional(), missing(['review-ok', 'ui', 'wip']), none)).toBeNull();
      expect(aiLabelSetters(conditional(), [], none)).toBeNull();
    });

    it('refuses a label that only people set', () => {
      const c = conditional();
      c.pipeline.labels.find((l) => l.id === 'design-ok')!.setBy = { members: ['owner'] };
      const unmet = evaluateMove(task(['review-ok', 'ui']), c, 'review', 'merge').unmet;
      expect(unmet).toHaveLength(1);
      expect(aiLabelSetters(c, unmet, none)).toBeNull();
    });

    it('refuses a label whose only AI setter authors the card', () => {
      const c = conditional();
      c.pipeline.labels.find((l) => l.id === 'design-ok')!.notByAuthor = true;
      const unmet = evaluateMove(task(['review-ok', 'ui'], { assignee: 'des' }), c, 'review', 'merge').unmet;
      expect(aiLabelSetters(c, unmet, none)).toBeNull();
    });

    it('prefers a setter that already has a session on the card, and one not on leave', () => {
      const c = conditional();
      c.pipeline.labels.find((l) => l.id === 'design-ok')!.setBy = { members: ['des', 'des2'] };
      c.team.members.push({ ...c.team.members.find((m) => m.handle === 'des')!, handle: 'des2' });
      const unmet = evaluateMove(task(['review-ok', 'ui']), c, 'review', 'merge').unmet;
      expect(aiLabelSetters(c, unmet, none)?.members.map((m) => m.handle)).toEqual(['des']);
      expect(aiLabelSetters(c, unmet, (h) => h === 'des2')?.members.map((m) => m.handle)).toEqual(['des2']);
    });
  });

  it('leaves out the setters the task authors under self-review rules', () => {
    const c = conditional();
    c.pipeline.labels.find((l) => l.id === 'design-ok')!.notByAuthor = true;
    const authored = task(['review-ok', 'ui'], { assignee: 'des' });
    expect(evaluateMove(authored, c, 'review', 'merge').unmet).toEqual([{ ...designOk, setters: [] }]);
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

  it('refuses a condition bound to a label on a release gate only', () => {
    const bound = { type: 'has_label', when: 'ui' } as const;
    expect(gateAcceptsCondition(release, bound, approval)).toBe(false);
    expect(gateAcceptsCondition(release, { type: 'lacks_label', when: 'ui' }, fact)).toBe(false);
    expect(gateAcceptsCondition(merge, bound, fact)).toBe(true);
    expect(gateAcceptsWhen(release, {})).toBe(true);
  });
});

describe('evaluateStart (PM-248)', () => {
  /** The queue stage holds the entry gate, as `ready` does on a `ui` card; `dev` is the work stage. */
  function gated() {
    const c = config();
    c.pipeline.stages.find((s) => s.id === 'backlog')!.gate = {
      conditions: [{ type: 'has_label', label: 'review-ok', when: 'wip' }],
    };
    return c;
  }
  const at = (stageId: string, labels: string[]) => ({ ...task(labels), stageId });

  it('evaluates the entry gate of the stage the card is in, which a move does not', () => {
    const c = gated();
    const card = at('backlog', ['wip']);
    expect(evaluateMove(card, c, 'backlog', 'dev')).toEqual({ unmet: [], approvals: [] });
    expect(evaluateStart(card, c, 'dev')).toEqual({
      unmet: [
        {
          stageId: 'backlog',
          condition: { type: 'has_label', label: 'review-ok', when: 'wip' },
          setters: ['rev'],
        },
      ],
      approvals: [],
    });
  });

  it('lets the card through when the label is there or the condition does not bind it', () => {
    const c = gated();
    expect(evaluateStart(at('backlog', ['wip', 'review-ok']), c, 'dev')).toEqual({
      unmet: [],
      approvals: [],
    });
    expect(evaluateStart(at('backlog', []), c, 'dev')).toEqual({ unmet: [], approvals: [] });
  });

  it('still evaluates the stages entered on the way, and blocking labels', () => {
    const c = gated();
    c.pipeline.stages.find((s) => s.id === 'dev')!.gate = {
      conditions: [{ type: 'has_label', label: 'merged' }],
    };
    const result = evaluateStart(at('backlog', ['waiting']), c, 'dev');
    expect(result.unmet.map((u) => u.stageId)).toEqual(['dev', 'backlog']);
  });

  it('has nothing to gate for a card in or past the work stage', () => {
    const c = gated();
    expect(evaluateStart(at('dev', ['wip']), c, 'dev')).toEqual({ unmet: [], approvals: [] });
    expect(evaluateStart(at('review', ['wip']), c, 'dev')).toEqual({ unmet: [], approvals: [] });
  });
});

describe('stageAdvance (PM-445)', () => {
  const at = (stageId: string, labels: string[]) => ({ ...task(labels), stageId });

  it('moves a card of a step stage on when the gate of the next stage holds', () => {
    expect(stageAdvance(at('review', ['review-ok']), config())).toMatchObject({
      kind: 'move',
      to: { id: 'merge' },
    });
  });

  it('asks for the approval when only a human-only label is missing', () => {
    expect(stageAdvance(at('merge', ['review-ok', 'merged']), config())).toMatchObject({
      kind: 'approve',
      to: { id: 'release' },
      approvals: [{ stageId: 'release', label: 'release-ok', approvers: ['owner', 'ann'] }],
    });
  });

  it('keeps the approval request when nobody may give it, for the caller to say so', () => {
    const authored = { ...at('merge', ['review-ok', 'merged']), assignee: 'owner' };
    const advance = stageAdvance(authored, config(true));
    expect(advance).toMatchObject({ kind: 'approve', approvals: [{ approvers: ['ann'] }] });
  });

  it('does nothing while another condition is unmet or a blocking label holds the card', () => {
    expect(stageAdvance(at('review', []), config())).toBeNull();
    expect(stageAdvance(at('merge', ['review-ok', 'release-ok']), config())).toBeNull();
    expect(stageAdvance(at('review', ['review-ok', 'waiting']), config())).toBeNull();
  });

  it('never moves a work stage, a queue, or the last stage on', () => {
    expect(stageAdvance(at('dev', ['review-ok']), config())).toBeNull();
    expect(stageAdvance(at('backlog', []), config())).toBeNull();
    expect(stageAdvance(at('done', []), config())).toBeNull();
  });

  it('never moves a card into a work stage by itself', () => {
    const c = config();
    const merge = c.pipeline.stages.find((s) => s.id === 'merge')!;
    merge.kind = 'work';
    expect(stageAdvance(at('review', ['review-ok']), c)).toBeNull();
  });

  it('does nothing when the next stage has no gate to say the stage is done', () => {
    const c = config();
    c.pipeline.stages.find((s) => s.id === 'merge')!.gate = undefined;
    expect(stageAdvance(at('review', []), c)).toBeNull();
  });
});
