import { describe, expect, it } from 'vitest';
import type { MachineView, Session } from '@projectman/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { MachineProbe, MachineSnapshot, ProcessRecord, RunningSessionInfo } from '../src/contracts';
import { MachineMonitor } from '../src/domain';

const MB = 1024 * 1024;
const T0 = Date.parse('2026-10-04T10:00:00Z');
const NOW0 = T0 + 3_600_000;
const TAG = 'tag1';
const SERVER_PID = 100;
const MY_UID = 501;

/* ---------- fakes ---------- */

/** A clock whose timers fire when the test moves it on. */
class Clock {
  t = NOW0;
  private timers: Array<{ at: number; run: () => void; live: boolean }> = [];
  now = (): Date => new Date(this.t);
  setTimer = (run: () => void, ms: number): (() => void) => {
    const timer = { at: this.t + ms, run, live: true };
    this.timers.push(timer);
    return () => {
      timer.live = false;
    };
  };
  sleep = async (ms: number): Promise<void> => {
    this.t += ms;
  };
  get pending(): number {
    return this.timers.filter((timer) => timer.live).length;
  }
  async advance(ms: number): Promise<void> {
    this.t += ms;
    for (const timer of [...this.timers]) {
      if (timer.live && timer.at <= this.t) {
        timer.live = false;
        timer.run();
      }
    }
    await settle();
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

interface FakeProbe extends MachineProbe {
  list: ProcessRecord[] | null;
  env: Map<number, Record<string, string>>;
  snapshot: MachineSnapshot;
  cpuReadings: Array<{ busyMs: number; totalMs: number }>;
  signals: Array<{ pid: number; signal: string }>;
  calls: { machine: number; processes: number; envValues: number };
  /** The next `processes()` call waits for it. */
  gate: Promise<void> | null;
  /** What a signal does; the default removes the process. */
  onSignal: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => 'sent' | 'gone' | 'denied';
}

function makeProbe(): FakeProbe {
  const probe: FakeProbe = {
    list: [],
    env: new Map(),
    snapshot: {
      cpu: null,
      cores: 4,
      memoryUsedBytes: 2048 * MB,
      memoryTotalBytes: 16 * 1024 * MB,
      memoryPressure: 'normal',
      swapUsedBytes: 0,
      swapTotalBytes: 0,
    },
    cpuReadings: [
      { busyMs: 0, totalMs: 1000 },
      { busyMs: 500, totalMs: 2000 },
    ],
    signals: [],
    calls: { machine: 0, processes: 0, envValues: 0 },
    gate: null,
    onSignal: (pid) => {
      probe.list = probe.list?.filter((record) => record.pid !== pid) ?? null;
      return 'sent';
    },
    async machine() {
      probe.calls.machine++;
      const cpu = probe.cpuReadings.length > 1 ? probe.cpuReadings.shift()! : (probe.cpuReadings[0] ?? null);
      return { ...probe.snapshot, cpu };
    },
    async processes() {
      probe.calls.processes++;
      if (probe.gate) {
        const gate = probe.gate;
        probe.gate = null;
        await gate;
      }
      return probe.list ? [...probe.list] : null;
    },
    async envValues(pids) {
      probe.calls.envValues++;
      const found = new Map<number, Record<string, string>>();
      for (const pid of pids) {
        const values = probe.env.get(pid);
        if (values) found.set(pid, values);
      }
      return found;
    },
    signal(pid, signal) {
      probe.signals.push({ pid, signal });
      return probe.onSignal(pid, signal);
    },
  };
  return probe;
}

function proc(pid: number, ppid: number, args: string, over: Partial<ProcessRecord> = {}): ProcessRecord {
  return {
    pid,
    ppid,
    uid: MY_UID,
    rssBytes: 100 * MB,
    cpuSeconds: 0,
    cpuPercent: 0,
    startedAt: T0,
    args,
    ...over,
  };
}

const mark = (sessionId: string, tag = TAG): Record<string, string> => ({
  PROJECTMAN_SESSION_ID: sessionId,
  PROJECTMAN_INSTANCE: tag,
});

const INIT = proc(1, 0, '/sbin/launchd', { uid: 0 });
const SERVER = proc(SERVER_PID, 1, 'node /srv/projectman/server.js');

function session(id: string, over: Partial<Session> = {}): Session {
  return {
    id,
    projectKey: 'PM',
    member: 'dev',
    workItem: { type: 'task', taskKey: 'PM-1' },
    claudeSessionId: '0b7c6a1e-8f7b-4c1e-9d55-0d8c0f4e7a11',
    provider: 'claude',
    cwd: '/tmp/work',
    branch: null,
    transcriptPath: null,
    state: 'idle',
    activity: null,
    startedAt: '2026-10-04T10:00:00.000Z',
    lastActivityAt: '2026-10-04T10:05:00.000Z',
    endedAt: null,
    ...over,
  };
}

function info(
  sessionId: string,
  pid: number,
  state: RunningSessionInfo['state'] = 'idle',
): RunningSessionInfo {
  return { sessionId, pid, state, cols: 80, rows: 24 };
}

interface Logs {
  info: unknown[][];
  warn: unknown[][];
}

function world(options: { instanceTag?: string | undefined } = {}) {
  const clock = new Clock();
  const probe = makeProbe();
  probe.list = [INIT, SERVER];
  const sessions = new Map<string, Session>();
  const running: RunningSessionInfo[] = [];
  const logs: Logs = { info: [], warn: [] };
  const logger = {
    info: (...args: unknown[]) => logs.info.push(args),
    warn: (...args: unknown[]) => logs.warn.push(args),
    error: (...args: unknown[]) => logs.warn.push(args),
    debug: () => undefined,
    child: () => logger,
  } as unknown as FastifyBaseLogger;
  const state = { resumable: 0, memberOf: true };
  const monitor = new MachineMonitor({
    probe,
    runner: { list: () => running },
    sessions: { get: (id) => sessions.get(id) ?? null, countResumable: () => state.resumable },
    tasks: { get: (key) => ({ title: `Title of ${key}` }) },
    memberOf: async (_project, handle) =>
      state.memberOf
        ? { handle, displayName: `Member ${handle}`, kind: 'ai', role: 'dev', specialty: null }
        : null,
    instanceTag: 'instanceTag' in options ? options.instanceTag : TAG,
    serverPid: SERVER_PID,
    serverUid: MY_UID,
    logger,
    now: clock.now,
    setTimer: clock.setTimer,
    sleep: clock.sleep,
  });
  const add = (...records: ProcessRecord[]) => probe.list!.push(...records);
  return { clock, probe, sessions, running, logs, monitor, state, add };
}

const orphanNames = (view: MachineView): string[] => (view.orphans ?? []).map((row) => row.name);

/* ---------- classification ---------- */

describe('the rows of the running sessions', () => {
  it('count the live tree and the child that left it, and take the summary from the machine', async () => {
    const w = world();
    w.sessions.set('ses_a', session('ses_a', { state: 'working' }));
    w.running.push(info('ses_a', 200, 'working'));
    w.add(
      proc(200, 1, 'claude', { rssBytes: 300 * MB, cpuPercent: 40 }),
      proc(201, 200, 'node /w/node_modules/.bin/vitest run', { rssBytes: 700 * MB }),
      proc(202, 201, 'node worker.js', { rssBytes: 200 * MB }),
      // Started after the CLI and left its tree: still the session's.
      proc(300, 1, 'sleep 600', { startedAt: T0 + 1000, rssBytes: 50 * MB }),
      proc(400, 1, '/Applications/Slack.app/Contents/MacOS/Slack'),
    );
    w.probe.env.set(300, mark('ses_a'));

    const view = await w.monitor.view({ panel: false });

    expect(view.orphans).toEqual([]);
    expect(view.sessions).toHaveLength(1);
    const row = view.sessions[0]!;
    expect(row).toMatchObject({
      sessionId: 'ses_a',
      projectKey: 'PM',
      memberHandle: 'dev',
      member: { handle: 'dev', displayName: 'Member dev' },
      taskTitle: 'Title of PM-1',
      state: 'working',
      paused: false,
      pid: 200,
      processStartedAt: new Date(T0).toISOString(),
      processCount: 4,
      memoryBytes: 1250 * MB,
    });
    expect(row.top).toHaveLength(4);
    expect(row.top[0]).toMatchObject({ pid: 201, name: 'vitest', memoryBytes: 700 * MB });
    expect(view.summary).toMatchObject({
      sessionsRunning: 1,
      sessionsWorking: 1,
      cores: 4,
      memoryPressure: 'normal',
    });
    expect(view.sampledAt).toBe(new Date(w.clock.t).toISOString());
  });

  it('are empty of numbers when the CLI is not in the process list, and when the pid is unknown', async () => {
    const w = world();
    w.sessions.set('ses_a', session('ses_a'));
    w.sessions.set('ses_b', session('ses_b', { workItem: { type: 'general' } }));
    w.running.push(info('ses_a', 999), info('ses_b', 0));
    const view = await w.monitor.view({ panel: false });
    expect(view.sessions).toHaveLength(2);
    for (const row of view.sessions)
      expect(row).toMatchObject({
        cpuPercent: null,
        memoryBytes: null,
        processCount: null,
        top: [],
        processStartedAt: null,
      });
    expect(view.sessions.find((row) => row.sessionId === 'ses_b')).toMatchObject({
      pid: null,
      taskTitle: null,
    });
  });

  it('name no member that is gone from the configuration', async () => {
    const w = world();
    w.state.memberOf = false;
    w.sessions.set('ses_a', session('ses_a'));
    w.running.push(info('ses_a', 200));
    w.add(proc(200, 1, 'claude'));
    expect((await w.monitor.view({ panel: false })).sessions[0]).toMatchObject({
      member: null,
      memberHandle: 'dev',
    });
  });

  it('count the working sessions apart from the running ones', async () => {
    const w = world();
    for (const [id, state] of [
      ['ses_a', 'starting'],
      ['ses_b', 'working'],
      ['ses_c', 'idle'],
      ['ses_d', 'waiting_input'],
    ] as const) {
      w.sessions.set(id, session(id, { state }));
      w.running.push(info(id, 0, state));
    }
    expect((await w.monitor.view({ panel: false })).summary).toMatchObject({
      sessionsRunning: 4,
      sessionsWorking: 2,
    });
  });
});

describe('orphan processes', () => {
  it('are what a session that does not run left behind, with the processes below it and where they came from', async () => {
    const w = world();
    w.sessions.set('ses_b', session('ses_b', { state: 'exited', endedAt: '2026-10-04T10:30:00.000Z' }));
    w.add(
      proc(310, 1, 'node /old/node_modules/vite/bin/vite.js --port 5174', {
        rssBytes: 400 * MB,
        startedAt: T0 + 5,
      }),
      proc(311, 310, 'esbuild --service', { rssBytes: 100 * MB }),
    );
    w.probe.env.set(310, mark('ses_b'));

    const view = await w.monitor.view({ panel: false });

    expect(view.orphans).toEqual([
      {
        pid: 310,
        startedAt: new Date(T0 + 5).toISOString(),
        name: 'vite',
        command: 'node /old/node_modules/vite/bin/vite.js --port 5174',
        cpuPercent: 0,
        memoryBytes: 500 * MB,
        processCount: 2,
        origin: {
          sessionId: 'ses_b',
          projectKey: 'PM',
          memberHandle: 'dev',
          member: expect.objectContaining({ handle: 'dev' }),
          workItem: { type: 'task', taskKey: 'PM-1' },
          taskTitle: 'Title of PM-1',
          endedAt: '2026-10-04T10:30:00.000Z',
        },
      },
    ]);
  });

  it('have no origin when the session row is gone, and the command line is cut at 160 characters', async () => {
    const w = world();
    const long = `node /old/server.js ${'x'.repeat(300)}`;
    w.add(proc(310, 1, long));
    w.probe.env.set(310, mark('ses_gone'));
    const row = (await w.monitor.view({ panel: false })).orphans![0]!;
    expect(row.origin).toBeNull();
    expect(row.command).toBe(long.slice(0, 160));
  });

  it('include what an earlier run of a session that runs again left behind', async () => {
    const w = world();
    w.sessions.set('ses_a', session('ses_a'));
    w.running.push(info('ses_a', 200));
    w.add(
      proc(200, 1, 'claude'),
      proc(320, 1, 'node /old/run.js', { startedAt: T0 - 5000 }),
      // Started with the CLI: the session's own.
      proc(321, 1, 'node /new/run.js', { startedAt: T0 }),
    );
    w.probe.env.set(320, mark('ses_a'));
    w.probe.env.set(321, mark('ses_a'));
    const view = await w.monitor.view({ panel: false });
    expect(view.orphans!.map((row) => row.pid)).toEqual([320]);
    expect(view.sessions[0]!.processCount).toBe(2);
  });

  it('are never a process of a running session whose CLI cannot be found', async () => {
    const w = world();
    w.sessions.set('ses_a', session('ses_a'));
    w.running.push(info('ses_a', 999));
    w.add(proc(320, 1, 'node /old/run.js', { startedAt: T0 - 5000 }));
    w.probe.env.set(320, mark('ses_a'));
    expect((await w.monitor.view({ panel: false })).orphans).toEqual([]);
  });

  it('are never a process of another instance, without a marker, with a bad marker or of another user', async () => {
    const w = world();
    w.sessions.set('ses_b', session('ses_b', { state: 'exited' }));
    const heavy = { rssBytes: 600 * MB };
    w.add(
      proc(330, 1, '/usr/bin/foreign-a', heavy),
      proc(331, 1, '/usr/bin/foreign-b', heavy),
      proc(332, 1, '/usr/bin/foreign-c', heavy),
      proc(333, 1, '/usr/bin/foreign-d', { ...heavy, uid: 502 }),
      proc(334, 1, '/usr/bin/foreign-e', heavy),
    );
    w.probe.env.set(330, mark('ses_b', 'another-instance'));
    // 331: its environment cannot be read.
    w.probe.env.set(332, { PROJECTMAN_SESSION_ID: 'abc', PROJECTMAN_INSTANCE: TAG });
    w.probe.env.set(333, mark('ses_b'));
    w.probe.env.set(334, { PROJECTMAN_SESSION_ID: 'ses_b' });

    const view = await w.monitor.view({ panel: false });

    expect(view.orphans).toEqual([]);
    expect(view.others!.map((row) => row.name)).toEqual(
      expect.arrayContaining(['foreign-a', 'foreign-b', 'foreign-c', 'foreign-d', 'foreign-e']),
    );
  });

  it('are none at all for an instance without a tag', async () => {
    const w = world({ instanceTag: undefined });
    w.add(proc(310, 1, 'node /old/run.js'));
    w.probe.env.set(310, mark('ses_b'));
    expect((await w.monitor.view({ panel: false })).orphans).toEqual([]);
    expect(w.probe.calls.envValues).toBe(0);
  });

  it('are not the server, its ancestors or the processes below it', async () => {
    const w = world();
    // The server runs below a shell that a terminal started: the shell is an ancestor.
    w.probe.list = [
      INIT,
      proc(50, 1, '-zsh'),
      proc(SERVER_PID, 50, 'node /srv/projectman/server.js'),
      proc(101, SERVER_PID, 'git status'),
    ];
    for (const pid of [50, SERVER_PID, 101]) w.probe.env.set(pid, mark('ses_b'));
    const view = await w.monitor.view({ panel: false });
    expect(view.orphans).toEqual([]);
    expect(view.others![0]).toMatchObject({ kind: 'server', name: 'projectman', processCount: 2 });
  });

  it('are looked up once: the environment of a process is cached', async () => {
    const w = world();
    w.add(proc(310, 1, 'node /old/run.js'));
    w.probe.env.set(310, mark('ses_b'));
    await w.monitor.view({ panel: false });
    w.clock.t += 60_000; // the sample is old: measured again
    await w.monitor.view({ panel: false });
    expect(w.probe.calls.processes).toBe(2);
    expect(w.probe.calls.envValues).toBe(1);
  });

  it('are looked up again when the environment of a process of ours could not be read, not when it is another user', async () => {
    const w = world();
    w.sessions.set('ses_b', session('ses_b', { state: 'exited' }));
    w.add(
      proc(310, 1, 'node /old/run.js'),
      proc(320, 1, '/usr/bin/other-user', { uid: 502, startedAt: T0 + 1 }),
    );
    // `ps` gave no answer for 310 (a timeout): no marker is cached for it.
    expect(orphanNames(await w.monitor.view({ panel: false }))).toEqual([]);
    expect(w.probe.calls.envValues).toBe(1);
    w.probe.env.set(310, mark('ses_b'));
    w.clock.t += 60_000;
    expect(orphanNames(await w.monitor.view({ panel: false }))).toEqual(['run']);
    // 310 was asked for again; 320 (not ours) was not.
    expect(w.probe.calls.envValues).toBe(2);
    w.clock.t += 60_000;
    await w.monitor.view({ panel: false });
    expect(w.probe.calls.envValues).toBe(2);
  });
});

describe('the other processes', () => {
  it('are grouped by short name and shown only when they use enough', async () => {
    const w = world();
    w.add(
      proc(500, 1, '/usr/bin/quiet', { rssBytes: 400 * MB, cpuPercent: 4 * 4 }),
      proc(501, 1, '/usr/bin/big-a', { rssBytes: 300 * MB }),
      proc(502, 1, '/usr/bin/big-a', { rssBytes: 300 * MB }),
      // 5% of the machine (4 cores): 20% of one core.
      proc(503, 1, '/usr/bin/busy', { rssBytes: 10 * MB, cpuPercent: 20 }),
    );
    const view = await w.monitor.view({ panel: false });
    const names = view.others!.map((row) => row.name);
    expect(names).toContain('big-a');
    expect(names).toContain('busy');
    expect(names).not.toContain('quiet');
    expect(view.others!.find((row) => row.name === 'big-a')).toMatchObject({
      kind: 'process',
      processCount: 2,
      memoryBytes: 600 * MB,
    });
  });

  it('are at most eight rows, the largest memory first, after the server', async () => {
    const w = world();
    for (let i = 0; i < 10; i++) w.add(proc(600 + i, 1, `/usr/bin/tool-${i}`, { rssBytes: (600 + i) * MB }));
    const view = await w.monitor.view({ panel: false });
    expect(view.others).toHaveLength(9);
    expect(view.others![0]!.kind).toBe('server');
    expect(view.others![1]).toMatchObject({ name: 'tool-9' });
    expect(view.others![8]).toMatchObject({ name: 'tool-2' });
  });
});

/* ---------- numbers ---------- */

describe('the numbers', () => {
  it('give the load of the whole machine, the share of each row and what is left over', async () => {
    const w = world();
    w.sessions.set('ses_a', session('ses_a'));
    w.running.push(info('ses_a', 200));
    w.add(proc(200, 1, 'claude', { cpuPercent: 40 }));
    const view = await w.monitor.view({ panel: false });
    // The first round reads the processor twice, half a second apart: 500 of 1000 ms.
    expect(view.summary.cpuPercent).toBe(50);
    // `ps` says 40% of one core: 10% of four cores.
    expect(view.sessions[0]!.cpuPercent).toBe(10);
    expect(view.rest).toEqual({ cpuPercent: 40, memoryBytes: 2048 * MB - 200 * MB });
  });

  it('measure the later rounds from the processor time the processes used between them', async () => {
    const w = world();
    w.sessions.set('ses_a', session('ses_a'));
    w.running.push(info('ses_a', 200));
    w.add(proc(200, 1, 'claude', { cpuSeconds: 100, cpuPercent: 99 }));
    await w.monitor.view({ panel: false });
    w.probe.list = w.probe.list!.map((record) =>
      record.pid === 200 ? { ...record, cpuSeconds: 110 } : record,
    );
    await w.clock.advance(15_000);
    const view = await w.monitor.view({ panel: false });
    // 10 s of processor time in 15 s over 4 cores.
    expect(view.sessions[0]!.cpuPercent).toBeCloseTo(16.7, 1);
  });

  it('never let the rest go below zero', async () => {
    const w = world();
    w.probe.snapshot.memoryUsedBytes = 50 * MB;
    expect((await w.monitor.view({ panel: false })).rest!.memoryBytes).toBe(0);
  });

  it('are unknown without a process list, and the rows keep what is known', async () => {
    const w = world();
    w.probe.list = null;
    w.sessions.set('ses_a', session('ses_a'));
    w.running.push(info('ses_a', 200));
    const view = await w.monitor.view({ panel: false });
    expect(view.orphans).toBeNull();
    expect(view.others).toBeNull();
    expect(view.rest).toBeNull();
    expect(view.sessions[0]).toMatchObject({ processCount: null, top: [] });
    expect(view.summary.memoryUsedBytes).toBe(2048 * MB);
  });

  it('count the closed sessions at most every thirty seconds', async () => {
    const w = world();
    w.state.resumable = 3;
    const view = await w.monitor.view({ panel: false });
    expect(view.closedSessions).toBe(3);
    w.state.resumable = 4;
    await w.clock.advance(15_000); // a new round, the count is not older than 30 s
    expect((await w.monitor.view({ panel: false })).closedSessions).toBe(3);
    await w.clock.advance(15_000);
    expect((await w.monitor.view({ panel: false })).closedSessions).toBe(4);
  });
});

/* ---------- when it measures ---------- */

describe('how often it measures', () => {
  it('measures nothing while nobody asks', () => {
    const w = world();
    expect(w.probe.calls.processes).toBe(0);
    expect(w.clock.pending).toBe(0);
  });

  it('measures every 15 seconds while anything asks, and stops 45 seconds after the last request', async () => {
    const w = world();
    const first = await w.monitor.view({ panel: false });
    expect(first.intervalMs).toBe(15_000);
    expect(w.probe.calls.processes).toBe(1);
    await w.clock.advance(15_000);
    expect(w.probe.calls.processes).toBe(2);
    await w.clock.advance(15_000);
    expect(w.probe.calls.processes).toBe(3);
    // 45 s and more after the request (the first round's half second included): no round, and no timer left.
    await w.clock.advance(15_000);
    expect(w.probe.calls.processes).toBe(3);
    expect(w.clock.pending).toBe(0);
  });

  it('measures every 5 seconds while a panel asks, then every 15 seconds', async () => {
    const w = world();
    const first = await w.monitor.view({ panel: true });
    expect(first.intervalMs).toBe(5000);
    for (let i = 2; i <= 4; i++) {
      await w.clock.advance(5000);
      expect(w.probe.calls.processes).toBe(i);
    }
    // The panel asked 15 s ago and no more: the rounds come every 15 s now.
    await w.clock.advance(5000);
    expect(w.probe.calls.processes).toBe(4);
    await w.clock.advance(5000);
    expect(w.probe.calls.processes).toBe(4);
    await w.clock.advance(5000);
    expect(w.probe.calls.processes).toBe(5);
  });

  it('starts again with the next request after it has stopped', async () => {
    const w = world();
    await w.monitor.view({ panel: false });
    await w.clock.advance(60_000);
    const rounds = w.probe.calls.processes;
    const view = await w.monitor.view({ panel: false });
    expect(w.probe.calls.processes).toBe(rounds + 1);
    expect(view.sampledAt).toBe(new Date(w.clock.t).toISOString());
    expect(w.clock.pending).toBe(1);
  });

  it('shares one round between the requests that come together', async () => {
    const w = world();
    const views = await Promise.all(Array.from({ length: 6 }, () => w.monitor.view({ panel: false })));
    expect(w.probe.calls.processes).toBe(1);
    expect(new Set(views.map((view) => view.sampledAt)).size).toBe(1);
  });

  it('answers from the sample while it is fresh, and measures again when it is older than two intervals', async () => {
    const w = world();
    await w.monitor.view({ panel: false });
    w.clock.t += 29_000;
    await w.monitor.view({ panel: false });
    expect(w.probe.calls.processes).toBe(1);
    w.clock.t += 2000;
    await w.monitor.view({ panel: false });
    expect(w.probe.calls.processes).toBe(2);
  });

  it('does not wait longer than three seconds for a round', async () => {
    const w = world();
    w.probe.gate = new Promise(() => undefined);
    const started = Date.now();
    const view = await w.monitor.view({ panel: false });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(view.sampledAt).toBeNull();
    expect(view.summary.sessionsRunning).toBe(0);
  }, 10_000);

  it('stops measuring when the server stops', async () => {
    const w = world();
    await w.monitor.view({ panel: true });
    await w.monitor.stop();
    expect(w.clock.pending).toBe(0);
    await w.clock.advance(60_000);
    expect(w.probe.calls.processes).toBe(1);
  });

  it('survives a probe that throws', async () => {
    const w = world();
    w.probe.processes = async () => {
      throw new Error('ps went away');
    };
    const view = await w.monitor.view({ panel: false });
    expect(view.sampledAt).toBeNull();
    expect(w.logs.warn).toHaveLength(1);
  });
});

/* ---------- stopping orphans ---------- */

describe('stopping orphans', () => {
  function withOrphan() {
    const w = world();
    w.sessions.set('ses_b', session('ses_b', { state: 'exited' }));
    w.add(
      proc(310, 1, 'node /old/server.js --token SECRET-TOKEN', { startedAt: T0 + 7 }),
      proc(311, 310, 'esbuild'),
      proc(312, 310, 'helper-of-another-user', { uid: 502 }),
    );
    w.probe.env.set(310, mark('ses_b'));
    const item = (pid: number, startedAt = T0 + 7) => ({ pid, startedAt: new Date(startedAt).toISOString() });
    return { w, item };
  }

  it('sends SIGTERM to the root and to its own processes below it, and reports stopped', async () => {
    const { w, item } = withOrphan();
    const results = await w.monitor.stopOrphans([item(310)], 'usr_1');
    expect(results).toEqual([{ ...item(310), outcome: 'stopped' }]);
    expect(w.probe.signals).toEqual([
      { pid: 310, signal: 'SIGTERM' },
      { pid: 311, signal: 'SIGTERM' },
    ]);
  });

  it('takes a stopped orphan out of the last sample at once, without a new round', async () => {
    const { w, item } = withOrphan();
    expect((await w.monitor.view({ panel: true })).orphans!.map((row) => row.pid)).toEqual([310]);
    const rounds = w.probe.calls.machine;
    await w.monitor.stopOrphans([item(310)], 'usr_1');
    expect((await w.monitor.view({ panel: true })).orphans).toEqual([]);
    expect(w.probe.calls.machine).toBe(rounds);
  });

  it('logs who stopped what and for which session, never the command line', async () => {
    const { w, item } = withOrphan();
    await w.monitor.stopOrphans([item(310)], 'usr_1');
    expect(w.logs.info).toHaveLength(1);
    const logged = JSON.stringify(w.logs.info);
    expect(logged).toContain('usr_1');
    expect(logged).toContain('ses_b');
    expect(logged).toContain('"pid":310');
    expect(logged).not.toContain('SECRET-TOKEN');
    expect(logged).not.toContain('/old/server.js');
  });

  it('reports gone for a process that is not there any more or is another one with the same pid', async () => {
    const { w, item } = withOrphan();
    const results = await w.monitor.stopOrphans([item(999), item(310, T0 + 99)], 'usr_1');
    expect(results.map((result) => result.outcome)).toEqual(['gone', 'gone']);
    expect(w.probe.signals).toEqual([]);
  });

  it('refuses what is not an orphan of this instance: a live session, the server, a foreign or unmarked process', async () => {
    const { w, item } = withOrphan();
    w.sessions.set('ses_a', session('ses_a'));
    w.running.push(info('ses_a', 200));
    w.add(
      proc(200, 1, 'claude'),
      proc(201, 200, 'node child.js'),
      proc(340, 1, '/usr/bin/foreign', { startedAt: T0 + 1 }),
      proc(341, 1, '/usr/bin/unmarked', { startedAt: T0 + 2 }),
      proc(342, 1, '/usr/bin/other-user', { startedAt: T0 + 3, uid: 502 }),
    );
    w.probe.env.set(340, mark('ses_b', 'another-instance'));
    w.probe.env.set(342, mark('ses_b'));
    const results = await w.monitor.stopOrphans(
      [
        item(200, T0),
        item(201, T0),
        { pid: SERVER_PID, startedAt: new Date(T0).toISOString() },
        item(340, T0 + 1),
        item(341, T0 + 2),
        item(342, T0 + 3),
        // Below an orphan, but not the root of it.
        item(311, T0),
      ],
      'usr_1',
    );
    expect(results.map((result) => result.outcome)).toEqual([
      'refused',
      'refused',
      'refused',
      'refused',
      'refused',
      'refused',
      'refused',
    ]);
    expect(w.probe.signals).toEqual([]);
  });

  it('reads the environment fresh: a process that executed a program of another instance is refused', async () => {
    const { w, item } = withOrphan();
    await w.monitor.view({ panel: false }); // the marker is cached
    w.probe.env.set(310, mark('ses_b', 'another-instance'));
    const [result] = await w.monitor.stopOrphans([item(310)], 'usr_1');
    expect(result!.outcome).toBe('refused');
    expect(w.probe.signals).toEqual([]);
  });

  it('refuses everything the process list does not allow to check', async () => {
    const { w, item } = withOrphan();
    w.probe.list = null;
    expect((await w.monitor.stopOrphans([item(310)], 'usr_1'))[0]!.outcome).toBe('failed');
  });

  it('sends SIGKILL to what is alive after three seconds, and reports stopped when that ends it', async () => {
    const { w, item } = withOrphan();
    w.probe.onSignal = (pid, signal) => {
      if (signal === 'SIGKILL') w.probe.list = w.probe.list!.filter((record) => record.pid !== pid);
      return 'sent';
    };
    const before = w.clock.t;
    const [result] = await w.monitor.stopOrphans([item(310)], 'usr_1');
    expect(result!.outcome).toBe('stopped');
    expect(w.probe.signals.map((s) => `${s.signal}:${s.pid}`)).toEqual([
      'SIGTERM:310',
      'SIGTERM:311',
      'SIGKILL:310',
      'SIGKILL:311',
    ]);
    expect(w.clock.t - before).toBeGreaterThanOrEqual(3000);
  });

  it('reports failed when the root lives after SIGKILL, or when the signal is denied', async () => {
    const stubborn = withOrphan();
    stubborn.w.probe.onSignal = () => 'sent';
    expect((await stubborn.w.monitor.stopOrphans([stubborn.item(310)], 'usr_1'))[0]!.outcome).toBe('failed');
    expect(stubborn.w.probe.signals.some((s) => s.signal === 'SIGKILL' && s.pid === 310)).toBe(true);

    const denied = withOrphan();
    denied.w.probe.onSignal = () => 'denied';
    expect((await denied.w.monitor.stopOrphans([denied.item(310)], 'usr_1'))[0]!.outcome).toBe('failed');
  });

  it('does not signal a pid that another process has taken in the meantime', async () => {
    const { w, item } = withOrphan();
    // SIGTERM ends the process, and the pid goes to a new one that is not ours to signal.
    w.probe.onSignal = (pid) => {
      w.probe.list = w.probe.list!.map((record) =>
        record.pid === pid ? { ...record, startedAt: T0 + 5000 } : record,
      );
      return 'sent';
    };
    const [result] = await w.monitor.stopOrphans([item(310)], 'usr_1');
    expect(result!.outcome).toBe('stopped');
    expect(w.probe.signals.every((s) => s.signal === 'SIGTERM')).toBe(true);
  });

  it('looks at the process list again right before SIGTERM: a pid taken since the orphan was recognised is not signalled', async () => {
    const { w, item } = withOrphan();
    const listed = w.probe.processes;
    let calls = 0;
    // The first list recognises the orphan; the next one (before the signal) has another process on pid 310.
    w.probe.processes = async () => {
      const list = await listed();
      calls++;
      return calls === 1
        ? list
        : list && list.map((record) => (record.pid === 310 ? { ...record, startedAt: T0 + 9999 } : record));
    };
    await w.monitor.stopOrphans([item(310)], 'usr_1');
    expect(w.probe.signals.some((s) => s.pid === 310)).toBe(false);
  });

  it('is not brought back by a round that began before the stop', async () => {
    const { w, item } = withOrphan();
    const listed = w.probe.processes;
    const stale = [...w.probe.list!];
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    w.probe.processes = async () => {
      if (!first) return listed();
      first = false;
      await hold;
      return stale;
    };
    const round = w.monitor.view({ panel: true });
    await settle();
    expect((await w.monitor.stopOrphans([item(310)], 'usr_1'))[0]!.outcome).toBe('stopped');
    release();
    expect((await round).orphans).toEqual([]);
  });

  it('runs one request at a time, and the second finds what the first stopped', async () => {
    const { w, item } = withOrphan();
    let release!: () => void;
    w.probe.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = w.monitor.stopOrphans([item(310)], 'usr_1');
    const second = w.monitor.stopOrphans([item(310)], 'usr_2');
    await settle();
    expect(w.probe.calls.processes).toBe(1); // the second has not begun
    release();
    expect((await first)[0]!.outcome).toBe('stopped');
    expect((await second)[0]!.outcome).toBe('gone');
    expect(w.probe.signals.filter((s) => s.signal === 'SIGTERM').map((s) => s.pid)).toEqual([310, 311]);
  });
});
