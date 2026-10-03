import type { PauseRequest, PausedSession, PauseStatus } from '@projectman/shared';
import type { ControlLog, ControlPause } from '../../src/control';

export const pausedSession = (over: Partial<PausedSession> = {}): PausedSession => ({
  sessionId: 'ses_1',
  projectKey: 'AR',
  member: 'dev',
  workItem: { type: 'task', taskKey: 'AR-1' },
  since: '2026-01-01T00:00:00.000Z',
  point: null,
  tool: null,
  waitingFor: 'Bash',
  pausedAt: null,
  stopped: false,
  ...over,
});

export const pauseStatus = (sessions: PausedSession[], over: Partial<PauseStatus> = {}): PauseStatus => ({
  id: 'pau_1',
  scope: 'instance',
  projectKey: null,
  kind: 'manual',
  state: sessions.every((s) => s.point !== null) ? 'paused' : 'pausing',
  source: 'control',
  requestedBy: null,
  requestedAt: '2026-01-01T00:00:00.000Z',
  reason: null,
  forceAt: '2026-01-01T00:05:00.000Z',
  sessions,
  ...over,
});

/** A pause that answers from a script, and remembers what it was asked. */
export class ScriptedPause implements ControlPause {
  requests: string[] = [];
  pauseRequests: PauseRequest[] = [];
  current: PauseStatus | null = null;
  /** What `status` shows on its successive calls; the last one stays. */
  polls: (PauseStatus | null)[] = [];

  async pause(request: PauseRequest) {
    this.requests.push('pause');
    this.pauseRequests.push(request);
    return this.current;
  }
  async resume() {
    this.requests.push('resume');
    this.current = null;
    return null;
  }
  async force() {
    this.requests.push('force');
    return this.current;
  }
  status() {
    this.requests.push('status');
    if (this.polls.length > 1) return this.polls.shift()!;
    return this.polls.length === 1 ? this.polls[0]! : this.current;
  }
}

/** A log that keeps "level: message" lines. */
export const recordingLog = (): ControlLog & { lines: string[] } => {
  const lines: string[] = [];
  const add = (level: string) => (_obj: object, msg: string) => {
    lines.push(`${level}: ${msg}`);
  };
  return { lines, info: add('info'), warn: add('warn'), error: add('error') };
};
