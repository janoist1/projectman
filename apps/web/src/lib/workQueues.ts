import { MemberHandle } from '@projectman/shared';
import type { WorkQueueRef } from '@projectman/shared';

/** `member:<handle>` or `integrator`: a work queue as the URL and the query key name it (PM-1294). */
export function workQueueRefId(queue: WorkQueueRef): string {
  return queue.type === 'member' ? `member:${queue.member}` : 'integrator';
}

/** The queue a `workQueueRefId` names; a malformed value is null. */
export function parseWorkQueueRef(value: string | null): WorkQueueRef | null {
  if (value === 'integrator') return { type: 'integrator' };
  if (!value?.startsWith('member:')) return null;
  const handle = MemberHandle.safeParse(value.slice('member:'.length));
  return handle.success ? { type: 'member', member: handle.data } : null;
}

export function sameWorkQueue(a: WorkQueueRef, b: WorkQueueRef): boolean {
  return workQueueRefId(a) === workQueueRefId(b);
}
