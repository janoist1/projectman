import { TaskWaitReason } from '@projectman/shared';
import type { TaskWait } from '@projectman/shared';
import { describe, expect, it } from 'vitest';
import { describeTaskWait, partsLeftText, taskWaitShort } from '.';

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
    expect(taskWaitShort(wait('approval', { next: owner }))).toBe('waits for the approval of owner');
  });

  it('say something useful in the short part when nobody is named', () => {
    const nobodyNamed = { next: [] };
    expect(taskWaitShort(wait('queued', nobodyNamed))).toBe('queued for the owner of its stage');
    expect(taskWaitShort(wait('hand_on', nobodyNamed))).toBe('done, to be moved on by the card mover');
    expect(taskWaitShort(wait('approval', nobodyNamed))).toBe('waits for the approval of a person');
    expect(taskWaitShort(wait('inbox', nobodyNamed))).toBe('waits for an open request');
    expect(taskWaitShort(wait('assignee', nobodyNamed))).toBe('waits for its assignee');
    for (const reason of TaskWaitReason.options) {
      expect(taskWaitShort(wait(reason, nobodyNamed)), reason).not.toMatch(/waits for (queued|hand on)\b/);
    }
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

  it('say that a left part is taken on by its creator (PM-480)', () => {
    const left = wait('part_left', {
      next: [{ handle: 'arch', kind: 'ai' }],
      toStageId: 'ready',
      labels: ['scope-ok'],
    });
    expect(describeTaskWait(left)).toBe(
      'a part of a broken-down card was left in its first stage: arch takes it on (labels scope-ok → ready, or refine).',
    );
    expect(taskWaitShort(left)).toBe('part left in its first stage; arch takes it on');
    expect(taskWaitShort(wait('part_left', { next: [] }))).toBe(
      'part left in its first stage; its creator takes it on',
    );
  });
});

describe('partsLeftText (PM-480)', () => {
  const input = { parentKey: 'AR-1', firstStage: 'incoming', target: 'ready', refineLabel: 'refine' };

  it('names the parts and what to do with them, and that it is said once', () => {
    const text = partsLeftText({
      ...input,
      parts: [
        { key: 'AR-2', title: 'First' },
        { key: 'AR-3', title: 'Second' },
      ],
    });
    expect(text).toContain('You broke AR-1 down, and 2 of its parts are still in incoming');
    expect(text).toContain('AR-2 "First", AR-3 "Second"');
    expect(text).toContain('move it to ready with update_task');
    expect(text).toContain('add `refine`');
    expect(text).toContain('prerequisite relations');
    expect(text).toContain('You are told this once');
  });

  it('speaks of one part in the singular', () => {
    const text = partsLeftText({ ...input, parts: [{ key: 'AR-2', title: 'First' }] });
    expect(text).toContain('1 of its parts is still in incoming, where nobody starts it:');
  });
});
