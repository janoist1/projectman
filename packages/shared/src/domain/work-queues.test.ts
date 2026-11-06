import { describe, expect, it } from 'vitest';
import { MEMBER_QUEUE_HOLD_CODES } from './member-queue';
import type { MemberQueueSource } from './member-queue';
import {
  WORK_QUEUE_LONG_WAIT_MS,
  canSeeWorkQueue,
  canSeeWorkQueueItem,
  canSeeWorkQueueItems,
  isWorkQueueLongWait,
  workQueueReasonOf,
  workQueueScopeOf,
} from './work-queues';
import type { WorkQueueRef } from './work-queues';

const member = (handle: string): WorkQueueRef => ({ type: 'member', member: handle });
const integrator: WorkQueueRef = { type: 'integrator' };
const isPm = (handle: string) => handle === 'pm';

describe('workQueueReasonOf', () => {
  it.each([
    ['ai_limit_reached', 'place'],
    ['plan_usage_paused', 'usage'],
    ['team_paused', 'paused'],
    ['waiting_answer', 'human'],
    ['disk_low', 'machine'],
    [MEMBER_QUEUE_HOLD_CODES.waiting_answer, 'human'],
    [MEMBER_QUEUE_HOLD_CODES.fix_limit, 'human'],
    [MEMBER_QUEUE_HOLD_CODES.handoff, 'machine'],
    [MEMBER_QUEUE_HOLD_CODES.unknown, 'unknown'],
  ])('classifies the known code %s as %s', (code, reason) => {
    expect(workQueueReasonOf({ code, wake: true, placeLive: false })).toBe(reason);
  });

  it('classifies a code it does not know as unknown, whatever the prototype holds', () => {
    expect(workQueueReasonOf({ code: 'something_new', wake: true, placeLive: true })).toBe('unknown');
    expect(workQueueReasonOf({ code: 'constructor', wake: true, placeLive: true })).toBe('unknown');
  });

  it.each([
    ['a live session in its place', { wake: true, placeLive: true }, 'next_session'],
    ['an item that does not wake anyone', { wake: false, placeLive: false }, 'next_session'],
    ['no cause at all', { wake: true, placeLive: false }, 'unknown'],
  ] as const)('classifies an item without a code by %s', (_name, input, reason) => {
    expect(workQueueReasonOf({ code: null, ...input })).toBe(reason);
  });
});

describe('isWorkQueueLongWait', () => {
  const queuedAt = '2026-11-06T10:00:00.000Z';
  const at = (ms: number) => Date.parse(queuedAt) + ms;

  it('is false before the threshold and true from it', () => {
    expect(isWorkQueueLongWait({ state: 'queued', queuedAt }, at(WORK_QUEUE_LONG_WAIT_MS - 1))).toBe(false);
    expect(isWorkQueueLongWait({ state: 'queued', queuedAt }, at(WORK_QUEUE_LONG_WAIT_MS))).toBe(true);
  });

  it('never counts an item being processed', () => {
    expect(isWorkQueueLongWait({ state: 'processing', queuedAt }, at(WORK_QUEUE_LONG_WAIT_MS * 10))).toBe(
      false,
    );
  });
});

describe('who reads which queue', () => {
  it.each([
    ['owner', 'all'],
    ['admin', 'all'],
    ['developer', 'project_manager'],
    ['client', null],
    ['viewer', null],
    ['ai', null],
  ] as const)('gives %s the scope %s', (access, scope) => {
    expect(workQueueScopeOf({ access })).toBe(scope);
  });

  it('lets the readers of every queue read each one, and a developer only the manager’s', () => {
    expect(canSeeWorkQueue({ access: 'admin' }, member('codex'), isPm)).toBe(true);
    expect(canSeeWorkQueue({ access: 'admin' }, integrator)).toBe(true);
    expect(canSeeWorkQueue({ access: 'developer' }, member('pm'), isPm)).toBe(true);
    expect(canSeeWorkQueue({ access: 'developer' }, member('codex'), isPm)).toBe(false);
    expect(canSeeWorkQueue({ access: 'developer' }, integrator, isPm)).toBe(false);
    expect(canSeeWorkQueue({ access: 'client' }, member('pm'), isPm)).toBe(false);
  });

  it('does not know the manager of a developer without the check', () => {
    expect(canSeeWorkQueue({ access: 'developer' }, member('pm'))).toBe(false);
  });

  it('shows the items of the integrator queue to the owner alone', () => {
    expect(canSeeWorkQueueItems({ access: 'owner' }, integrator)).toBe(true);
    expect(canSeeWorkQueueItems({ access: 'admin' }, integrator)).toBe(false);
    expect(canSeeWorkQueueItems({ access: 'developer' }, member('pm'))).toBe(true);
  });
});

describe('canSeeWorkQueueItem', () => {
  const dev = { access: 'developer', handle: 'dana' } as const;
  const admin = { access: 'admin', handle: 'ada' } as const;
  const source = (type: MemberQueueSource['type']): MemberQueueSource => {
    switch (type) {
      case 'message':
        return { type, messageId: 'msg_1' };
      case 'inbox':
        return { type, inboxItemId: 'inb_1' };
      case 'signal':
        return { type, signalId: 'sig_1', followUpAt: null };
      case 'fix_limit':
        return { type, taskKey: 'PM-1', heldAt: '2026-11-06T10:00:00.000Z' };
      case 'obligation':
        return { type, obligationId: 'obl_1' };
      case 'start':
        return { type, startKey: 'k' };
      case 'checklist':
        return { type, noticeId: 'chk_1' };
    }
  };

  it('lets a team message through to its parties and to who reads every message', () => {
    const item = { source: source('message') };
    expect(canSeeWorkQueueItem(dev, item, { message: { from: 'dana', to: ['pm'] } })).toBe(true);
    expect(canSeeWorkQueueItem(dev, item, { message: { from: 'owner', to: ['pm'] } })).toBe(false);
    expect(canSeeWorkQueueItem(admin, item, { message: { from: 'owner', to: ['pm'] } })).toBe(true);
  });

  it('hides a screening inbox item from a developer and shows it to an admin', () => {
    const item = { source: source('inbox') };
    const screening = { state: 'screening' as const, assignees: ['owner'], payload: {} };
    expect(canSeeWorkQueueItem(dev, item, { inbox: screening })).toBe(false);
    expect(canSeeWorkQueueItem(admin, item, { inbox: screening })).toBe(true);
    expect(canSeeWorkQueueItem(dev, item, { inbox: { ...screening, state: 'open' } })).toBe(true);
  });

  it.each(['message', 'inbox'] as const)(
    'shows a vanished %s source only to who reads every message',
    (type) => {
      expect(canSeeWorkQueueItem(dev, { source: source(type) }, {})).toBe(false);
      expect(canSeeWorkQueueItem(admin, { source: source(type) }, {})).toBe(true);
    },
  );

  it.each(['signal', 'checklist'] as const)('keeps a %s to who sees the Operator’s sessions', (type) => {
    expect(canSeeWorkQueueItem(dev, { source: source(type) }, {})).toBe(false);
    expect(canSeeWorkQueueItem(admin, { source: source(type) }, {})).toBe(true);
  });

  it.each(['fix_limit', 'start', 'obligation'] as const)('shows the card-level %s to everyone', (type) => {
    expect(canSeeWorkQueueItem(dev, { source: source(type) }, {})).toBe(true);
  });
});
