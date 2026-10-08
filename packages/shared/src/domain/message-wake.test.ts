import { describe, expect, it } from 'vitest';
import { messageStaleReason, messageWakes } from './message-wake';
import type { StaleFacts } from './message-wake';
import type { TeamMessage } from './message';

const facts: StaleFacts = {
  fromHuman: false,
  card: { open: true, stageId: 'review' },
  recipientOwnsStage: false,
  superseded: false,
  senderResultLabel: null,
  resultCommits: [],
  subjectClosed: false,
};
const action: Pick<TeamMessage, 'kind' | 'version' | 'subject'> = {
  kind: 'action',
  version: { stageId: 'review', commit: 'A', reviewCommit: 'A' },
};

describe('message validity and wake-up', () => {
  it.each([
    [{ card: { open: false, stageId: 'review' } }, 'card_closed'],
    [{ card: { open: true, stageId: 'dev' } }, 'stage_moved'],
    [{ superseded: true }, 'superseded'],
    [{ senderResultLabel: 'code-review-ok' }, 'sender_result'],
    [{ resultCommits: ['A'] }, 'result_recorded'],
  ] as const)('marks obsolete actions from current server facts', (changes, reason) => {
    const stale = messageStaleReason(action, { ...facts, ...changes });
    expect(stale).toBe(reason);
    expect(messageWakes(action, facts, stale)).toBe(false);
  });

  it('never discards old unknown versions or human messages', () => {
    const obsolete = { ...facts, superseded: true, card: { open: false, stageId: 'done' } };
    expect(messageStaleReason({}, obsolete)).toBeNull();
    expect(messageWakes({}, facts, null)).toBe(true);
    expect(messageStaleReason(action, { ...obsolete, fromHuman: true })).toBeNull();
    expect(messageWakes({ kind: 'info' }, { fromHuman: true }, null)).toBe(true);
  });

  it('keeps a changed stage actionable for its assignee or owner', () => {
    expect(
      messageStaleReason(action, {
        ...facts,
        card: { open: true, stageId: 'dev' },
        recipientOwnsStage: true,
      }),
    ).toBeNull();
  });

  it('requires exact result commit equality and gives supersession priority', () => {
    expect(messageStaleReason(action, { ...facts, resultCommits: ['C'] })).toBeNull();
    expect(messageStaleReason(action, { ...facts, resultCommits: ['A'], superseded: true })).toBe(
      'superseded',
    );
  });

  it('marks closed permission subjects even without a card version', () => {
    expect(
      messageStaleReason(
        { subject: { type: 'permission', inboxItemId: 'inb_1' } },
        { ...facts, subjectClosed: true },
      ),
    ).toBe('permission_closed');
  });

  it('an info message starts nothing and needs no stale marker', () => {
    expect(messageStaleReason({ ...action, kind: 'info' }, { ...facts, superseded: true })).toBeNull();
    expect(messageWakes({ kind: 'info' }, facts, null)).toBe(false);
    expect(messageWakes(action, facts, null)).toBe(true);
  });
});
