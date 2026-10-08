import { describe, expect, it } from 'vitest';
import { formatTeamMessageBatch, splitTeamMessageBatch, userTextOrigin } from './chat';

describe('team message batch text', () => {
  it('carries current state, sent versions, obsolete reasons and complete message bodies', () => {
    const text = formatTeamMessageBatch(
      'AR-1',
      { stageId: 'review', stageName: 'Review', commit: 'ccccccc', labels: ['code-review-ok'] },
      [
        {
          from: 'dev',
          taskKey: 'AR-1',
          body: 'Old request\n\nDetails',
          kind: 'action',
          sentAt: '2026-10-05T21:30:00.000Z',
          version: { stageId: 'dev', commit: 'aaaaaaa', reviewCommit: null },
          stale: 'superseded',
        },
        { from: 'qa', taskKey: 'AR-1', body: 'Done.', kind: 'info', sentAt: '2026-10-05T21:31:00.000Z' },
      ],
    );
    expect(text).toContain('stage Review (review), commit ccccccc, labels: code-review-ok');
    expect(text).toContain('OUT OF DATE: dev sent a newer request');
    expect(text).toContain('2 messages waited for you. 1 is out of date');
    expect(text).toContain('version unknown');
    expect(userTextOrigin(text, 'brief')).toBe('team_message');
    const batch = splitTeamMessageBatch(text)!;
    expect(batch.items).toHaveLength(2);
    expect(batch.items[0]).toMatchObject({
      from: 'dev',
      taskKey: 'AR-1',
      body: expect.stringContaining('Old request\n\nDetails'),
    });
    expect(batch.items[1]).toMatchObject({ from: 'qa', body: expect.stringContaining('Done.') });
  });

  it('handles general conversations without a card and ignores ordinary messages', () => {
    const text = formatTeamMessageBatch(null, null, [
      { from: 'dev', taskKey: null, body: 'Hello', kind: 'action', sentAt: '2026-10-05T21:30:00.000Z' },
    ]);
    expect(text).toMatch(/^\[team messages\]\n/);
    expect(text).not.toContain('The card now');
    expect(text).toContain('1 message waited for you.');
    expect(text).not.toContain('do not act');
    expect(splitTeamMessageBatch(text)?.items[0]?.taskKey).toBeNull();
    expect(splitTeamMessageBatch('[team message from dev]\nHello')).toBeNull();
  });
});
