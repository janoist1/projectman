import { describe, expect, it } from 'vitest';
import { messageStaleReason, messageWakeBlock, messageWakes } from './message-wake';
import type { StaleFacts, WakeFacts } from './message-wake';
import type { TeamMessage } from './message';

/** A system or unknown sender: the role never matters. */
const wake: WakeFacts = {
  fromHuman: false,
  fromAi: false,
  recipientHasRole: true,
  recipientIsOperator: false,
  fromOwner: false,
};

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
    expect(messageWakes(action, wake, stale)).toBe(false);
  });

  it('never discards old unknown versions or human messages', () => {
    const obsolete = { ...facts, superseded: true, card: { open: false, stageId: 'done' } };
    expect(messageStaleReason({}, obsolete)).toBeNull();
    expect(messageWakes({}, wake, null)).toBe(true);
    expect(messageStaleReason(action, { ...obsolete, fromHuman: true })).toBeNull();
    expect(messageWakes({ kind: 'info' }, { ...wake, fromHuman: true }, null)).toBe(true);
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
    expect(messageWakes({ kind: 'info' }, wake, null)).toBe(false);
    expect(messageWakes(action, wake, null)).toBe(true);
  });

  describe('card role (PM-426)', () => {
    const aiNoRole: WakeFacts = { ...wake, fromAi: true, recipientHasRole: false };

    it('an AI member starts only recipients with a role on the card', () => {
      expect(messageWakes(action, aiNoRole, null)).toBe(false);
      expect(messageWakeBlock(action, aiNoRole, null)).toBe('no_card_role');
      expect(messageWakes({}, aiNoRole, null)).toBe(false);
      expect(messageWakes(action, { ...aiNoRole, recipientHasRole: true }, null)).toBe(true);
      expect(messageWakeBlock(action, { ...aiNoRole, recipientHasRole: true }, null)).toBeNull();
    });

    it('a person, the system, an info or a stale message is not blocked by the role', () => {
      expect(messageWakes(action, { ...aiNoRole, fromHuman: true, fromAi: false }, null)).toBe(true);
      expect(messageWakeBlock(action, { ...aiNoRole, fromHuman: true, fromAi: false }, null)).toBeNull();
      expect(messageWakes(action, { ...aiNoRole, fromAi: false }, null)).toBe(true);
      expect(messageWakeBlock(action, { ...aiNoRole, fromAi: false }, null)).toBeNull();
      expect(messageWakeBlock({ kind: 'info' }, aiNoRole, null)).toBeNull();
      expect(messageWakeBlock(action, aiNoRole, 'stage_moved')).toBeNull();
      expect(messageWakes(action, aiNoRole, 'stage_moved')).toBe(false);
    });
  });

  describe('the Operator works only on the owner’s request (PM-447)', () => {
    const toOperator: WakeFacts = { ...wake, recipientIsOperator: true };
    const ownerSender: WakeFacts = { ...toOperator, fromHuman: true, fromOwner: true };

    it('the owner’s own message wakes it, an action or an info alike', () => {
      for (const message of [{}, { kind: 'action' as const }, { kind: 'info' as const }]) {
        expect(messageWakes(message, ownerSender, null)).toBe(true);
        expect(messageWakeBlock(message, ownerSender, null)).toBeNull();
      }
    });

    it.each([
      ['another person', { ...toOperator, fromHuman: true }],
      ['the owner through the integrator key', { ...toOperator, fromHuman: true, fromOwner: false }],
      ['an AI member with a role on the card', { ...toOperator, fromAi: true }],
      ['an AI member without a role on the card', { ...toOperator, fromAi: true, recipientHasRole: false }],
      ['the system', toOperator],
    ])('a message from %s does not wake it and says why', (_who, facts) => {
      expect(messageWakes({}, facts, null)).toBe(false);
      expect(messageWakes({ kind: 'action' }, facts, null)).toBe(false);
      expect(messageWakes({ kind: 'info' }, facts, null)).toBe(false);
      expect(messageWakeBlock({}, facts, null)).toBe('operator_owner_only');
    });

    it('an info or a stale message is not blocked, it just starts nothing', () => {
      const other: WakeFacts = { ...toOperator, fromAi: true };
      expect(messageWakeBlock({ kind: 'info' }, other, null)).toBeNull();
      expect(messageWakeBlock({}, other, 'stage_moved')).toBeNull();
    });

    it('does not change who wakes the other members', () => {
      expect(messageWakes({}, { ...wake, fromHuman: true, fromOwner: false }, null)).toBe(true);
      expect(messageWakes({}, { ...wake, fromOwner: true }, null)).toBe(true);
    });
  });
});
