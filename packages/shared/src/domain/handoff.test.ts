import { describe, expect, it } from 'vitest';
import { handoffBlocksStart, planHandoff } from './handoff';
import type { HandoffFacts } from './handoff';

const ai = { kind: 'ai', provider: 'claude', onLeave: false } as const;
const resumable = { provider: 'claude', transcript: true } as const;

const plan = (facts: Partial<HandoffFacts>) => planHandoff({ from: ai, conversation: resumable, ...facts });

describe('planHandoff', () => {
  it('asks the old session when it can be resumed', () => {
    expect(plan({})).toEqual({ mode: 'live' });
  });

  it('has nothing to hand over when the old assignee never worked on the card', () => {
    expect(plan({ conversation: null })).toBeNull();
    expect(plan({ from: null, conversation: null })).toBeNull();
  });

  it('has nothing to ask of a person', () => {
    expect(plan({ from: { kind: 'human', provider: 'claude', onLeave: false } })).toBeNull();
  });

  it('falls back to the summary when the member left, is on leave or changed provider', () => {
    expect(plan({ from: null })).toEqual({ mode: 'fallback', reason: 'member_removed' });
    expect(plan({ from: { ...ai, onLeave: true } })).toEqual({ mode: 'fallback', reason: 'on_leave' });
    expect(plan({ from: { ...ai, provider: 'codex' } })).toEqual({
      mode: 'fallback',
      reason: 'provider_changed',
    });
  });

  it('falls back when the conversation has no transcript', () => {
    expect(plan({ conversation: { provider: 'claude', transcript: false } })).toEqual({
      mode: 'fallback',
      reason: 'no_conversation',
    });
  });

  it('names the leave before the provider, and a removed member before everything', () => {
    expect(plan({ from: { ...ai, onLeave: true, provider: 'codex' } })).toEqual({
      mode: 'fallback',
      reason: 'on_leave',
    });
    expect(plan({ from: null, conversation: { provider: 'codex', transcript: false } })).toEqual({
      mode: 'fallback',
      reason: 'member_removed',
    });
  });
});

describe('handoffBlocksStart', () => {
  it('holds back only the receiver of the open handoff', () => {
    expect(handoffBlocksStart({ to: 'dev-2' }, 'dev-2')).toBe(true);
    expect(handoffBlocksStart({ to: 'dev-2' }, 'dev-1')).toBe(false);
    expect(handoffBlocksStart({ to: null }, 'dev-2')).toBe(false);
    expect(handoffBlocksStart(undefined, 'dev-2')).toBe(false);
  });
});
