import { describe, expect, it } from 'vitest';
import { MockBackend } from './backend';

/** AC-25 is a collecting card of the review column; AC-26 and AC-21 are its subtasks. */
function setup(statuses: {
  'AC-26': 'done' | 'cancelled' | 'active';
  'AC-21': 'done' | 'cancelled' | 'active';
}) {
  const backend = new MockBackend();
  for (const [key, status] of Object.entries(statuses)) {
    const part = backend.findTask(key)!;
    part.parentKey = 'AC-25';
    part.status = status;
  }
  return backend;
}

describe('the web fake: a collecting card whose subtasks are closed goes to Done without the gates (PM-647)', () => {
  it('lets the card through, and records the subtasks on the stage change', () => {
    const backend = setup({ 'AC-26': 'done', 'AC-21': 'cancelled' });
    expect(backend.moveAs('AC-25', 'done', 'owner').status).toBe(200);
    expect(backend.findTask('AC-25')).toMatchObject({ stageId: 'done', status: 'done' });
    const event = backend.timeline.filter(
      (item) => item.taskKey === 'AC-25' && item.type === 'task_stage_changed',
    );
    expect(event.at(-1)?.data).toMatchObject({
      to: 'done',
      partsClosed: { done: ['AC-26'], cancelled: ['AC-21'] },
    });
  });

  it('keeps the gates while a subtask is open or when every subtask was cancelled', () => {
    for (const statuses of [
      { 'AC-26': 'done', 'AC-21': 'active' },
      { 'AC-26': 'cancelled', 'AC-21': 'cancelled' },
    ] as const) {
      const backend = setup(statuses);
      const response = backend.moveAs('AC-25', 'done', 'owner');
      expect(response.status).toBe(409);
      expect((response.body as { error: { code: string } }).error.code).toBe('gate_blocked');
      expect(backend.findTask('AC-25')?.stageId).not.toBe('done');
    }
  });
});
