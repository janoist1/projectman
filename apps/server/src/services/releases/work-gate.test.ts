import { describe, expect, it } from 'vitest';
import { ReleaseWorkGate } from './work-gate';

describe('release work gate', () => {
  it('hands out permits while the fence is down and counts the roots that hold one', () => {
    const gate = new ReleaseWorkGate(() => false);
    const merge = gate.tryAcquire('merge', 'm1');
    const write = gate.tryAcquire('document_write', 'd1');
    expect(merge && write).toBeTruthy();
    expect(gate.counts()).toEqual({ merges: 1, documentWrites: 1, fullTests: 0, screenshots: 0 });
    merge!.release();
    expect(gate.counts().merges).toBe(0);
    // Releasing twice changes nothing.
    merge!.release();
    expect(gate.counts().documentWrites).toBe(1);
  });

  it('refuses a new root while the fence is up and reads the fence at every question', () => {
    const fence = { up: false };
    const gate = new ReleaseWorkGate(() => fence.up);
    const first = gate.tryAcquire('full_test', 'f1');
    fence.up = true;
    expect(gate.isHeld()).toBe(true);
    expect(gate.tryAcquire('full_test', 'f2')).toBeNull();
    expect(gate.tryAcquire('screenshot', 's1')).toBeNull();
    // Work that started before the fence is still counted until it ends.
    expect(gate.counts().fullTests).toBe(1);
    first!.release();
    fence.up = false;
    expect(gate.counts().fullTests).toBe(0);
    expect(gate.tryAcquire('full_test', 'f2')).not.toBeNull();
  });

  it('lets the continuation of held work through the fence, and counts the root until the child ends', () => {
    const fence = { up: false };
    const gate = new ReleaseWorkGate(() => fence.up);
    const root = gate.tryAcquire('merge', 'm1')!;
    fence.up = true;
    const child = gate.tryAcquire('full_test', 'check', root);
    expect(child).not.toBeNull();
    // The root's own work is over, but its child is not: the merge is still pending.
    root.release();
    expect(gate.counts()).toEqual({ merges: 1, documentWrites: 0, fullTests: 0, screenshots: 0 });
    child!.release();
    expect(gate.counts().merges).toBe(0);
  });

  it('does not let a released root hand out a continuation under the fence', () => {
    const fence = { up: true };
    const gate = new ReleaseWorkGate(() => fence.up);
    fence.up = false;
    const root = gate.tryAcquire('merge', 'm1')!;
    root.release();
    fence.up = true;
    expect(gate.tryAcquire('full_test', 'check', root)).toBeNull();
  });
});
