import { describe, expect, it } from 'vitest';
import type { InboxItem, Task, TimelineEvent } from '@projectman/shared';
import { MockBackend } from './backend';

const tasks = '/api/projects/AC/tasks';

/** The card AC-20 stands in the work stage; the owner takes cards on (PM-457). */
function setup() {
  const backend = new MockBackend();
  backend.config.team.cardMover = { kind: 'human', handle: 'owner' };
  return backend;
}

const card = (backend: MockBackend, key = 'AC-20') => backend.findTask(key) as Task;
const handOnItems = (backend: MockBackend) => backend.inbox.filter((item) => item.kind === 'hand_on');

describe('the web fake: "Vidd tovább" (PM-461)', () => {
  it('asks the card mover when an AI member finishes a step, instead of moving the card', () => {
    const backend = setup();
    const response = backend.moveAs('AC-20', 'code_review', 'be-1');
    expect(response.status).toBe(200);
    expect(card(backend).stageId).toBe('dev');
    expect(card(backend).handOn).toMatchObject({
      fromStageId: 'dev',
      toStageId: 'code_review',
      mover: 'owner',
      requestedBy: 'be-1',
    });
    const [item] = handOnItems(backend) as [InboxItem];
    expect(item).toMatchObject({ assignees: ['owner'], source: 'be-1', taskKey: 'AC-20', state: 'open' });
    expect(card(backend).handOn?.inboxItemId).toBe(item.id);
    const events = backend.timeline.filter(
      (event: TimelineEvent) => event.type === 'task_hand_on_requested' && event.taskKey === 'AC-20',
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({ toStageId: 'code_review', mover: 'owner', requestedBy: 'be-1' });
  });

  it('asks once for the same request', () => {
    const backend = setup();
    backend.moveAs('AC-20', 'code_review', 'be-1');
    backend.moveAs('AC-20', 'code_review', 'be-1');
    expect(handOnItems(backend)).toHaveLength(1);
  });

  it('moves the card at once for a person, and when nobody is the card mover', () => {
    const human = setup();
    expect(human.moveAs('AC-20', 'code_review', 'owner').status).toBe(200);
    expect(card(human).stageId).toBe('code_review');
    expect(handOnItems(human)).toHaveLength(0);

    const worker = new MockBackend();
    worker.moveAs('AC-20', 'code_review', 'be-1');
    expect(card(worker).stageId).toBe('code_review');
  });

  it('moves the card when the mover resolves the item, and records who did it', () => {
    const backend = setup();
    backend.moveAs('AC-20', 'code_review', 'be-1');
    const item = handOnItems(backend)[0]!;
    const resolved = backend.handle('POST', `/api/projects/AC/inbox/${item.id}/resolve`, {
      optionId: 'move',
    });
    expect(resolved.status).toBe(200);
    expect(card(backend).stageId).toBe('code_review');
    expect(card(backend).handOn).toBeUndefined();
    const after = backend.inbox.find((entry) => entry.id === item.id)!;
    expect(after).toMatchObject({ state: 'resolved', resolution: { optionId: 'move', by: 'owner' } });
  });

  it('refuses the resolve while a gate is unmet: the item stays open and the card stays', () => {
    const backend = setup();
    backend.moveAs('AC-20', 'code_review', 'be-1');
    const item = handOnItems(backend)[0]!;
    // The gate closed after the request was made.
    backend.config.pipeline.stages.find((stage) => stage.id === 'code_review')!.gate = {
      conditions: [{ type: 'has_label', label: 'design-review-ok' }],
    };
    const resolved = backend.handle('POST', `/api/projects/AC/inbox/${item.id}/resolve`, {
      optionId: 'move',
    });
    expect(resolved.status).toBe(409);
    expect((resolved.body as { error: { code: string } }).error.code).toBe('gate_blocked');
    expect(card(backend).stageId).toBe('dev');
    expect(backend.inbox.find((entry) => entry.id === item.id)!.state).toBe('open');
    expect(card(backend).handOn).toBeDefined();
  });

  it('takes the request back when the card moves another way', () => {
    const backend = setup();
    backend.moveAs('AC-20', 'code_review', 'be-1');
    const item = handOnItems(backend)[0]!;
    const response = backend.handle('PATCH', `${tasks}/AC-20`, { stageId: 'ready' });
    expect(response.status).toBe(200);
    expect(card(backend).handOn).toBeUndefined();
    expect(backend.inbox.find((entry) => entry.id === item.id)!.state).toBe('cancelled');
  });

  it('shows the request on the task detail as the wait of the card mover', () => {
    const backend = setup();
    backend.moveAs('AC-20', 'code_review', 'be-1');
    const detail = backend.handle('GET', `${tasks}/AC-20`, undefined).body as {
      wait: { reason: string; toStageId: string; next: { handle: string }[] };
    };
    expect(detail.wait).toMatchObject({ reason: 'hand_on', toStageId: 'code_review' });
    expect(detail.wait.next.map((member) => member.handle)).toEqual(['owner']);
  });
});
