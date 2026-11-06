import { describe, expect, it } from 'vitest';
import type { ConfigVersionEntry } from '../api/dto';
import {
  configDiff,
  configHistoryEntries,
  revertMessage,
  revertTarget,
  sameConfig,
  type ConfigDiffItem,
} from './diff';
import { ProjectConfig, type ProjectConfigInput } from './schema';

function input(): ProjectConfigInput {
  return {
    schemaVersion: 1,
    project: {
      key: 'AC',
      name: 'Acme',
      workspacePath: '/work/acme',
      repos: [{ name: 'web', path: '.', github: 'acme/web', requireMerge: false }],
    },
    team: {
      members: [
        { kind: 'human', handle: 'owner', displayName: 'Owner', access: 'owner', roles: ['operator'] },
        { kind: 'ai', handle: 'dev-1', displayName: 'Developer', role: 'developer', sponsor: 'owner' },
      ],
      limits: {},
    },
    pipeline: {
      columns: [
        { id: 'todo', name: 'To do' },
        { id: 'doing', name: 'Doing' },
      ],
      stages: [
        { id: 'ready', name: 'Ready', kind: 'queue', columnId: 'todo' },
        { id: 'dev', name: 'Dev', kind: 'work', columnId: 'doing' },
        { id: 'review', name: 'Review', kind: 'step', columnId: 'doing' },
        { id: 'done', name: 'Done', kind: 'done', columnId: 'doing' },
      ],
      labels: [
        { id: 'urgent', name: 'Urgent' },
        { id: 'ui', name: 'UI' },
      ],
    },
  };
}

function build(change: (config: ProjectConfig) => void = () => {}): ProjectConfig {
  const config = ProjectConfig.parse(input());
  change(config);
  return config;
}

const diff = (change: (config: ProjectConfig) => void): ConfigDiffItem[] =>
  configDiff(build(), build(change));

describe('configDiff', () => {
  it('finds nothing in the same configuration, whatever the key order', () => {
    const reordered = ProjectConfig.parse(JSON.parse(JSON.stringify(build()))) as ProjectConfig;
    reordered.project = Object.fromEntries(Object.entries(reordered.project).reverse()) as never;
    expect(configDiff(build(), reordered)).toEqual([]);
    expect(sameConfig(build(), reordered)).toBe(true);
  });

  it('names an added, a removed and a renamed stage', () => {
    expect(
      diff((c) => {
        c.pipeline.stages.splice(2, 0, { id: 'qa', name: 'QA', kind: 'step', columnId: 'doing' });
        c.pipeline.stages = c.pipeline.stages.filter((stage) => stage.id !== 'dev');
        c.pipeline.stages.find((stage) => stage.id === 'ready')!.name = 'Go';
      }),
    ).toEqual([
      { kind: 'stage_renamed', id: 'ready', name: 'Go', from: 'Ready' },
      { kind: 'stage_added', id: 'qa', name: 'QA' },
      { kind: 'stage_removed', id: 'dev', name: 'Dev' },
    ]);
  });

  it('reports a rename together with a gate change', () => {
    expect(
      diff((c) => {
        const stage = c.pipeline.stages.find((s) => s.id === 'review')!;
        stage.name = 'Check';
        stage.gate = { conditions: [{ type: 'has_label', label: 'urgent' }] };
      }),
    ).toEqual([
      { kind: 'stage_renamed', id: 'review', name: 'Check', from: 'Review' },
      { kind: 'stage_changed', id: 'review', name: 'Check', fields: ['gate'] },
    ]);
  });

  it('lists the fields of a stage that changed, the column under its own name', () => {
    expect(
      diff((c) => {
        const stage = c.pipeline.stages.find((s) => s.id === 'review')!;
        stage.columnId = 'todo';
        stage.description = 'Look at it';
        stage.owners = ['owner'];
      }),
    ).toEqual([
      { kind: 'stage_changed', id: 'review', name: 'Review', fields: ['description', 'column', 'owners'] },
    ]);
  });

  it.each([
    ['one stage jumps back', ['review', 'ready', 'dev', 'done'], ['review']],
    ['one stage jumps ahead', ['dev', 'review', 'done', 'ready'], ['ready']],
    // Either of two swapped stages is the one moved; the later of them in the new order is reported.
    ['two swap', ['ready', 'review', 'dev', 'done'], ['dev']],
  ])('finds the stages moved when %s', (_name, order, moved) => {
    const items = diff((c) => {
      const stages = new Map(c.pipeline.stages.map((stage) => [stage.id, stage]));
      c.pipeline.stages = order.map((id) => stages.get(id)!);
    });
    expect(items.map((item) => (item.kind === 'stage_moved' ? item.id : item.kind))).toEqual(moved);
  });

  it('describes columns: added, removed, renamed and the fields that changed', () => {
    expect(
      diff((c) => {
        c.pipeline.columns = [
          { id: 'doing', name: 'Working', color: 'blue', hint: 'In progress' },
          { id: 'todo', name: 'To do' },
          { id: 'extra', name: 'Extra' },
        ];
      }),
    ).toEqual([
      { kind: 'column_renamed', id: 'doing', name: 'Working', from: 'Doing' },
      { kind: 'column_changed', id: 'doing', name: 'Working', fields: ['color', 'hint'] },
      { kind: 'column_changed', id: 'todo', name: 'To do', fields: ['order'] },
      { kind: 'column_added', id: 'extra', name: 'Extra' },
    ]);
  });

  it('describes labels: added, removed, and name, colour or rules changed', () => {
    expect(
      diff((c) => {
        c.pipeline.labels = [
          { id: 'urgent', name: 'Hurry', color: 'red', blocks: true, setBy: 'anyone' },
          { id: 'extra', name: 'Extra', setBy: 'anyone' },
        ];
      }),
    ).toEqual([
      { kind: 'label_changed', id: 'urgent', name: 'Hurry', fields: ['name', 'color', 'rules'] },
      { kind: 'label_added', id: 'extra', name: 'Extra' },
      { kind: 'label_removed', id: 'ui', name: 'UI' },
    ]);
  });

  it.each<[string, (c: ProjectConfig) => void, string]>([
    ['name', (c) => (c.project.name = 'Acme 2'), 'project'],
    ['feedback', (c) => (c.project.feedback = { enabled: false } as never), 'project'],
    ['repos', (c) => (c.project.repos[0]!.requireMerge = true), 'repos'],
    ['members', (c) => c.team.members.pop(), 'team'],
    ['card mover', (c) => (c.team.cardMover = { kind: 'project_manager' }), 'team'],
    [
      'roles',
      (c) => (c.team.roles = [{ id: 'x', name: 'X', summary: 'Y', holders: 'both' }] as never),
      'duties',
    ],
    ['four eyes', (c) => (c.team.releaseFourEyes = true), 'duties'],
    ['limits', (c) => (c.team.limits.maxFixRounds = 5), 'limits'],
  ])('puts a change of %s under its section', (_name, change, section) => {
    expect(diff(change)).toEqual([{ kind: 'section_changed', section }]);
  });

  it('does not count writing out a default as a change', () => {
    expect(diff((c) => (c.team.assigneeFit = 'automatic'))).toEqual([]);
  });

  it('falls back to other when no kind fits, also next to known ones', () => {
    const unclassified = (c: ProjectConfig) => {
      (c.pipeline.stages[0] as Record<string, unknown>).futureField = 1;
    };
    expect(diff(unclassified)).toEqual([{ kind: 'other' }]);
    expect(
      diff((c) => {
        unclassified(c);
        c.project.name = 'Acme 2';
      }),
    ).toEqual([{ kind: 'section_changed', section: 'project' }, { kind: 'other' }]);
  });
});

