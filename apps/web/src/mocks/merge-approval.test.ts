import { describe, expect, it } from 'vitest';
import { gateRequestOf } from '@projectman/shared';
import type { InboxItem, Task } from '@projectman/shared';
import { MockBackend } from './backend';

const project = '/api/projects/AC';

/**
 * The merge target is the done stage and entering it asks for the release approval (a small team's
 * "merge approved" in miniature): the move waits for a human approval and for the merge (PM-484).
 */
function setup() {
  const backend = new MockBackend();
  const stages = backend.config.pipeline.stages;
  stages.splice(
    stages.findIndex((stage) => stage.id === 'release'),
    1,
  );
  stages.find((stage) => stage.id === 'done')!.gate = {
    conditions: [{ type: 'has_label', label: 'release-approved' }],
  };
  backend.config.team.merger = { kind: 'member', handle: 'owner' };
  return backend;
}

const card = (backend: MockBackend) => backend.findTask('AC-27') as Task;
const open = (backend: MockBackend, kind: InboxItem['kind']) =>
  backend.inbox.filter((item) => item.kind === kind && item.taskKey === 'AC-27' && item.state === 'open');

describe('the web fake: the approval comes before the merge (PM-484)', () => {
  it('asks for the approval instead of refusing with task_not_merged, and names the merge', () => {
    const backend = setup();
    const response = backend.moveAs('AC-27', 'done', 'fe-1');
    expect(response.status).toBe(409);
    expect((response.body as { error: { code: string } }).error.code).toBe('approval_requested');
    const [gate] = open(backend, 'decision') as [InboxItem];
    expect(gateRequestOf(gate)).toMatchObject({
      label: 'release-approved',
      merge: { merger: 'owner', base: 'main' },
    });
    expect(open(backend, 'merge_request')).toHaveLength(0);
  });

  it('puts the label on with one approval, then asks the merger, and lets the card in once merged', () => {
    const backend = setup();
    backend.moveAs('AC-27', 'done', 'fe-1');
    const [gate] = open(backend, 'decision') as [InboxItem];
    const approved = backend.handle('POST', `${project}/inbox/${gate.id}/resolve`, { optionId: 'approve' });
    expect(approved.status).toBe(200);
    expect(card(backend).labels).toContain('release-approved');
    expect(card(backend).stageId).toBe('merge');
    expect(open(backend, 'merge_request')).toHaveLength(1);

    const started = backend.handle('POST', `${project}/tasks/AC-27/merge`, undefined, new URLSearchParams());
    expect(started.status).toBe(200);
    backend.runMerge('AC-27');
    expect(backend.moveAs('AC-27', 'done', 'owner').status).toBe(200);
    expect(card(backend).stageId).toBe('done');
  });

  it('closes a question that asked for the label when the approval puts it on', () => {
    const backend = setup();
    backend.upsertInbox({
      ...(backend.inbox.find((item) => item.kind === 'question') as InboxItem),
      id: 'inb_q_approval',
      taskKey: 'AC-27',
      assignees: ['owner'],
      state: 'open',
      resolution: null,
      payload: { question: 'Jóváhagyod?', approvalLabel: 'release-approved' },
    });
    backend.moveAs('AC-27', 'done', 'fe-1');
    const [gate] = open(backend, 'decision') as [InboxItem];
    backend.handle('POST', `${project}/inbox/${gate.id}/resolve`, { optionId: 'approve' });
    const question = backend.inbox.find((item) => item.id === 'inb_q_approval')!;
    expect(question.state).toBe('resolved');
    expect(question.resolution?.rule).toBe('approval_given');
  });
});
