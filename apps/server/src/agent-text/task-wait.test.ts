import { TaskWaitReason } from '@projectman/shared';
import type { TaskWait } from '@projectman/shared';
import { describe, expect, it } from 'vitest';
import { describeTaskWait, taskWaitShort } from '.';

function wait(reason: TaskWait['reason'], fields: Partial<TaskWait> = {}): TaskWait {
  return {
    reason,
    next: [{ handle: 'dev-1', kind: 'ai' }],
    toStageId: null,
    labels: [],
    inboxItemId: null,
    inboxKind: null,
    startWaiting: null,
    prerequisites: [],
    since: '2026-10-10T20:00:00.000Z',
    ...fields,
  };
}

describe('describeTaskWait and taskWaitShort (PM-460)', () => {
  it('word every reason, naming the members by handle', () => {
    for (const reason of TaskWaitReason.options) {
      expect(describeTaskWait(wait(reason)), reason).toMatch(/\S/);
      expect(taskWaitShort(wait(reason)), reason).toMatch(/\S/);
    }
    expect(describeTaskWait(wait('working'))).toBe('dev-1 works on it now.');
    expect(describeTaskWait(wait('working', { next: [] }))).toContain('works on it');
    expect(taskWaitShort(wait('working'))).toBe('worked on by dev-1');
  });

  it('name the person an approval, an item or a hand-on waits for', () => {
    const owner = [{ handle: 'owner', kind: 'human' as const }];
    expect(describeTaskWait(wait('approval', { next: owner, labels: ['qa-ok'], toStageId: 'done' }))).toBe(
      'waits for the approval qa-ok of owner (to enter done).',
    );
    expect(describeTaskWait(wait('inbox', { next: owner, inboxKind: 'question' }))).toBe(
      'an open question waits for owner.',
    );
    expect(describeTaskWait(wait('hand_on', { next: owner, toStageId: 'review' }))).toBe(
      'the work is done; owner moves it on to review.',
    );
    expect(taskWaitShort(wait('approval', { next: owner }))).toBe('waits for owner');
  });

  it('name the prerequisites, the holding labels and the faulty set-up', () => {
    expect(describeTaskWait(wait('prerequisite', { next: [], prerequisites: ['AR-2', 'AR-3'] }))).toBe(
      'open prerequisites: AR-2, AR-3.',
    );
    expect(taskWaitShort(wait('prerequisite', { next: [], prerequisites: ['AR-2'] }))).toBe('waits for AR-2');
    expect(taskWaitShort(wait('held', { next: [], labels: ['waiting-answer'] }))).toBe(
      'held by waiting-answer',
    );
    expect(taskWaitShort(wait('nobody', { next: [] }))).toBe('nobody can take it on');
    expect(describeTaskWait(wait('nobody', { next: [], labels: ['qa-ok'] }))).toContain('qa-ok');
  });
});
