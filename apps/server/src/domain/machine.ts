import { createHash } from 'node:crypto';
import { isWorkingSessionState } from '@projectman/shared';
import type {
  MachineMember,
  MachineSessionRow,
  MachineSummary,
  MachineView,
  OrphanOrigin,
  OrphanProcessRow,
  OrphanStopOutcome,
  OtherProcessRow,
  ProcessUsage,
  Session,
  StopOrphansRequest,
} from '@projectman/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { MachineProbe, MachineSnapshot, ProcessRecord, RunningSessionInfo } from '../contracts';
import { shortName } from '../machine/parse';

/**
 * The machine display's server side (PM-320): measures the machine and the processes now and then,
 * says which processes belong to which running session, which a finished session left behind
 * (orphans), and stops orphans on request.
 *
 * Every process of a session inherits `PROJECTMAN_SESSION_ID` and `PROJECTMAN_INSTANCE` (the runner
 * sets them). A process is an orphan only when both markers are there, the instance's tag is this
 * one's, and its session is not running (or the process is from an earlier run of it). What cannot
 * be tied to a session of this instance for certain is never an orphan and is never stopped.
 */

const SESSION_ID_VAR = 'PROJECTMAN_SESSION_ID';
const INSTANCE_VAR = 'PROJECTMAN_INSTANCE';

/** How often it measures: while a panel polls, while anything polls; otherwise it does not measure. */
export const MACHINE_PANEL_INTERVAL_MS = 5000;
export const MACHINE_IDLE_INTERVAL_MS = 15_000;
const PANEL_DEMAND_MS = 15_000;
const ANY_DEMAND_MS = 45_000;
/** A sample older than this many intervals is measured again for the request that asks. */
const STALE_INTERVALS = 2;
/** The longest a request waits for a new round. */
const VIEW_WAIT_MS = 3000;
/** The first round reads the processor twice, this far apart, to have a load to show. */
const FIRST_CPU_GAP_MS = 500;
const CLOSED_SESSIONS_TTL_MS = 30_000;
/** An earlier reading older than this is no reference for the load now. */
const CPU_REFERENCE_MAX_AGE_MS = 60_000;

const SESSION_TOP = 5;
const OTHER_ROWS_MAX = 8;
const OTHER_MIN_CPU_PERCENT = 5;
const OTHER_MIN_MEMORY_BYTES = 500 * 1024 * 1024;
const COMMAND_MAX = 160;

const STOP_TERM_WAIT_MS = 3000;
const STOP_POLL_MS = 250;
const STOP_KILL_WAIT_MS = 1000;

/** Marker of a process: the session that started it. */
interface Marker {
  sessionId: string;
}

interface OrphanTree {
  root: ProcessRecord;
  /** The root and everything below it. */
  members: ProcessRecord[];
  sessionId: string;
}

interface Classification {
  byPid: Map<number, ProcessRecord>;
  /** Per running session: its CLI's record, when it is in the list. */
  cliOf: Map<string, ProcessRecord>;
  /** Per running session: the CLI's processes and its detached children's. */
  sessionTrees: Map<string, ProcessRecord[]>;
  serverTree: ProcessRecord[];
  orphans: OrphanTree[];
  others: ProcessRecord[];
}

export interface MachineMonitorOptions {
  probe: MachineProbe;
  runner: { list(): RunningSessionInfo[] };
  sessions: { get(id: string): Session | null; countResumable(): number };
  tasks: { get(key: string): { title: string } | null };
  /** The member as the display names it; null when the project or member is gone. */
  memberOf: (projectKey: string, handle: string) => Promise<MachineMember | null>;
  /** The tag of this instance (`PROJECTMAN_INSTANCE`); absent or empty: no process is ever an orphan. */
  instanceTag?: string;
  serverPid?: number;
  /** The server's user; null where there are no user ids (no orphan is then recognised). */
  serverUid?: number | null;
  logger: FastifyBaseLogger;
  now?: () => Date;
  /** Starts a timer; the returned function cancels it (tests pass a fake). */
  setTimer?: (run: () => void, ms: number) => () => void;
  sleep?: (ms: number) => Promise<void>;
}

