import { describe, expect, it } from 'vitest';
import type { Task } from '../domain/task';
import { partLeft, partReadyStage } from './left-parts';
import { ProjectConfig } from './schema';
import { taskWait } from './task-wait';

function config({ refines = true, firstIsReady = false } = {}) {
  return ProjectConfig.parse({
    schemaVersion: 1,
    project: { key: 'AC', name: 'Acme', workspacePath: '/work/acme', repos: [] },
    team: {
      members: [
        { kind: 'human', handle: 'owner', displayName: 'Owner', access: 'owner' },
        { kind: 'ai', handle: 'architect', displayName: 'Architect', role: 'architect', sponsor: 'owner' },
        { kind: 'ai', handle: 'dev-1', displayName: 'Developer', role: 'developer', sponsor: 'owner' },
        { kind: 'ai', handle: 'pm', displayName: 'PM', role: 'project_manager', sponsor: 'owner' },
      ],
      limits: {},
    },
    pipeline: {
      columns: [{ id: 'all', name: 'All' }],
      stages: [
        ...(firstIsReady ? [] : [{ id: 'incoming', name: 'Incoming', kind: 'queue', columnId: 'all' }]),
        {
          id: 'ready',
          name: 'Ready',
          kind: 'queue',
          columnId: 'all',
          gate: { conditions: [{ type: 'has_label', label: 'scope-ok' }] },
        },
        { id: 'dev', name: 'Development', kind: 'work', owners: ['dev-1'], columnId: 'all' },
        { id: 'done', name: 'Done', kind: 'done', columnId: 'all' },
      ],
      labels: [
        ...(refines ? [{ id: 'refine', name: 'Refine', setBy: { members: ['architect'] } }] : []),
        { id: 'scope-ok', name: 'Scope ok', setBy: { members: ['architect'] } },
        { id: 'waiting-answer', name: 'Waiting', blocks: true },
      ],
    },
  });
}

const part = (over: Partial<Task> = {}): Task => ({
  id: 'tsk_2',
  projectKey: 'AC',
  key: 'AC-2',
  title: 'A part',
  description: '',
  stageId: 'incoming',
  status: 'waiting',
  assignee: null,
  repo: null,
  priority: null,
  labels: [],
  links: [],
  visibility: 'internal',
  kind: 'task',
  parentKey: 'AC-1',
  createdBy: 'architect',
  createdAt: '2026-10-10T10:00:00.000Z',
  updatedAt: '2026-10-10T10:00:00.000Z',
  closedAt: null,
  ...over,
});

describe('partReadyStage', () => {
  it('is the stage before the development stage', () => {
    expect(partReadyStage(config())?.id).toBe('ready');
  });

  it('is none when that stage is the first one: nothing to take the part out to', () => {
    expect(partReadyStage(config({ firstIsReady: true }))).toBeNull();
  });
});

describe('partLeft', () => {
  it('names the member who created a part that stands in the first stage', () => {
    expect(partLeft(part(), config())).toEqual({ member: 'architect', parentKey: 'AC-1' });
  });

  it.each([
    ['a developer created it', { createdBy: 'dev-1' }],
    ['the project manager created it', { createdBy: 'pm' }],
    ['a person created it', { createdBy: 'owner' }],
    ['it is not a part', { parentKey: null }],
    ['it carries refine', { labels: ['refine'] }],
    ['a holding label is on it', { labels: ['waiting-answer'] }],
    ['it has left the first stage', { stageId: 'ready' }],
    ['it is closed', { status: 'done' }],
    ['it is cancelled', { status: 'cancelled' }],
    ['it is blocked', { status: 'blocked' }],
    ['it is a theme', { kind: 'theme' }],
  ] as const)('is not left when %s', (_name, over) => {
    expect(partLeft(part(over as Partial<Task>), config())).toBeNull();
  });

  it('is not left in a project without refinement', () => {
    expect(partLeft(part(), config({ refines: false }))).toBeNull();
  });

  it('is not left when the first stage is also the one the parts would go to', () => {
    expect(partLeft(part({ stageId: 'ready' }), config({ firstIsReady: true }))).toBeNull();
  });
});

describe('taskWait of a left part', () => {
  const wait = (task: Task, rulesKnown?: boolean) =>
    taskWait({
      task,
      config: config(),
      openItems: [],
      workers: [],
      holders: [],
      openPrerequisites: [],
      viewer: null,
      rulesKnown,
    });

  it('says the creator takes it on, with the labels its next stage lacks', () => {
    expect(wait(part())).toMatchObject({
      reason: 'part_left',
      next: [{ handle: 'architect', kind: 'ai' }],
      toStageId: 'ready',
      labels: ['scope-ok'],
      since: '2026-10-10T10:00:00.000Z',
    });
  });

  it('comes before the start rule, which would say the part lacks labels', () => {
    expect(wait(part({ labels: ['scope-ok'] }))?.reason).toBe('part_left');
  });

  it('is not asked where the rules are not known', () => {
    expect(wait(part(), false)?.reason).not.toBe('part_left');
  });

  it('gives way to the refinement once the part carries refine', () => {
    expect(wait(part({ labels: ['refine'] }))?.reason).not.toBe('part_left');
  });
});
