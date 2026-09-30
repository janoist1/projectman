import type { Session, Task } from '@projectman/shared';
import { describe, expect, it } from 'vitest';
import { primarySession } from './taskModel';

const task = { key: 'AC-1', assignee: 'dev-1' } as Task;
const session = (id: string, member: string, state: Session['state'], startedAt: string) =>
  ({ id, member, state, startedAt }) as Session;

describe('primarySession', () => {
  it('prefers the newest live session, e.g. the reviewer while the task is in review', () => {
    const dev = session('dev', 'dev-1', 'exited', '2026-09-30T08:00:00Z');
    const reviewer = session('cr', 'cr', 'idle', '2026-09-30T09:00:00Z');
    expect(primarySession(task, [dev, reviewer])?.id).toBe('cr');
  });

  it("falls back to the assignee's latest session when none is live", () => {
    const dev = session('dev', 'dev-1', 'exited', '2026-09-30T08:00:00Z');
    const reviewer = session('cr', 'cr', 'exited', '2026-09-30T09:00:00Z');
    expect(primarySession(task, [dev, reviewer])?.id).toBe('dev');
    expect(primarySession(task, [])).toBeNull();
  });
});
