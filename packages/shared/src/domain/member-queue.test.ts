import { describe, expect, it } from 'vitest';
import { memberQueueSourceId, memberQueueSourceOf } from './member-queue';
import type { MemberQueueSource } from './member-queue';

describe('member queue source ids', () => {
  it.each<MemberQueueSource>([
    { type: 'message', messageId: 'msg_1' },
    { type: 'inbox', inboxItemId: 'inb_1' },
    { type: 'boundary', requestId: 'req_1' },
    { type: 'signal', signalId: 'sig_1', followUpAt: null },
    { type: 'signal', signalId: 'sig_1', followUpAt: '2026-10-18T10:00:00.000Z' },
    { type: 'fix_limit', taskKey: 'AR-1', heldAt: '2026-10-18T10:00:00.000Z' },
    { type: 'obligation', obligationId: 'obl_1' },
    { type: 'start', startKey: 'start:AR-1:dev-1' },
  ])('round-trips $type through its id', (source) => {
    expect(memberQueueSourceOf(source.type, memberQueueSourceId(source))).toEqual(source);
  });
});
