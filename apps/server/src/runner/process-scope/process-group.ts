import { randomBytes } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { SCOPE_TERM_GRACE_MS, SCOPE_KILL_WAIT_MS } from '../../contracts';
import type {
  ProcessRecord,
  ProcessScopeConfig,
  ScopeProcessSource,
  ScopeCloseReason,
  SessionCleanup,
} from '../../contracts';
import type { OpenScope, ProcessScopeDriver, ScopeClock } from './types';

const MARKS = ['PROJECTMAN_SCOPE_ID', 'PROJECTMAN_INSTANCE', 'PROJECTMAN_SESSION_ID'];
const SCOPE_ID = /^scp_[0-9a-f]{16}$/;

/** All inspection and signals run on the owning engine, never on a remote pid at the hub. */
export function createProcessScopeDriver(opts: {
  config: ProcessScopeConfig;
  processes?: ScopeProcessSource;
  instanceTag?: string;
  uid: number | null;
  logger: FastifyBaseLogger;
  clock?: ScopeClock;
  signal?: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void;
}): ProcessScopeDriver {
  const clock = opts.clock ?? {
    now: Date.now,
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  };
  const signal =
    opts.signal ??
    ((pid, sig) => {
      process.kill(pid, sig);
    });
  const retained = new Map<string, { sessionId: string; retry: () => Promise<SessionCleanup> }>();
  const active = new Set<string>();
  async function bounded<T>(job: () => Promise<T>, deadline?: number): Promise<T | null> {
    if (deadline === undefined) return job();
    const remaining = deadline - clock.now();
    if (remaining <= 0) return null;
    // Injected clocks account for time spent by their fake probes. Real probes may hang:
    // their late result must never resume signalling after the close has returned.
    if (opts.clock) {
      const value = await job();
      return clock.now() > deadline ? null : value;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        job(),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), remaining);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  const list = async (deadline?: number) => {
    // Composition installs the lazy machine probe after constructing the runner.
    await Promise.resolve();
    try {
      return await bounded(async () => (await opts.processes?.processes()) ?? null, deadline);
    } catch {
      return null;
    }
  };
  const env = async (pids: number[]) => {
    try {
      return (await opts.processes?.envValues(pids, MARKS)) ?? new Map<number, Record<string, string>>();
    } catch {
      return new Map<number, Record<string, string>>();
    }
  };
  function open(sessionId: string, scopeId: string, openedAt: number): OpenScope {
    let leaderPid: number | null = null;
    let leader: ProcessRecord | undefined;
    let capture: Promise<void> = Promise.resolve();
    let closing: Promise<SessionCleanup> | undefined;
    let closeDeadline: number | undefined;
    const known = new Map<number, number>();
    async function targets(): Promise<ProcessRecord[] | null> {
      const records = await list(closeDeadline);
      if (!records || opts.uid === null) return null;
      const candidates = records.filter(
        (p) => p.pid > 1 && p.uid === opts.uid && p.startedAt >= openedAt - 1000,
      );
      const marks = await bounded(() => env(candidates.map((p) => p.pid)), closeDeadline);
      if (marks === null) return null;
      const verifiedGroup =
        leaderPid !== null &&
        candidates.some(
          (p) =>
            p.pgid === leaderPid &&
            (marks.get(p.pid)?.PROJECTMAN_SCOPE_ID === undefined ||
              marks.get(p.pid)?.PROJECTMAN_SCOPE_ID === scopeId) &&
            (marks.get(p.pid)?.PROJECTMAN_SCOPE_ID === scopeId ||
              (leader?.pid === p.pid && leader.startedAt === p.startedAt) ||
              known.get(p.pid) === p.startedAt),
        );
      return candidates.filter((p) => {
        const mark = marks.get(p.pid)?.PROJECTMAN_SCOPE_ID;
        // A reused pid or an explicitly different generation is never ours.
        if (mark !== undefined && mark !== scopeId) return false;
        if (known.has(p.pid) && known.get(p.pid) !== p.startedAt) return false;
        const own =
          mark === scopeId ||
          (leader?.pid === p.pid && leader.startedAt === p.startedAt) ||
          (verifiedGroup && p.pgid === leaderPid);
        if (own) known.set(p.pid, p.startedAt);
        return own;
      });
    }
    async function send(sig: 'SIGTERM' | 'SIGKILL'): Promise<boolean> {
      const candidates = await targets();
      if (candidates === null) return false;
      // Only signal a group when every current member is verified. Otherwise use individual pids.
      const records = await list(closeDeadline);
      if (records === null) return false;
      const members = records.filter((p) => p.pgid === leaderPid);
      if (
        leaderPid !== null &&
        leaderPid > 1 &&
        members.length &&
        members.every((p) => candidates.some((c) => c.pid === p.pid && c.startedAt === p.startedAt))
      ) {
        try {
          signal(-leaderPid, sig);
        } catch {
          /* disappeared or refused; verify below */
        }
      }
      for (const candidate of candidates) {
        const fresh = await targets();
        if (fresh === null) return false;
        if (!fresh.some((p) => p.pid === candidate.pid && p.startedAt === candidate.startedAt)) continue;
        try {
          signal(candidate.pid, sig);
        } catch {
          /* verification determines the outcome */
        }
      }
      return true;
    }
    async function close(reason: ScopeCloseReason, force: boolean): Promise<SessionCleanup> {
      const at = clock.now();
      closeDeadline = at + (force ? 0 : SCOPE_TERM_GRACE_MS) + SCOPE_KILL_WAIT_MS;
      const captured = await bounded(() => capture, closeDeadline);
      let killed = false;
      const result = (outcome: SessionCleanup['outcome'], survivors = 0): SessionCleanup => ({
        scopeId,
        kind: 'process_group',
        outcome,
        reason,
        killed,
        survivors,
        durationMs: clock.now() - at,
      });
      if (captured === null) return result('unverified');
      let remaining = await targets();
      if (remaining === null) {
        // Older/unsupported engines cannot verify the group. Never report this as clean.
        if (leaderPid !== null && leaderPid > 1 && clock.now() < closeDeadline) {
          try {
            signal(-leaderPid, force ? 'SIGKILL' : 'SIGTERM');
          } catch {
            /* best effort */
          }
          if (!force) {
            await clock.sleep(Math.max(0, at + SCOPE_TERM_GRACE_MS - clock.now()));
            try {
              signal(-leaderPid, 'SIGKILL');
            } catch {
              /* best effort */
            }
          }
          killed = true;
        }
        return result('unverified');
      }
      for (const [sig, wait] of [
        ['SIGTERM', SCOPE_TERM_GRACE_MS],
        ['SIGKILL', SCOPE_KILL_WAIT_MS],
      ] as const) {
        if (sig === 'SIGTERM' && force) continue;
        if (!remaining.length) return result('clean');
        if (sig === 'SIGKILL') killed = true;
        if (!(await send(sig))) return result('unverified');
        const deadline = sig === 'SIGTERM' ? at + wait : closeDeadline;
        do {
          if (clock.now() >= deadline) break;
          remaining = await targets();
          if (remaining === null) return result('unverified');
          if (!remaining.length) return result('clean');
          if (clock.now() >= deadline) break;
          await clock.sleep(Math.min(100, deadline - clock.now()));
        } while (true);
      }
      return result('failed', remaining.length);
    }
    const trackedClose = async (reason: ScopeCloseReason, force: boolean) => {
      const cleanup = await close(reason, force);
      active.delete(scopeId);
      if (cleanup.outcome === 'failed')
        retained.set(scopeId, { sessionId, retry: () => trackedClose('recovery', false) });
      else retained.delete(scopeId);
      return cleanup;
    };
    return {
      scopeId,
      openedAt,
      launch: (cmd) => ({ ...cmd, env: { ...cmd.env, PROJECTMAN_SCOPE_ID: scopeId } }),
      attached(pid) {
        if (pid <= 1) return;
        leaderPid = pid;
        capture = list().then((records) => {
          leader = records?.find(
            (p) => p.pid === pid && p.uid === opts.uid && p.startedAt >= openedAt - 1000,
          );
          if (leader) known.set(pid, leader.startedAt);
        });
      },
      close: (reason, { force }) => (closing ??= trackedClose(reason, force)),
    };
  }
  return {
    kind: 'process_group',
    async open(sessionId) {
      const id = `scp_${randomBytes(8).toString('hex')}`;
      active.add(id);
      return open(sessionId, id, clock.now());
    },
    async recover() {
      const results: Array<{ sessionId: string; cleanup: SessionCleanup }> = [];
      if (!opts.instanceTag || opts.uid === null) return results;
      const records = await list();
      if (!records) return results;
      const candidates = records.filter((p) => p.uid === opts.uid && p.pid > 1);
      const marks = await env(candidates.map((p) => p.pid));
      const scopes = new Map<string, { sessionId: string; at: number }>();
      for (const p of candidates) {
        const m = marks.get(p.pid);
        const id = m?.PROJECTMAN_SCOPE_ID;
        if (
          !id ||
          active.has(id) ||
          retained.has(id) ||
          !SCOPE_ID.test(id) ||
          m?.PROJECTMAN_INSTANCE !== opts.instanceTag ||
          !m.PROJECTMAN_SESSION_ID
        )
          continue;
        const existing = scopes.get(id);
        scopes.set(id, {
          sessionId: m.PROJECTMAN_SESSION_ID,
          at: Math.min(existing?.at ?? p.startedAt, p.startedAt),
        });
      }
      await Promise.all(
        [...scopes].map(async ([id, entry]) => {
          const cleanup = await open(entry.sessionId, id, entry.at).close('recovery', { force: false });
          results.push({ sessionId: entry.sessionId, cleanup });
        }),
      );
      return results;
    },
    async closeScopes(scopes) {
      return Promise.all(
        scopes.map(async ({ sessionId, scopeId }) => {
          const entry = retained.get(scopeId);
          if (entry?.sessionId === sessionId) return { sessionId, cleanup: await entry.retry() };
          const records = await list();
          const unverified: SessionCleanup = {
            scopeId,
            kind: 'process_group',
            outcome: 'unverified',
            reason: 'recovery',
            killed: false,
            survivors: 0,
            durationMs: 0,
          };
          if (
            !records ||
            opts.uid === null ||
            !opts.instanceTag ||
            !SCOPE_ID.test(scopeId) ||
            active.has(scopeId)
          )
            return { sessionId, cleanup: unverified };
          const candidates = records.filter((p) => p.uid === opts.uid && p.pid > 1);
          const marks = await env(candidates.map((p) => p.pid));
          const unreadable = candidates.filter((p) => !marks.has(p.pid));
          if (unreadable.length) {
            const fresh = await list();
            if (
              !fresh ||
              unreadable.some((p) =>
                fresh.some((current) => current.pid === p.pid && current.startedAt === p.startedAt),
              )
            )
              return { sessionId, cleanup: unverified };
          }
          const own = candidates.filter((p) => {
            const m = marks.get(p.pid);
            return (
              m !== undefined &&
              m.PROJECTMAN_INSTANCE === opts.instanceTag &&
              m.PROJECTMAN_SCOPE_ID === scopeId &&
              m.PROJECTMAN_SESSION_ID === sessionId
            );
          });
          if (!own.length) return { sessionId, cleanup: { ...unverified, outcome: 'clean' } };
          const scope = open(sessionId, scopeId, Math.min(...own.map((p) => p.startedAt)));
          return { sessionId, cleanup: await scope.close('recovery', { force: false }) };
        }),
      );
    },
  };
}
