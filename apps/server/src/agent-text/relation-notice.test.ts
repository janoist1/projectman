import { describe, expect, it } from 'vitest';
import { relationNoticeText } from '.';
import type { RelationNoticeRelation } from '.';

const other = (
  key: string,
  extra: Partial<RelationNoticeRelation['other']> = {},
): RelationNoticeRelation['other'] => ({
  key,
  title: `Title of ${key}`,
  stageId: 'dev',
  status: 'active',
  summary: '',
  visible: true,
  ...extra,
});

describe('relationNoticeText', () => {
  it('tells the relation from the card, the other card and its start, in a first line that is the whole news', () => {
    const text = relationNoticeText({
      cardKey: 'PM-1',
      actor: 'owner',
      check: false,
      relations: [{ kind: 'related', other: other('PM-2', { summary: 'Reset links by mail.' }) }],
    });
    const lines = text.split('\n');
    expect(lines[0]).toBe('Relation notice (PM-1): this card is related to PM-2 (added by owner).');
    expect(lines[0]!.length).toBeLessThanOrEqual(140);
    expect(lines[1]).toBe('- This card is related to: PM-2 "Title of PM-2" · Stage: dev · Status: active');
    expect(lines[2]).toBe('  Summary: Reset links by mail.');
    expect(text).not.toContain('Analyst');
    expect(text.endsWith('This message is from projectman: do not answer it with send_message.')).toBe(true);
  });

  it('lists every relation of one operation in one message', () => {
    const text = relationNoticeText({
      cardKey: 'PM-1',
      actor: 'dev-1',
      check: false,
      relations: [
        { kind: 'prerequisite', other: other('PM-2') },
        { kind: 'part_of', other: other('PM-3') },
      ],
    });
    expect(text.split('\n')[0]).toBe(
      'Relation notice (PM-1): this card needs first (prerequisite) PM-2, is part of PM-3 (added by dev-1).',
    );
    expect(text).toContain('- This card needs first (prerequisite): PM-2');
    expect(text).toContain('- This card is part of: PM-3');
  });

  it('gives only the key and the title of a card the recipient may not read', () => {
    const text = relationNoticeText({
      cardKey: 'PM-1',
      actor: 'owner',
      check: false,
      relations: [{ kind: 'related', other: other('PM-2', { visible: false, summary: 'Secret plans' }) }],
    });
    expect(text).toContain('- This card is related to: PM-2 "Title of PM-2"');
    expect(text).not.toContain('Stage');
    expect(text).not.toContain('Secret plans');
  });

  it('leaves the summary line out for a card without a description', () => {
    const text = relationNoticeText({
      cardKey: 'PM-1',
      actor: 'owner',
      check: false,
      relations: [{ kind: 'related', other: other('PM-2') }],
    });
    expect(text).not.toContain('Summary');
  });

  it('asks the analyst to check, note the result and leave the card where it is', () => {
    const text = relationNoticeText({
      cardKey: 'PM-1',
      actor: 'owner',
      check: true,
      relations: [{ kind: 'prerequisite_of', other: other('PM-2') }],
    });
    expect(text.split('\n')[0]).toBe(
      'Analyst check (PM-1): this card is the prerequisite of PM-2 (added by owner).',
    );
    expect(text).toContain('You are the analyst of this card');
    expect(text).toContain('update_task');
    expect(text).toContain('Do not move or stop the card.');
  });
});
