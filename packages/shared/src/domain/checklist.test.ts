import { expect, it } from 'vitest';
import { ProjectConfig } from '../config/schema';
import { CHECKLIST_CONDITIONS, checklistConditionHolds, checklistProgress } from './checklist';

function config() {
  return ProjectConfig.parse({
    schemaVersion: 1,
    project: { key: 'AR', name: 'Example', workspacePath: '/work', repos: [{ name: 'web', path: '.' }] },
    team: {
      members: [{ kind: 'human', handle: 'owner', displayName: 'Owner', access: 'owner', roles: [] }],
      limits: {},
    },
    pipeline: {
      columns: [{ id: 'all', name: 'All' }],
      stages: [
        { id: 'ready', name: 'Ready', kind: 'queue', columnId: 'all' },
        { id: 'done', name: 'Done', kind: 'done', columnId: 'all' },
      ],
    },
  });
}

it.each(CHECKLIST_CONDITIONS)('checks both outcomes of %s', (condition) => {
  const c = config();
  c.team.merger = { kind: 'member', handle: 'missing' };
  expect(checklistConditionHolds(condition, c, { agreementApproved: false, taskCount: 0 })).toBe(false);
  c.team.members.push(
    { kind: 'human', handle: 'client', displayName: 'Client', access: 'client', roles: [] },
    {
      kind: 'human',
      handle: 'reviewer',
      displayName: 'Reviewer',
      roles: ['code_review'],
      access: 'developer',
    },
    { kind: 'human', handle: 'qa', displayName: 'QA', roles: ['qa'], access: 'developer' },
  );
  c.team.merger = { kind: 'member', handle: 'owner' };
  c.pipeline.stages.unshift({
    id: 'review',
    name: 'Review',
    kind: 'step',
    columnId: 'all',
    duty: 'code_review',
  });
  c.pipeline.stages.at(-1)!.gate = { conditions: [{ type: 'has_label', label: 'code-review-ok' }] };
  c.project.feedback = {
    surfaces: [{ id: 'web', name: 'Web', origin: 'https://example.com' }],
    blockedMarkers: [],
  };
  expect(checklistConditionHolds(condition, c, { agreementApproved: true, taskCount: 1 })).toBe(true);
});

it('counts done and not needed items as settled', () => {
  expect(checklistProgress([{ state: 'open' }, { state: 'done' }, { state: 'not_needed' }])).toEqual({
    settled: 2,
    total: 3,
    complete: false,
  });
  expect(checklistProgress([{ state: 'done' }]).complete).toBe(true);
  expect(checklistProgress([])).toEqual({ settled: 0, total: 0, complete: true });
});
