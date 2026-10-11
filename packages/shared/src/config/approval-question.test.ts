import { describe, expect, it } from 'vitest';
import { ProjectConfig } from './schema';
import { questionApprovalLabel } from './approval-question';

const config = ProjectConfig.parse({
  schemaVersion: 1,
  project: { key: 'AR', name: 'Acme', workspacePath: '/work/acme', repos: [] },
  team: {
    members: [{ kind: 'human', handle: 'owner', displayName: 'Owner', access: 'owner', roles: ['operator'] }],
    limits: {},
  },
  pipeline: {
    columns: [{ id: 'all', name: 'All' }],
    stages: [
      { id: 'dev', name: 'Development', kind: 'work', columnId: 'all' },
      { id: 'review', name: 'Review', kind: 'step', columnId: 'all' },
      {
        id: 'done',
        name: 'Done',
        kind: 'done',
        columnId: 'all',
        gate: {
          conditions: [
            { type: 'has_label', label: 'code-review-ok' },
            { type: 'has_label', label: 'merge-approved' },
          ],
        },
      },
    ],
    labels: [
      { id: 'code-review-ok', name: 'Reviewed', setBy: 'anyone' },
      { id: 'merge-approved', name: 'Merge jóváhagyva', setBy: { members: ['owner'], humansOnly: true } },
      { id: 'waiting-answer', name: 'Waiting', blocks: true },
    ],
  },
});
const task = { stageId: 'dev', labels: [] as string[], assignee: null, links: [] };
const ask = (text: string, overrides: Partial<typeof task> = {}, assignees = ['owner']) =>
  questionApprovalLabel(config, { ...task, ...overrides }, { text, assignees });

describe('questionApprovalLabel', () => {
  it.each(['Please set merge-approved.', '`MERGE-APPROVED`?', 'The Merge JÓVÁHAGYVA label?'])(
    'recognizes an explicit approval reference: %s',
    (text) => expect(ask(text)).toBe('merge-approved'),
  );
  it.each(['merge-approved-x', 'x-merge-approved', 'xmerge-approved', 'Which font?'])(
    'does not infer approval in development: %s',
    (text) => expect(ask(text)).toBeNull(),
  );
  it('infers the next approval only when other conditions hold and an approver is asked', () => {
    expect(ask('May we proceed?', { stageId: 'review' })).toBeNull();
    expect(ask('May we proceed?', { stageId: 'review', labels: ['code-review-ok'] })).toBe('merge-approved');
    expect(
      ask('May we proceed?', { stageId: 'review', labels: ['code-review-ok'] }, ['someone-else']),
    ).toBeNull();
    expect(ask('May we proceed?', { stageId: 'review', labels: ['code-review-ok', 'waiting-answer'] })).toBe(
      'merge-approved',
    );
  });
  it('ignores approvals already given and cards in the last stage', () => {
    expect(ask('merge-approved?', { labels: ['merge-approved'] })).toBeNull();
    expect(ask('merge-approved?', { stageId: 'done' })).toBeNull();
  });
});