describe('revert message', () => {
  it('is read back to the 12-character id it names', () => {
    const message = revertMessage('AC', '0123456789abcdef0123');
    expect(message).toBe('Revert AC configuration to 0123456789ab');
    expect(revertTarget(message)).toBe('0123456789ab');
    expect(revertTarget('Update configuration')).toBeNull();
  });
});

describe('configHistoryEntries', () => {
  const entry = (version: string, message = 'Update configuration'): ConfigVersionEntry => ({
    version,
    message,
    author: 'Ann',
    at: '2026-11-01T10:00:00Z',
  });
  const named = (name: string) => build((c) => (c.project.name = name));

  it('marks the first version created and compares every other with the one before', () => {
    const rows = [
      { entry: entry('c'), config: named('B') },
      { entry: entry('b'), config: named('A') },
      { entry: entry('a'), config: build() },
    ];
    expect(configHistoryEntries(rows, 3).map((row) => row.changes)).toEqual([
      [{ kind: 'section_changed', section: 'project' }],
      [{ kind: 'section_changed', section: 'project' }],
      [{ kind: 'created' }],
    ]);
  });

  it('gives no changes for a version that cannot be read, on either side', () => {
    const rows = [
      { entry: entry('c'), config: named('B') },
      { entry: entry('b'), config: null },
      { entry: entry('a'), config: build() },
    ];
    expect(configHistoryEntries(rows, 3).map((row) => row.changes)).toEqual([
      null,
      null,
      [{ kind: 'created' }],
    ]);
  });

  it('lists only the page, the older rows serve for comparison', () => {
    const rows = [
      { entry: entry('c'), config: named('B') },
      { entry: entry('b'), config: named('A') },
      { entry: entry('a'), config: build() },
    ];
    const page = configHistoryEntries(rows, 1);
    expect(page).toHaveLength(1);
    expect(page[0]!.changes).toEqual([{ kind: 'section_changed', section: 'project' }]);
  });

  it('recognises an undo: the configuration of two versions back, with the changes it undid', () => {
    const rows = [
      { entry: entry('c'), config: build() },
      { entry: entry('b'), config: named('A') },
      { entry: entry('a'), config: build() },
    ];
    const [undo] = configHistoryEntries(rows, 2);
    expect(undo!.restores).toEqual({
      kind: 'undo',
      version: 'b',
      changes: [{ kind: 'section_changed', section: 'project' }],
    });
  });

  it('recognises a revert from its message, without changes of its own to show', () => {
    const rows = [
      { entry: entry('c', revertMessage('AC', 'aaaaaaaaaaaabbbb')), config: build() },
      { entry: entry('b'), config: named('A') },
      { entry: entry('a'), config: build() },
    ];
    expect(configHistoryEntries(rows, 1)[0]!.restores).toEqual({
      kind: 'revert',
      version: 'aaaaaaaaaaaa',
      changes: null,
    });
  });
});
