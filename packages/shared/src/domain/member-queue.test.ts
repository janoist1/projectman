import { describe, expect, it } from 'vitest';
import type { ProjectConfig } from '../config/schema';
import {
  memberQueueSourceId,
  memberQueueSourceOf,
  memberQueueUrgency,
  nominalMessagePlace,
} from './member-queue';
import type { MemberQueueSource } from './member-queue';

describe('member queue source ids', () => {
  it.each<MemberQueueSource>([
    { type: 'message', messageId: 'msg_1' },
    { type: 'inbox', inboxItemId: 'inb_1' },
    { type: 'signal', signalId: 'sig_1', followUpAt: null },
    { type: 'signal', signalId: 'sig_1', followUpAt: '2026-10-18T10:00:00.000Z' },
    { type: 'fix_limit', taskKey: 'AR-1', heldAt: '2026-10-18T10:00:00.000Z' },
    { type: 'obligation', obligationId: 'obl_1' },
    { type: 'start', startKey: 'start:AR-1:dev-1' },
    { type: 'checklist', noticeId: 'onboarding' },
    { type: 'checklist', noticeId: 'reopen:agreement@2026-10-23T10:00:00.000Z' },
  ])('round-trips $type through its id', (source) => {
    expect(memberQueueSourceOf(source.type, memberQueueSourceId(source))).toEqual(source);
  });
});

it('prioritizes checklist notices with starts', () => {
  expect(memberQueueUrgency('checklist')).toBe(3);
});

describe('nominalMessagePlace', () => {
  const human = (handle: string, access: string) => ({ kind: 'human', handle, displayName: handle, access });
  const ai = (handle: string, role: string) => ({ kind: 'ai', handle, displayName: handle, role });
  const config = {
    team: {
      members: [
        human('owner', 'owner'),
        human('cleo', 'client'),
        human('vera', 'viewer'),
        human('dana', 'developer'),
        ai('pm', 'project_manager'),
        ai('dev-1', 'developer'),
      ],
    },
  } as unknown as Pick<ProjectConfig, 'team'>;
  const task = { type: 'task', taskKey: 'AR-1' } as const;

  it.each(['cleo', 'vera', 'dana'])('gives the PM a conversation of its own with %s', (from) => {
    expect(nominalMessagePlace(config, 'pm', { type: 'general' }, from)).toEqual({
      type: 'general',
      with: from,
    });
    expect(nominalMessagePlace(config, 'pm', task, from)).toEqual({ type: 'general', with: from });
  });

  it('keeps the owner, an AI member and the system in the PM’s one general conversation', () => {
    for (const from of ['owner', 'dev-1', 'system'])
      expect(nominalMessagePlace(config, 'pm', task, from)).toEqual({ type: 'general' });
  });

  it('leaves a member without guest conversations at its own work item, whoever writes', () => {
    expect(nominalMessagePlace(config, 'dev-1', task, 'cleo')).toEqual(task);
    expect(nominalMessagePlace(config, 'pm', { type: 'meeting', meetingId: 'm1' }, 'cleo')).toEqual({
      type: 'meeting',
      meetingId: 'm1',
    });
  });
});
