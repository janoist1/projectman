import { describe, expect, it } from 'vitest';
import { OPERATOR_ANSWER_STALL_GRACE_MS } from '../api/dto';
import { answerStallEvidence } from './answer-stall';
import type { AnswerStallInput } from './answer-stall';

const NOW = Date.parse('2026-10-14T10:00:00.000Z');
const at = (ms: number) => new Date(NOW + ms).toISOString();

function input(over: Partial<AnswerStallInput> = {}): AnswerStallInput {
  return {
    now: NOW,
    labelled: false,
    openQuestion: false,
    permissionWaiting: false,
    working: false,
    waitingInput: false,
    idleSince: 0,
    lastStepAt: null,
    evidence: [{ id: 'msg_1', at: at(-OPERATOR_ANSWER_STALL_GRACE_MS), carriesAnswer: false }],
    ...over,
  };
}

describe('answerStallEvidence', () => {
  it('stands exactly at the grace, not a second before', () => {
    expect(answerStallEvidence(input())).toMatchObject({ id: 'msg_1' });
    expect(
      answerStallEvidence(
        input({
          evidence: [{ id: 'msg_1', at: at(-OPERATOR_ANSWER_STALL_GRACE_MS + 1000), carriesAnswer: false }],
        }),
      ),
    ).toBeNull();
  });

  it('counts the grace from the idle session’s last state when that is later', () => {
    expect(answerStallEvidence(input({ idleSince: NOW - 1000 }))).toBeNull();
    expect(answerStallEvidence(input({ idleSince: NOW - OPERATOR_ANSWER_STALL_GRACE_MS }))).not.toBeNull();
  });

  it('is blocked by a working session, a permission and an open question', () => {
    expect(answerStallEvidence(input({ working: true }))).toBeNull();
    expect(answerStallEvidence(input({ permissionWaiting: true }))).toBeNull();
    expect(answerStallEvidence(input({ openQuestion: true }))).toBeNull();
    expect(answerStallEvidence(input({ waitingInput: true }))).toBeNull();
  });

  it('needs the evidence to be after the last proven step', () => {
    const evidenceAt = NOW - OPERATOR_ANSWER_STALL_GRACE_MS;
    expect(answerStallEvidence(input({ lastStepAt: evidenceAt }))).toBeNull();
    expect(answerStallEvidence(input({ lastStepAt: evidenceAt + 1 }))).toBeNull();
    expect(answerStallEvidence(input({ lastStepAt: evidenceAt - 1 }))).not.toBeNull();
  });

  it('takes the latest evidence', () => {
    const evidence = [
      { id: 'old', at: at(-600_000), carriesAnswer: false },
      { id: 'new', at: at(-300_000), carriesAnswer: false },
    ];
    expect(answerStallEvidence(input({ evidence }))).toMatchObject({ id: 'new' });
  });

  it('on a card with waiting-answer needs an answer, and counts the grace from it', () => {
    const plain = [{ id: 'msg_1', at: at(-OPERATOR_ANSWER_STALL_GRACE_MS), carriesAnswer: false }];
    const answer = [{ id: 'msg_2', at: at(-OPERATOR_ANSWER_STALL_GRACE_MS), carriesAnswer: true }];
    expect(answerStallEvidence(input({ labelled: true, evidence: plain }))).toBeNull();
    expect(answerStallEvidence(input({ labelled: true, evidence: answer }))).toMatchObject({ id: 'msg_2' });
    expect(answerStallEvidence(input({ labelled: true, evidence: answer, working: true }))).toBeNull();
    expect(
      answerStallEvidence(input({ labelled: true, evidence: answer, permissionWaiting: true })),
    ).toBeNull();
  });

  it('is null without evidence', () => {
    expect(answerStallEvidence(input({ evidence: [] }))).toBeNull();
  });
});
