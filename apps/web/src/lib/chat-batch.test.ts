import { describe, expect, it } from 'vitest';
import { formatTeamMessageBatch } from '@projectman/shared';
import { groupChatItems } from './chat';

describe('injected team batch chat', () => {
  it('renders the header as a note and preserves both messages and their metadata', () => {
    const text = formatTeamMessageBatch('AR-1', null, [
      {
        from: 'dev',
        taskKey: 'AR-1',
        body: 'Review A',
        kind: 'action',
        sentAt: '2026-10-05T21:30:00.000Z',
        stale: 'superseded',
      },
      { from: 'qa', taskKey: 'AR-1', body: 'Tests pass', kind: 'info', sentAt: '2026-10-05T21:31:00.000Z' },
    ]);
    const blocks = groupChatItems(
      [{ kind: 'user_text', id: 'u1', ts: '', text, origin: 'team_message' }],
      'cr',
    );
    expect(blocks).toMatchObject([
      { type: 'note', id: 'u1' },
      {
        type: 'team',
        id: 'u1#0',
        item: { from: 'dev', to: ['cr'], text: expect.stringContaining('OUT OF DATE') },
      },
      { type: 'team', id: 'u1#1', item: { from: 'qa', text: expect.stringContaining('Tests pass') } },
    ]);
  });
});