function realTimer(run: () => void, ms: number): () => void {
  const timer = setTimeout(run, ms);
  timer.unref();
  return () => clearTimeout(timer);
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface Sample {
  at: number;
  view: Omit<MachineView, 'intervalMs'>;
}

const round1 = (value: number): number => Math.round(value * 10) / 10;
const sum = (values: Array<number | null>): number =>
  values.reduce<number>((total, v) => total + (v ?? 0), 0);

export class MachineMonitor {
  private readonly o: MachineMonitorOptions;
  private readonly now: () => Date;
  private readonly setTimer: (run: () => void, ms: number) => () => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly serverPid: number;
  private readonly serverUid: number | null;

  private lastPanelAt: number | null = null;
  private lastAnyAt: number | null = null;
  private sample: Sample | null = null;
  private inflight: Promise<void> | null = null;
  private cancelTimer: (() => void) | null = null;
  private stopped = false;

  private lastCpu: { busyMs: number; totalMs: number; at: number } | null = null;
  private lastCpuSeconds = new Map<string, number>();
  private lastProcessesAt: number | null = null;
  private readonly markers = new Map<string, Marker | null>();
  /** Orphans stopped here (pid and start time): a round that began before the stop must not bring them back. */
  private readonly stoppedOrphans = new Set<string>();
  private closed: { at: number; count: number } | null = null;
  private stopQueue: Promise<unknown> = Promise.resolve();

  constructor(options: MachineMonitorOptions) {
    this.o = options;
    this.now = options.now ?? (() => new Date());
    this.setTimer = options.setTimer ?? realTimer;
    this.sleep = options.sleep ?? realSleep;
    this.serverPid = options.serverPid ?? process.pid;
    this.serverUid = options.serverUid !== undefined ? options.serverUid : (process.getuid?.() ?? null);
  }

  /* ---------- demand and rounds ---------- */

  /** The interval the present demand asks for; null: nobody asks, so nothing is measured. */
  private demandInterval(at: number): number | null {
    if (this.lastPanelAt !== null && at - this.lastPanelAt <= PANEL_DEMAND_MS)
      return MACHINE_PANEL_INTERVAL_MS;
    if (this.lastAnyAt !== null && at - this.lastAnyAt <= ANY_DEMAND_MS) return MACHINE_IDLE_INTERVAL_MS;
    return null;
  }

  /** The machine as measured last, measuring first when there is no sample or it is old. */
  async view(request: { panel: boolean }): Promise<MachineView> {
    const at = this.now().getTime();
    this.lastAnyAt = at;
    if (request.panel) this.lastPanelAt = at;
    const interval = this.demandInterval(at) ?? MACHINE_IDLE_INTERVAL_MS;
    if (!this.sample || at - this.sample.at > STALE_INTERVALS * interval) {
      await this.waitFor(this.round(), VIEW_WAIT_MS);
    } else {
      this.schedule();
    }
    return this.current(interval);
  }

  /** Stops measuring (server shutdown): waits for a round that is running. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.cancelTimer?.();
    this.cancelTimer = null;
    await this.inflight?.catch(() => undefined);
  }

  private waitFor(work: Promise<void>, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref();
      void work.then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        () => {
          clearTimeout(timer);
          resolve();
        },
      );
    });
  }

  /** One round at a time: a request that comes while one runs shares it. */
  private round(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.cancelTimer?.();
    this.cancelTimer = null;
    const run = this.measure()
      .catch((err: unknown) => this.o.logger.warn({ err }, 'the machine measurement failed'))
      .finally(() => {
        this.inflight = null;
        this.schedule();
      });
    this.inflight = run;
    return run;
  }

  /** Arranges the next round from the last sample and the present demand. */
  private schedule(): void {
    if (this.stopped || this.inflight) return;
    const at = this.now().getTime();
    const interval = this.demandInterval(at);
    this.cancelTimer?.();
    this.cancelTimer = null;
    if (interval === null) return;
    const delay = Math.max(0, (this.sample?.at ?? at) + interval - at);
    this.cancelTimer = this.setTimer(() => {
      this.cancelTimer = null;
      if (this.demandInterval(this.now().getTime()) === null) return;
      void this.round();
    }, delay);
  }

  /* ---------- measuring ---------- */

  private async measure(): Promise<void> {
    const { probe } = this.o;
    // The load is measured between two readings: the last round's, or (the first round, or after a
    // long pause, when the last reading says nothing of now) one a moment ago.
    let before =
      this.lastCpu && this.now().getTime() - this.lastCpu.at <= CPU_REFERENCE_MAX_AGE_MS
        ? this.lastCpu
        : null;
    let first = await probe.machine();
    if (before === null && first.cpu !== null) {
      await this.sleep(FIRST_CPU_GAP_MS);
      before = { ...first.cpu, at: 0 };
      first = await probe.machine();
    }
    const machine = first;
    const cpuPercent = cpuLoad(before, machine.cpu);
    this.lastCpu = machine.cpu ? { ...machine.cpu, at: this.now().getTime() } : null;

    const processes = await probe.processes();
    const at = this.now().getTime();
    const cores = machine.cores;
    const running = this.o.runner.list();
    const classification = processes ? await this.classify(processes, running, { fresh: false }) : null;
    if (processes) {
      const present = new Set(processes.map(identity));
      for (const key of this.stoppedOrphans) if (!present.has(key)) this.stoppedOrphans.delete(key);
    }
    const usage = this.usageOf(processes, cores, at);

    const sessionRows: MachineSessionRow[] = [];
    for (const info of running) {
      const row = await this.sessionRow(info, classification, usage);
      if (row) sessionRows.push(row);
    }
    sessionRows.sort(byMemoryDescending);

    const orphans = classification ? await this.orphanRows(classification, usage) : null;
    const serverRow = classification ? this.serverRow(classification, usage) : null;
    const others = classification
      ? [...(serverRow ? [serverRow] : []), ...this.otherRows(classification, usage)]
      : null;

    const shown = [...sessionRows, ...(orphans ?? []), ...(others ?? [])];
    const rest =
      classification === null
        ? null
        : {
            cpuPercent:
              cpuPercent === null
                ? null
                : round1(Math.max(0, cpuPercent - sum(shown.map((r) => r.cpuPercent)))),
            memoryBytes:
              machine.memoryUsedBytes === null
                ? null
                : Math.max(0, machine.memoryUsedBytes - sum(shown.map((r) => r.memoryBytes))),
          };

    this.sample = {
      at,
      view: {
        sampledAt: new Date(at).toISOString(),
        summary: this.summaryOf(machine, cpuPercent, running),
        sessions: sessionRows,
        orphans,
        others,
        rest,
        closedSessions: this.closedSessions(at),
      },
    };
  }

  private summaryOf(
    machine: MachineSnapshot,
    cpuPercent: number | null,
    running: RunningSessionInfo[],
  ): MachineSummary {
    return {
      cpuPercent: cpuPercent === null ? null : round1(cpuPercent),
      cores: machine.cores,
      memoryUsedBytes: machine.memoryUsedBytes,
      memoryTotalBytes: machine.memoryTotalBytes,
      memoryPressure: machine.memoryPressure,
      swapUsedBytes: machine.swapUsedBytes,
      swapTotalBytes: machine.swapTotalBytes,
      sessionsRunning: running.length,
      sessionsWorking: running.filter((info) => isWorkingSessionState(info.state)).length,
    };
  }

  private closedSessions(at: number): number {
    if (!this.closed || at - this.closed.at >= CLOSED_SESSIONS_TTL_MS) {
      this.closed = { at, count: this.o.sessions.countResumable() };
    }
    return this.closed.count;
  }

  private current(intervalMs: number): MachineView {
    if (this.sample) return { ...this.sample.view, intervalMs };
    const running = this.o.runner.list();
    return {
      sampledAt: null,
      intervalMs,
      summary: {
        cpuPercent: null,
        cores: null,
        memoryUsedBytes: null,
        memoryTotalBytes: null,
        memoryPressure: null,
        swapUsedBytes: null,
        swapTotalBytes: null,
        sessionsRunning: running.length,
        sessionsWorking: running.filter((info) => isWorkingSessionState(info.state)).length,
      },
      sessions: [],
      orphans: null,
      others: null,
      rest: null,
      closedSessions: 0,
    };
  }

  /**
   * The share of the whole machine's processor each process used since the last round: its CPU time
   * over the time and the cores. In the first round, and for a process that started since, `ps`'s
   * own `%cpu` (of one core) over the cores.
   */
  private usageOf(
    processes: ProcessRecord[] | null,
    cores: number | null,
    at: number,
  ): Map<number, { cpuPercent: number }> {
    const usage = new Map<number, { cpuPercent: number }>();
    if (!processes) return usage;
    const gap = this.lastProcessesAt === null ? 0 : at - this.lastProcessesAt;
    const seconds = gap > CPU_REFERENCE_MAX_AGE_MS ? 0 : gap / 1000;
    const width = cores && cores > 0 ? cores : 1;
    const next = new Map<string, number>();
    for (const record of processes) {
      const key = identity(record);
      next.set(key, record.cpuSeconds);
      const earlier = this.lastCpuSeconds.get(key);
      const percent =
        earlier !== undefined && seconds > 0
          ? ((record.cpuSeconds - earlier) / (seconds * width)) * 100
          : record.cpuPercent / width;
      usage.set(record.pid, { cpuPercent: Math.max(0, percent) });
    }
    this.lastCpuSeconds = next;
    this.lastProcessesAt = at;
    return usage;
  }

  /* ---------- classification ---------- */

  /**
   * Sorts the processes into live session trees, the server's, orphans and the rest. `fresh` reads
   * the markers of the orphan candidates again (the stop of orphans), `only` limits that to these pids.
   */
  private async classify(
    processes: ProcessRecord[],
    running: RunningSessionInfo[],
    options: { fresh: boolean; only?: ReadonlySet<number> },
  ): Promise<Classification> {
    const byPid = new Map(processes.map((record) => [record.pid, record]));
    const children = new Map<number, ProcessRecord[]>();
    for (const record of processes) {
      const siblings = children.get(record.ppid);
      if (siblings) siblings.push(record);
      else children.set(record.ppid, [record]);
    }
    const taken = new Set<number>();
    const treeOf = (root: ProcessRecord): ProcessRecord[] => {
      const members: ProcessRecord[] = [];
      const queue = [root];
      const seen = new Set<number>();
      while (queue.length > 0) {
        const record = queue.shift()!;
        if (seen.has(record.pid) || taken.has(record.pid)) continue;
        seen.add(record.pid);
        members.push(record);
        for (const child of children.get(record.pid) ?? []) queue.push(child);
      }
      return members;
    };

    const cliOf = new Map<string, ProcessRecord>();
    const sessionTrees = new Map<string, ProcessRecord[]>();
    for (const info of running) {
      const cli = info.pid > 0 ? byPid.get(info.pid) : undefined;
      if (!cli) continue;
      cliOf.set(info.sessionId, cli);
      const tree = treeOf(cli);
      for (const member of tree) taken.add(member.pid);
      sessionTrees.set(info.sessionId, tree);
    }
    const server = byPid.get(this.serverPid);
    const serverTree = server ? treeOf(server) : [];
    for (const member of serverTree) taken.add(member.pid);

    const ancestors = new Set<number>();
    for (let pid = byPid.get(this.serverPid)?.ppid; pid && !ancestors.has(pid); pid = byPid.get(pid)?.ppid)
      ancestors.add(pid);

    // Candidates: the server's user's processes that no live session or the server owns.
    const candidates = new Map<number, ProcessRecord>();
    if (this.serverUid !== null && this.o.instanceTag) {
      for (const record of processes) {
        if (record.uid !== this.serverUid || record.pid <= 1) continue;
        if (taken.has(record.pid) || ancestors.has(record.pid) || record.pid === this.serverPid) continue;
        candidates.set(record.pid, record);
      }
    }
    const roots = [...candidates.values()].filter((record) => !candidates.has(record.ppid));
    const markers = await this.readMarkers(
      options.only ? roots.filter((root) => options.only!.has(root.pid)) : roots,
      options.fresh,
    );
    if (!options.fresh) this.pruneMarkers(roots);

    const runningById = new Map(running.map((info) => [info.sessionId, info]));
    const orphans: OrphanTree[] = [];
    for (const root of roots) {
      const marker = markers.get(root.pid);
      if (!marker) continue;
      const live = runningById.get(marker.sessionId);
      const cli = cliOf.get(marker.sessionId);
      if (live && !cli) continue; // a running session whose CLI cannot be compared: not for certain an orphan
      if (live && cli && root.startedAt >= cli.startedAt) {
        // Started with or after the CLI: a child of the session that left it, still the session's own.
        const tree = treeOf(root);
        for (const member of tree) taken.add(member.pid);
        sessionTrees.get(marker.sessionId)!.push(...tree);
        continue;
      }
      const members = treeOf(root);
      for (const member of members) taken.add(member.pid);
      orphans.push({ root, members, sessionId: marker.sessionId });
    }
    const others = processes.filter((record) => !taken.has(record.pid));
    return { byPid, cliOf, sessionTrees, serverTree, orphans, others };
  }

  private async readMarkers(roots: ProcessRecord[], fresh: boolean): Promise<Map<number, Marker | null>> {
    const found = new Map<number, Marker | null>();
    const unread: ProcessRecord[] = [];
    for (const root of roots) {
      const cached = fresh ? undefined : this.markers.get(markerKey(root));
      if (cached !== undefined) found.set(root.pid, cached);
      else unread.push(root);
    }
    if (unread.length === 0) return found;
    let environment: Map<number, Record<string, string>>;
    try {
      environment = await this.o.probe.envValues(
        unread.map((root) => root.pid),
        [SESSION_ID_VAR, INSTANCE_VAR],
      );
    } catch (err) {
      this.o.logger.warn({ err }, 'could not read the environment of processes');
      return found;
    }
    for (const root of unread) {
      const values = environment.get(root.pid);
      // No answer for a process of ours (a failed or timed out `ps`) is not a "no marker": ask again
      // next round. Another user's processes never answer, and cannot be ours.
      if (!values && root.uid === this.serverUid) {
        found.set(root.pid, null);
        continue;
      }
      const sessionId = values?.[SESSION_ID_VAR];
      const marker: Marker | null =
        values && values[INSTANCE_VAR] === this.o.instanceTag && sessionId?.startsWith('ses_')
          ? { sessionId }
          : null;
      found.set(root.pid, marker);
      if (!fresh) this.markers.set(markerKey(root), marker);
    }
    return found;
  }

  private pruneMarkers(roots: ProcessRecord[]): void {
    const keep = new Set(roots.map(markerKey));
    for (const key of this.markers.keys()) if (!keep.has(key)) this.markers.delete(key);
  }

  /* ---------- rows ---------- */

  private totals(
    members: ProcessRecord[],
    usage: Map<number, { cpuPercent: number }>,
  ): { cpuPercent: number; memoryBytes: number; processCount: number } {
    let cpu = 0;
    let memory = 0;
    for (const member of members) {
      cpu += usage.get(member.pid)?.cpuPercent ?? 0;
      memory += member.rssBytes;
    }
    return { cpuPercent: round1(cpu), memoryBytes: memory, processCount: members.length };
  }

  private async taskTitleOf(session: Session): Promise<string | null> {
    return session.workItem.type === 'task'
      ? (this.o.tasks.get(session.workItem.taskKey)?.title ?? null)
      : null;
  }

  private async memberOf(projectKey: string, handle: string): Promise<MachineMember | null> {
    try {
      return await this.o.memberOf(projectKey, handle);
    } catch {
      return null;
    }
  }

  private async sessionRow(
    info: RunningSessionInfo,
    classification: Classification | null,
    usage: Map<number, { cpuPercent: number }>,
  ): Promise<MachineSessionRow | null> {
    const session = this.o.sessions.get(info.sessionId);
    if (!session) return null;
    const tree = classification?.sessionTrees.get(info.sessionId);
    const cli = classification?.cliOf.get(info.sessionId);
    const top: ProcessUsage[] = tree
      ? [...tree]
          .sort((a, b) => b.rssBytes - a.rssBytes)
          .slice(0, SESSION_TOP)
          .map((record) => ({
            pid: record.pid,
            name: shortName(record.args),
            cpuPercent: round1(usage.get(record.pid)?.cpuPercent ?? 0),
            memoryBytes: record.rssBytes,
          }))
      : [];
    const totals = tree ? this.totals(tree, usage) : null;
    return {
      sessionId: session.id,
      projectKey: session.projectKey,
      memberHandle: session.member,
      member: await this.memberOf(session.projectKey, session.member),
      workItem: session.workItem,
      taskTitle: await this.taskTitleOf(session),
      state: session.state,
      stateSince: session.stateSince ?? session.lastActivityAt,
      paused: session.pause !== undefined,
      pid: info.pid > 0 ? info.pid : null,
      processStartedAt: cli ? new Date(cli.startedAt).toISOString() : null,
      cpuPercent: totals?.cpuPercent ?? null,
      memoryBytes: totals?.memoryBytes ?? null,
      processCount: totals?.processCount ?? null,
      top,
    };
  }

  private async originOf(sessionId: string): Promise<OrphanOrigin | null> {
    const session = this.o.sessions.get(sessionId);
    if (!session) return null;
    return {
      sessionId: session.id,
      projectKey: session.projectKey,
      memberHandle: session.member,
      member: await this.memberOf(session.projectKey, session.member),
      workItem: session.workItem,
      taskTitle: await this.taskTitleOf(session),
      endedAt: session.endedAt,
    };
  }

  private async orphanRows(
    classification: Classification,
    usage: Map<number, { cpuPercent: number }>,
  ): Promise<OrphanProcessRow[]> {
    const rows: OrphanProcessRow[] = [];
    for (const orphan of classification.orphans) {
      if (this.stoppedOrphans.has(identity(orphan.root))) continue;
      rows.push({
        pid: orphan.root.pid,
        startedAt: new Date(orphan.root.startedAt).toISOString(),
        name: shortName(orphan.root.args),
        command: orphan.root.args.slice(0, COMMAND_MAX),
        ...this.totals(orphan.members, usage),
        origin: await this.originOf(orphan.sessionId),
      });
    }
    return rows.sort(byMemoryDescending);
  }

  private serverRow(
    classification: Classification,
    usage: Map<number, { cpuPercent: number }>,
  ): OtherProcessRow | null {
    if (classification.serverTree.length === 0) return null;
    return { kind: 'server', name: 'projectman', ...this.totals(classification.serverTree, usage) };
  }

  /** The processes of no session, grouped by short name; only groups that use enough get a row. */
  private otherRows(
    classification: Classification,
    usage: Map<number, { cpuPercent: number }>,
  ): OtherProcessRow[] {
    const groups = new Map<string, ProcessRecord[]>();
    for (const record of classification.others) {
      const name = shortName(record.args) || '?';
      const group = groups.get(name);
      if (group) group.push(record);
      else groups.set(name, [record]);
    }
    const rows: OtherProcessRow[] = [];
    for (const [name, members] of groups) {
      const totals = this.totals(members, usage);
      if (totals.cpuPercent >= OTHER_MIN_CPU_PERCENT || totals.memoryBytes >= OTHER_MIN_MEMORY_BYTES)
        rows.push({ kind: 'process', name, ...totals });
    }
    return rows.sort(byMemoryDescending).slice(0, OTHER_ROWS_MAX);
  }

  /* ---------- stopping orphans ---------- */

  /**
   * Stops the orphans the items name (a process is named by its pid and start time). One request
   * runs at a time. Each is checked against a fresh process list and fresh environments before it is
   * signalled: anything that is not an orphan of this instance now is refused. The command lines are
   * never logged.
   */
  stopOrphans(
    items: StopOrphansRequest['orphans'],
    userId: string,
  ): Promise<Array<{ pid: number; startedAt: string; outcome: OrphanStopOutcome }>> {
    const run = this.stopQueue.then(() => this.stopNow(items, userId));
    this.stopQueue = run.catch(() => undefined);
    return run;
  }

  private async stopNow(
    items: StopOrphansRequest['orphans'],
    userId: string,
  ): Promise<Array<{ pid: number; startedAt: string; outcome: OrphanStopOutcome }>> {
    const result = (item: { pid: number; startedAt: string }, outcome: OrphanStopOutcome) => ({
      pid: item.pid,
      startedAt: item.startedAt,
      outcome,
    });
    const listed = await this.o.probe.processes();
    if (!listed) return items.map((item) => result(item, 'failed'));
    const classification = await this.classify(listed, this.o.runner.list(), {
      fresh: true,
      only: new Set(items.map((item) => item.pid)),
    });
    const results = await Promise.all(
      items.map(async (item) => {
        const record = classification.byPid.get(item.pid);
        if (!record || record.startedAt !== Date.parse(item.startedAt)) return result(item, 'gone');
        const orphan = classification.orphans.find((candidate) => candidate.root.pid === record.pid);
        if (!orphan || record.pid === this.serverPid || record.uid !== this.serverUid)
          return result(item, 'refused');
        const outcome = await this.stopTree(orphan);
        this.o.logger.info(
          { userId, pid: record.pid, name: shortName(record.args), sessionId: orphan.sessionId, outcome },
          'stopped an orphan process of a session',
        );
        return result(item, outcome);
      }),
    );
    this.forget(results.filter((r) => r.outcome === 'stopped' || r.outcome === 'gone'));
    return results;
  }

  /**
   * The panel asks again right after a stop: what is gone leaves the last sample at once, not at the
   * next round, and a round that was already running does not bring it back (it is remembered until
   * the process is no longer in the list).
   */
  private forget(items: Array<{ pid: number; startedAt: string }>): void {
    if (items.length === 0) return;
    const gone = new Set(items.map((item) => `${item.pid}:${Date.parse(item.startedAt)}`));
    for (const key of gone) this.stoppedOrphans.add(key);
    const view = this.sample?.view;
    if (!view?.orphans) return;
    this.sample = {
      ...this.sample!,
      view: {
        ...view,
        orphans: view.orphans.filter((row) => !gone.has(`${row.pid}:${Date.parse(row.startedAt)}`)),
      },
    };
  }

  /** SIGTERM to the root and its descendants (the same user's), SIGKILL to what lives after a wait. */
  private async stopTree(orphan: OrphanTree): Promise<OrphanStopOutcome> {
    const { probe } = this.o;
    const targets = orphan.members.filter((member) => member.uid === this.serverUid);
    let rootDenied = false;
    // The pid and start time are compared again right before a signal: a pid may be reused.
    const signalAll = async (
      signal: 'SIGTERM' | 'SIGKILL',
      current: Map<number, ProcessRecord>,
    ): Promise<void> => {
      for (const target of targets) {
        const now = current.get(target.pid);
        if (!now || now.startedAt !== target.startedAt || target.pid <= 1 || target.pid === this.serverPid)
          continue;
        if ((await probe.signal(target.pid, signal)) === 'denied' && target.pid === orphan.root.pid)
          rootDenied = true;
      }
    };
    const alive = (list: ProcessRecord[]): ProcessRecord[] => {
      const byPid = new Map(list.map((record) => [record.pid, record]));
      return targets.filter((target) => byPid.get(target.pid)?.startedAt === target.startedAt);
    };

    // The list the orphan was recognised in is older than the environment reads: look again.
    let latest: ProcessRecord[] | null = await probe.processes();
    if (!latest) return 'failed';
    await signalAll('SIGTERM', new Map(latest.map((record) => [record.pid, record])));
    for (let waited = 0; waited < STOP_TERM_WAIT_MS; waited += STOP_POLL_MS) {
      await this.sleep(STOP_POLL_MS);
      latest = await probe.processes();
      if (!latest) return 'failed';
      if (alive(latest).length === 0) break;
    }
    if (latest && alive(latest).length > 0) {
      await signalAll('SIGKILL', new Map(latest.map((record) => [record.pid, record])));
      await this.sleep(STOP_KILL_WAIT_MS);
      latest = await probe.processes();
      if (!latest) return 'failed';
    }
    const rootAlive = latest ? alive(latest).some((target) => target.pid === orphan.root.pid) : true;
    return rootAlive || rootDenied ? 'failed' : 'stopped';
  }
}

function cpuLoad(
  before: { busyMs: number; totalMs: number } | null,
  after: { busyMs: number; totalMs: number } | null,
): number | null {
  if (!before || !after) return null;
  const total = after.totalMs - before.totalMs;
  if (total <= 0) return null;
  return Math.min(100, Math.max(0, ((after.busyMs - before.busyMs) / total) * 100));
}

/** A process is its pid together with its start time (a pid is reused). */
function identity(record: ProcessRecord): string {
  return `${record.pid}:${record.startedAt}`;
}

/** The identity and a digest of the command line: a process that executed another program is another one. */
function markerKey(record: ProcessRecord): string {
  return `${identity(record)}:${createHash('sha1').update(record.args).digest('hex')}`;
}

function byMemoryDescending<T extends { memoryBytes: number | null }>(a: T, b: T): number {
  return (b.memoryBytes ?? -1) - (a.memoryBytes ?? -1);
}
