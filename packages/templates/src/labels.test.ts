import { describe, expect, it } from 'vitest';
import { standardLabelsFor } from './labels';
import { getLocale } from './locales';

describe('labels', () => {
  it('ships whole groups and "waiting for an answer" in the locale of the project', () => {
    const labels = standardLabelsFor(['qa-ok'], getLocale('hu'));
    expect(labels.map((l) => l.id)).toEqual(['qa-ok', 'qa-failed', 'qa-retest', 'waiting-answer']);
    expect(labels[1]).toMatchObject({ name: 'QA: hibás', requiresComment: true, notifyAssignee: true });
  });
});
