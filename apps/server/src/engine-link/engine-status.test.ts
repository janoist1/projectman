import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEngineStatusWriter, createRunningTracker } from './engine-status';

describe('engine status writes', () => {
  let dir: string;
  let file: string;
  let writer: ReturnType<typeof createEngineStatusWriter>;
  beforeEach(() => {
    vi.useFakeTimers();
    dir = mkdtempSync(path.join(tmpdir(), 'pm-engine-status-'));
    file = path.join(dir, 'status.json');
    writer = createEngineStatusWriter(file, { pid: 1, bootId: 'boot' });
    writer.set({ running: [{ sessionId: 's1', state: 'idle' }] });
    writer.flush();
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes nothing for an equal patch with fresh nested objects', () => {
    const inode = statSync(file).ino;
    writer.set({ running: [{ state: 'idle', sessionId: 's1' }] });
    vi.advanceTimersByTime(500);
    expect(statSync(file).ino).toBe(inode);
  });

  it('writes a heartbeat at most once per interval', () => {
    const initial = readFileSync(file, 'utf8');
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(5000);
      writer.set({ running: [{ sessionId: 's1', state: 'idle' }] });
    }
    expect(readFileSync(file, 'utf8')).toBe(initial);
    vi.advanceTimersByTime(200);
    expect(readFileSync(file, 'utf8')).not.toBe(initial);
    const inode = statSync(file).ino;
    vi.advanceTimersByTime(29_000);
    writer.set({});
    vi.advanceTimersByTime(200);
    expect(statSync(file).ino).toBe(inode);
  });

  it('coalesces changes and flushes a final change immediately', () => {
    writer.set({ connection: 'connected' });
    writer.set({ attempts: 2 });
    vi.advanceTimersByTime(200);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ connection: 'connected', attempts: 2 });
    writer.set({ connection: 'stopped' });
    writer.flush();
    expect(JSON.parse(readFileSync(file, 'utf8')).connection).toBe('stopped');
    const inode = statSync(file).ino;
    vi.advanceTimersByTime(200);
    expect(statSync(file).ino).toBe(inode);
  });
});

describe('the running sessions of the engine status', () => {
  const now = () => new Date('2026-10-09T10:00:00Z');

  it('adds who runs a session to its row, and nothing else of the spec', () => {
    const tracker = createRunningTracker(now);
    tracker.started({ sessionId: 's1', member: 'dev', provider: 'claude', displayName: 'Dev · PM-1' });
    expect(tracker.decorate([{ sessionId: 's1', state: 'working' }])).toEqual([
      {
        sessionId: 's1',
        state: 'working',
        member: 'dev',
        provider: 'claude',
        label: 'Dev · PM-1',
        startedAt: '2026-10-09T10:00:00.000Z',
      },
    ]);
  });

  it('leaves the row of a session it was not told about as the runner reports it', () => {
    const tracker = createRunningTracker(now);
    expect(tracker.decorate([{ sessionId: 's2', state: 'idle' }])).toEqual([
      { sessionId: 's2', state: 'idle' },
    ]);
  });

  it('forgets a session when it exits, and one the runner no longer lists', () => {
    const tracker = createRunningTracker(now);
    tracker.started({ sessionId: 's1', displayName: 'a' });
    tracker.started({ sessionId: 's2', displayName: 'b' });
    tracker.exited('s1');
    expect(tracker.decorate([{ sessionId: 's2', state: 'idle' }])).toHaveLength(1);
    // s2 vanished without an exit event; a later session with its id starts without the old details.
    expect(tracker.decorate([])).toEqual([]);
    expect(tracker.decorate([{ sessionId: 's2', state: 'idle' }])).toEqual([
      { sessionId: 's2', state: 'idle' },
    ]);
  });
});
