import {
  alertPayloadOf,
  DEFAULT_AGENT_PROVIDER,
  isOnLeave,
  LOCAL_ENGINE_ID,
  outageIdOf,
  OUTAGE_REFUSALS,
  ownerHandles,
  providerOutageProblemOf,
  taskSeq,
  WorkOutageAlert,
} from '@projectman/shared';
import type {
  AgentProvider,
  AiMemberConfig,
  CheckOutageResponse,
  EngineId,
  ProviderOutageProblem,
  Task,
  WorkOutage,
} from '@projectman/shared';
import type { EngineDirectory, ProviderStatus, SessionRunner } from '../../contracts';
import { ENGINE_OFFLINE_AFTER_MS } from '../../contracts';
import type { ProjectAccess } from '../../core/members';
import type { DeferredStarts, StartFailures, StartHold } from '../admission';
import { isoNow } from '../../core/base';
import type { DomainContext } from '../../core/base';
import { conflict, forbidden } from '../../kernel';
import type { InboxService } from '../../core/inbox';
import type { MemberService } from '../../core/members';
import type { MessageRouter } from '../delivery';
import type { ProjectService } from '../../core/projects';
import type { TaskService } from '../../core/tasks';
import { waitForStatus } from './provider-status-wait';

type Target =
  | { kind: 'engine'; engineId: EngineId | null }
  | { kind: 'provider'; provider: AgentProvider; engineId: EngineId | null };
type MemberTarget = { projectKey: string; member: AiMemberConfig; target: Target };
type Failure = { outage: WorkOutage; setup: ProviderOutageProblem | null };
interface OutageDependencies {
  ctx: DomainContext;
  projects: ProjectService;
  inbox: InboxService;
  engines: EngineDirectory;
  runner: SessionRunner;
  deferred: DeferredStarts;
  /** The places whose starts keep failing (PM-1335): the outage of a stopped place, and what releases it. */
  startFailures: Pick<StartFailures, 'stoppedFor' | 'release'>;
  messageRouter: Pick<MessageRouter, 'releaseForEngine' | 'pendingTaskKeys'>;
  members: MemberService;
  tasks: TaskService;
  retry: () => void;
  engineName?: (id: EngineId) => string | null;
}
const isOutageRefusal = (code: string): boolean => OUTAGE_REFUSALS.some((value) => value === code);
const isSetupRefusal = (code: string): boolean =>
  code === 'codex_setup_incomplete' || code === 'nanogpt_setup_incomplete';
/** The limit of a place's failed starts (PM-1335): hidden like a setup failure, but kept alive by the counter, not by a deferral. */
const isStartFailing = (code: string): boolean => code === 'start_failing';
const memberKey = (key: string, handle: string): string => `${key}:${handle}`;
const PENDING_KEYS_TTL_MS = 2_000;

/** Instance-wide observations, with one owner warning per project and outage episode. */
export class WorkOutages {
  private readonly failures = new Map<string, Failure>();
  private readonly engineFailures = new Map<string, Failure>();
  private readonly since = new Map<string, string>();
  private readonly told = new Map<string, Set<string>>();
  private readonly views = new Map<string, WorkOutage>();
  private readonly projectOutages = new Map<string, Map<string, WorkOutageAlert>>();
  private adopted = false;
  private evaluated = false;
  private pending: Promise<void> = Promise.resolve();
  private queued = 0;
  private checking = false;
  private stopped = false;
  private readonly startedAt: number;
  private readonly connectedEngines = new Set<EngineId>();
  /**
   * The task keys of each member's waiting messages, kept for `PENDING_KEYS_TTL_MS` per project and
   * member (an empty set too): a task list asks `forTask` for every card, and reading the messages
   * again per card made a board with an engine outage unusable (thousands of cards times thousands
   * of messages). Only the outage mark can be that much behind; message delivery never reads this.
   */
  private readonly pendingKeys = new Map<string, { readAt: number; keys: ReadonlySet<string> }>();

  private readonly deps: OutageDependencies;

  constructor(deps: OutageDependencies) {
    this.deps = deps;
    this.startedAt = deps.ctx.now().getTime();
  }

  /** Ticks are skipped while a previous round is queued or running. Targeted checks are serialized. */
  async check(_opts?: { refresh?: boolean }): Promise<void> {
    if (this.checking || this.queued > 0 || this.stopped) return;
    this.checking = true;
    try {
      await this.enqueue(async () => {
        await this.run();
      });
    } finally {
      this.checking = false;
    }
  }

  recheck(target: Target): Promise<void> {
    return this.enqueue(async () => {
      await this.run(target);
    });
  }

  /** The provider's key or setup changed (a NanoGPT key): the places that stopped get one more try (PM-1335). */
  recheckProvider(provider: AgentProvider): Promise<void> {
    this.deps.startFailures.release({ provider });
    return this.enqueue(async () => {
      await this.run(provider);
    });
  }

  engineChanged(id: EngineId, online: boolean): Promise<void> {
    if (online) {
      this.connectedEngines.add(id);
      // The counts of a place on an engine that was away are not the member's fault (PM-1335).
      this.deps.startFailures.release({ engineId: id });
    }
    return this.enqueue(async () => {
      let ended = false;
      try {
        ended = await this.run({ kind: 'engine', engineId: id });
      } finally {
        // Reconnect releases work even when publishing an outage update fails.
        if (online && this.deps.engines.get(id) && !ended) {
          try {
            await this.deps.messageRouter.releaseForEngine(id);
          } finally {
            this.deps.retry();
          }
        }
      }
    });
  }

  observeRefusal(
    projectKey: string,
    handle: string,
    code: string,
    details?: Record<string, unknown>,
  ): Promise<void> {
    if (!isOutageRefusal(code)) return Promise.resolve();
    return this.enqueue(async () => {
      const entry = this.targets().find((t) => t.projectKey === projectKey && t.member.handle === handle);
      if (!entry) return;
      const target = entry.target;
      await this.run(
        target,
        isSetupRefusal(code) || isStartFailing(code)
          ? {
              key: memberKey(projectKey, handle),
              problem: providerOutageProblemOf(code, details)!,
            }
          : undefined,
      );
    });
  }

  /** A member's place stopped at the start failure limit (PM-1335): the provider outage that tells people. */
  startFailureStopped(projectKey: string, handle: string, hold: StartHold): Promise<void> {
    if (hold.code !== 'start_failing') return Promise.resolve();
    return this.observeRefusal(projectKey, handle, 'start_failing', {
      provider: hold.provider,
      failures: hold.failures,
      ...(hold.engineId ? { engine: hold.engineId } : {}),
    });
  }

  observeAuthError(
    _projectKey: string,
    _handle: string,
    provider: AgentProvider,
    engineId: EngineId,
  ): Promise<void> {
    return this.recheck({
      kind: 'provider',
      provider,
      engineId: engineId === LOCAL_ENGINE_ID ? null : engineId,
    });
  }

  /** A renamed member's failures were recorded under its old handle (PM-1025); the next check records them again. */
  configChanged(change: { projectKey: string; renames?: Readonly<Record<string, string>> }): void {
    for (const from of Object.keys(change.renames ?? {})) {
      const key = memberKey(change.projectKey, from);
      for (const memory of [this.failures, this.engineFailures, this.views]) memory.delete(key);
    }
  }

  forMember(projectKey: string, handle: string): WorkOutage | undefined {
    return this.views.get(memberKey(projectKey, handle));
  }

  /** Null until the first evaluation; then includes episodes whose owner alert was acknowledged. */
  activeIds(projectKey: string): ReadonlySet<string> | null {
    if (!this.evaluated) return null;
    return new Set(this.projectOutages.get(projectKey)?.keys() ?? []);
  }

  /** What the outage is now (its members and cards); null when it is over or not known yet. */
  factsOf(projectKey: string, outageId: string): WorkOutageAlert | null {
    return this.projectOutages.get(projectKey)?.get(outageId) ?? null;
  }

  forTask(task: Task): WorkOutage | undefined {
    const candidates: WorkOutage[] = [];
    const outages = this.projectOutages.get(task.projectKey);
    if (!outages) return undefined;
    const waiting = this.deps.deferred.waitingFor(task);
    if (waiting) {
      const entry = this.deps.deferred.list().find((entry) => entry.waiting === waiting);
      const outage = this.outageForWaiting(
        task.projectKey,
        waiting.reason,
        waiting.member ?? entry?.start.waitsFor(),
        waiting.engine,
      );
      if (outage) candidates.push(outage);
    }
    for (const payload of outages.values()) {
      if (
        payload.outage.kind === 'engine' &&
        payload.members.some((handle) => this.pendingTaskKeysOf(task.projectKey, handle).has(task.key))
      )
        candidates.push(payload.outage);
    }
    return candidates.sort((a, b) => a.since.localeCompare(b.since))[0];
  }

  private pendingTaskKeysOf(projectKey: string, handle: string): ReadonlySet<string> {
    const key = memberKey(projectKey, handle);
    const now = this.deps.ctx.now().getTime();
    const cached = this.pendingKeys.get(key);
    // Card-by-card work awaits between cards, so the keys live for a short window instead of one
    // pass; an outage mark a moment late is harmless.
    if (cached && now >= cached.readAt && now - cached.readAt < PENDING_KEYS_TTL_MS) return cached.keys;
    const keys = new Set(this.deps.messageRouter.pendingTaskKeys(projectKey, handle));
    this.pendingKeys.set(key, { readAt: now, keys });
    return keys;
  }

  async checkNow(projectKey: string, itemId: string, access: ProjectAccess): Promise<CheckOutageResponse> {
    const item = this.deps.inbox.get(projectKey, itemId);
    if (item.state !== 'open') throw conflict('inbox_item_closed', 'the inbox item is closed');
    const payload = alertPayloadOf(item);
    if (payload?.alert !== 'work_outage')
      throw conflict('not_an_outage_alert', 'the item is not an outage alert');
    const config = await this.deps.projects.config(projectKey);
    if (!item.assignees.includes(access.handle) && !ownerHandles(config).includes(access.handle))
      throw forbidden('not_an_assignee', 'the item is not assigned to this member');
    // A person asks for the check of failing starts: the stopped places get one more try, and the outage ends with it (PM-1335).
    if (payload.outage.kind === 'provider' && payload.outage.problem === 'start_failing')
      this.deps.startFailures.release({
        provider: payload.outage.provider,
        engineId: payload.outage.engine?.id ?? null,
      });
    await this.recheck(this.targetOf(payload.outage));
    const checkedAt = isoNow(this.deps.ctx);
    let updated = this.deps.inbox.get(projectKey, itemId);
    if (updated.state === 'open')
      updated = this.deps.inbox.updateOpenPayload(itemId, { ...updated.payload, checkedAt }) ?? updated;
    return { item: updated, stillFailing: updated.resolution?.rule !== 'outage_ended', checkedAt };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.pending;
  }

  private enqueue(action: () => Promise<void>): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.queued++;
    const next = this.pending.then(action).finally(() => {
      this.queued--;
    });
    this.pending = next.catch((err) => this.deps.ctx.logger.warn({ err }, 'outage check failed'));
    return next;
  }

  private targets(): MemberTarget[] {
    return this.deps.projects.summaries().flatMap(({ key }) => {
      const config = this.deps.projects.cachedConfig(key);
      if (!config) return [];
      return config.team.members.flatMap((member): MemberTarget[] => {
        if (member.kind !== 'ai' || isOnLeave(member)) return [];
        const engineId = this.deps.engines.engineFor(key, member.handle);
        const connected = engineId !== null && !!this.deps.engines.get(engineId);
        if (connected && engineId !== null) this.connectedEngines.add(engineId);
        const target: Target = !connected
          ? { kind: 'engine', engineId }
          : {
              kind: 'provider',
              provider: member.provider ?? DEFAULT_AGENT_PROVIDER,
              engineId: engineId === LOCAL_ENGINE_ID ? null : engineId,
            };
        return [{ projectKey: key, member, target }];
      });
    });
  }

  private targetOf(outage: WorkOutage): Target {
    return outage.kind === 'engine'
      ? { kind: 'engine', engineId: outage.engine?.id ?? null }
      : { kind: 'provider', provider: outage.provider, engineId: outage.engine?.id ?? null };
  }

  private adopt(): void {
    if (this.adopted) return;
    this.adopted = true;
    for (const { key } of this.deps.projects.summaries()) {
      for (const item of this.deps.inbox.list(key, { state: 'open', kind: 'alert' })) {
        const payload = alertPayloadOf(item);
        if (payload?.alert !== 'work_outage') continue;
        const previous = this.since.get(payload.outage.id);
        if (!previous || payload.outage.since < previous)
          this.since.set(payload.outage.id, payload.outage.since);
        this.toldFor(key).add(payload.outage.id);
        for (const handle of payload.members) {
          const entry = this.targets().find(
            (entry) => entry.projectKey === key && entry.member.handle === handle,
          );
          (payload.outage.kind === 'engine' ? this.engineFailures : this.failures).set(
            memberKey(key, handle),
            {
              outage: payload.outage,
              setup:
                payload.outage.kind === 'provider' &&
                (payload.outage.problem === 'setup_incomplete' ||
                  payload.outage.problem === 'start_failing' ||
                  (!!entry && this.hasSetupWait(entry, payload.outage.problem)))
                  ? payload.outage.problem
                  : null,
            },
          );
        }
      }
    }
  }

  private async run(
    target?: Target | AgentProvider,
    setup?: { key: string; problem: ProviderOutageProblem },
  ): Promise<boolean> {
    this.adopt();
    let targets = this.targets();
    let memberRecovered = false;
    const selected = target
      ? targets.filter((entry) => {
          const current = this.failures.get(memberKey(entry.projectKey, entry.member.handle));
          if (typeof target === 'string') return (entry.member.provider ?? DEFAULT_AGENT_PROVIDER) === target;
          const engine = this.engineFailures.get(memberKey(entry.projectKey, entry.member.handle));
          return (
            outageIdOf(entry.target) === outageIdOf(target) ||
            current?.outage.id === outageIdOf(target) ||
            (target.kind === 'engine' &&
              (entry.target.engineId === target.engineId || engine?.outage.engine === null))
          );
        })
      : targets;
    await Promise.all(
      selected.map(async (entry) => {
        const key = memberKey(entry.projectKey, entry.member.handle);
        if (entry.target.kind === 'engine') {
          const id = entry.target.engineId;
          // A remote link needs time to reconnect after the server starts. Unknown keeps adopted alerts.
          if (
            id !== null &&
            id !== LOCAL_ENGINE_ID &&
            !this.connectedEngines.has(id) &&
            this.deps.ctx.now().getTime() - this.startedAt < ENGINE_OFFLINE_AFTER_MS
          )
            return;
          this.engineFailures.set(key, { outage: this.makeOutage(entry.target), setup: null });
          return;
        }
        let old = this.failures.get(key);
        // A connected engine proves its own recovery even if its provider check cannot tell.
        this.engineFailures.delete(key);
        if (typeof target === 'object' && target.kind === 'engine') return;
        if (old && old.outage.id !== outageIdOf(entry.target)) {
          this.failures.delete(key);
          old = undefined;
        }
        const status = await this.status(entry);
        // The provider changed since the places stopped (a new CLI version, or the login is gone): they get one more try.
        if (old?.setup === 'start_failing' && status && this.providerChanged(old.outage, status))
          this.deps.startFailures.release({
            provider: entry.target.provider,
            engineId: entry.target.engineId,
          });
        if (status?.loggedIn === false) {
          this.failures.set(key, {
            outage: this.makeOutage(entry.target, status),
            setup: old?.setup ?? null,
          });
        } else if (setup?.key === key && status?.loggedIn === true) {
          this.failures.set(key, {
            outage: this.makeOutage(entry.target, { ...status, problem: setup.problem }),
            setup: setup.problem,
          });
        } else if (
          status?.loggedIn === true &&
          old?.setup &&
          old.setup !== 'start_failing' &&
          this.hasSetupWait(entry, old.setup)
        ) {
          this.failures.set(key, {
            outage: this.makeOutage(entry.target, { ...status, problem: old.setup }),
            setup: old.setup,
          });
        } else if (
          (!old?.setup || old.setup === 'start_failing') &&
          this.hasSetupWait(entry, 'start_failing')
        ) {
          // The places stopped at the limit of failed starts; the provider need not tell its state (PM-1335).
          this.failures.set(key, {
            outage: this.makeOutage(entry.target, { ...status, problem: 'start_failing' }),
            setup: 'start_failing',
          });
        } else if (status?.loggedIn === true) {
          this.failures.delete(key);
          if (old) memberRecovered = true;
        } else if (old?.setup && !this.hasSetupWait(entry, old.setup)) {
          // The deferral ending proves that this hidden setup failure no longer holds work.
          this.failures.delete(key);
          memberRecovered = true;
        }
      }),
    );
    // Configuration and engine choices may have changed while a remote check was pending.
    targets = this.targets();
    const active = new Set(targets.map((entry) => memberKey(entry.projectKey, entry.member.handle)));
    for (const key of this.failures.keys()) if (!active.has(key)) this.failures.delete(key);
    for (const key of this.engineFailures.keys()) if (!active.has(key)) this.engineFailures.delete(key);
    for (const entry of targets) {
      const key = memberKey(entry.projectKey, entry.member.handle);
      const failure = this.failures.get(key);
      if (failure && !this.uses(entry, failure.outage)) this.failures.delete(key);
    }
    const ended = await this.evaluate(targets);
    if (memberRecovered && !ended) this.deps.retry();
    return ended || memberRecovered;
  }

  private async status(entry: MemberTarget): Promise<ProviderStatus | null> {
    const target = entry.target;
    if (target.kind !== 'provider') return null;
    return waitForStatus(
      () =>
        this.deps.runner.providerStatus?.(target.provider, {
          refresh: true,
          member: entry.member.handle,
          ...(entry.target.engineId ? { engineId: entry.target.engineId } : {}),
        }) ?? Promise.resolve(null),
    );
  }

  /** Whether the provider's state changed since the outage (PM-1335): another CLI version, or the login is gone. */
  private providerChanged(outage: WorkOutage, status: ProviderStatus): boolean {
    if (status.loggedIn === false) return true;
    return (
      outage.kind === 'provider' &&
      !!status.cliVersion &&
      !!outage.cliVersion &&
      status.cliVersion !== outage.cliVersion
    );
  }

  /**
   * Whether the hidden setup failure of `problem` still holds work: a start waits for the setup, or (for
   * `start_failing`) a place of the member stopped at the limit of failed starts.
   */
  private hasSetupWait(entry: MemberTarget, problem: ProviderOutageProblem): boolean {
    if (problem === 'start_failing')
      return this.deps.startFailures.stoppedFor(entry.projectKey, entry.member.handle);
    return (
      this.deps.deferred
        .list()
        .some(
          ({ start, waiting }) =>
            start.projectKey === entry.projectKey &&
            (waiting.member ?? start.waitsFor()) === entry.member.handle &&
            isSetupRefusal(waiting.reason) &&
            start.stillValid(start.taskKey ? this.deps.ctx.repos.tasks.get(start.taskKey) : null),
        ) ||
      this.deps.deferred
        .queueWaits()
        .some(
          ({ projectKey, waiting }) =>
            projectKey === entry.projectKey &&
            waiting.member === entry.member.handle &&
            isSetupRefusal(waiting.reason),
        )
    );
  }

  private makeOutage(
    target: Target,
    status?: { problem?: ProviderOutageProblem; cliVersion?: string; minCliVersion?: string },
  ): WorkOutage {
    const id = outageIdOf(target);
    const since = this.since.get(id) ?? isoNow(this.deps.ctx);
    this.since.set(id, since);
    const engine = target.engineId
      ? { id: target.engineId, name: this.deps.engineName?.(target.engineId) ?? target.engineId }
      : null;
    return target.kind === 'engine'
      ? { kind: 'engine', id, engine, since }
      : {
          kind: 'provider',
          id,
          engine,
          since,
          provider: target.provider,
          problem: status?.problem ?? 'not_logged_in',
          ...(status?.cliVersion ? { cliVersion: status.cliVersion } : {}),
          ...(status?.minCliVersion ? { minCliVersion: status.minCliVersion } : {}),
        };
  }

  private outageForWaiting(
    projectKey: string,
    reason: string,
    handle?: string,
    engineId?: string,
  ): WorkOutage | undefined {
    if (!isOutageRefusal(reason)) return undefined;
    const outages = this.projectOutages.get(projectKey);
    if (reason === 'engine_offline') {
      const payload = outages?.get(outageIdOf({ kind: 'engine', engineId: engineId ?? null }));
      return handle && payload?.members.includes(handle) ? payload.outage : undefined;
    }
    const outage = handle ? this.failures.get(memberKey(projectKey, handle))?.outage : undefined;
    return outage && outages?.has(outage.id) ? outage : undefined;
  }

  private toldFor(key: string): Set<string> {
    let ids = this.told.get(key);
    if (!ids) {
      ids = new Set();
      this.told.set(key, ids);
    }
    return ids;
  }

  private async evaluate(targets: MemberTarget[]): Promise<boolean> {
    const previousViews = new Map(this.views);
    const previousProjects = new Map(this.projectOutages);
    this.views.clear();
    this.projectOutages.clear();
    for (const entry of targets) {
      const key = memberKey(entry.projectKey, entry.member.handle);
      const failures = [this.engineFailures.get(key), this.failures.get(key)].filter(
        (failure): failure is Failure => !!failure,
      );
      if (!failures.length) continue;
      for (const failure of failures)
        failure.outage = {
          ...failure.outage,
          since: this.since.get(failure.outage.id) ?? failure.outage.since,
        };
      this.views.set(key, failures[0]!.outage);
      let groups = this.projectOutages.get(entry.projectKey);
      if (!groups) {
        groups = new Map();
        this.projectOutages.set(entry.projectKey, groups);
      }
      for (const failure of failures) {
        let payload = groups.get(failure.outage.id);
        if (!payload) {
          payload = {
            alert: 'work_outage',
            outage: failure.outage,
            members: [],
            tasks: [],
            checkedAt: isoNow(this.deps.ctx),
          };
          groups.set(failure.outage.id, payload);
        }
        payload.members.push(entry.member.handle);
      }
    }
    let ended = false;
    const recoveredEngines = new Set<EngineId>();
    for (const { key } of this.deps.projects.summaries()) {
      if (!this.deps.projects.cachedConfig(key)) continue;
      const groups = this.projectOutages.get(key) ?? new Map<string, WorkOutageAlert>();
      for (const payload of groups.values()) {
        payload.members.sort();
        const keys = new Set<string>();
        for (const { start, waiting } of this.deps.deferred.list()) {
          if (
            start.projectKey !== key ||
            !start.taskKey ||
            !start.stillValid(this.deps.ctx.repos.tasks.get(start.taskKey))
          )
            continue;
          if (
            this.outageForWaiting(key, waiting.reason, waiting.member ?? start.waitsFor(), waiting.engine)
              ?.id === payload.outage.id
          )
            keys.add(start.taskKey);
        }
        for (const { projectKey, taskKey, waiting } of this.deps.deferred.queueWaits()) {
          if (
            projectKey === key &&
            taskKey &&
            this.outageForWaiting(key, waiting.reason, waiting.member, waiting.engine)?.id ===
              payload.outage.id
          )
            keys.add(taskKey);
        }
        if (payload.outage.kind === 'engine')
          for (const handle of payload.members)
            for (const taskKey of this.deps.messageRouter.pendingTaskKeys(key, handle)) keys.add(taskKey);
        payload.tasks = [...keys].sort((a, b) => taskSeq(a) - taskSeq(b));
      }
      const open = this.deps.inbox.list(key, { state: 'open', kind: 'alert' }).flatMap((item) => {
        const payload = alertPayloadOf(item);
        return payload?.alert === 'work_outage' ? [{ item, payload }] : [];
      });
      const oldIds = new Set([
        ...this.toldFor(key),
        ...(previousProjects.get(key)?.keys() ?? []),
        ...open.map(({ payload }) => payload.outage.id),
      ]);
      for (const id of oldIds) {
        if (groups.has(id)) continue;
        const old =
          open.find(({ payload }) => payload.outage.id === id)?.payload ?? previousProjects.get(key)?.get(id);
        const used =
          old &&
          targets.some(
            (entry) =>
              entry.projectKey === key &&
              old.members.includes(entry.member.handle) &&
              this.uses(entry, old.outage),
          );
        for (const { item } of open.filter(({ payload }) => payload.outage.id === id)) {
          if (used) {
            this.deps.inbox.updateOpenPayload(item.id, { ...item.payload, checkedAt: isoNow(this.deps.ctx) });
            this.deps.inbox.resolveByRule(item.id, 'seen', 'outage_ended');
          } else this.deps.inbox.cancel(item.id);
        }
        if (used && old.outage.kind === 'engine' && old.outage.engine)
          recoveredEngines.add(old.outage.engine.id);
        if (used && old.outage.kind === 'engine' && !old.outage.engine) {
          for (const entry of targets.filter(
            (entry) => entry.projectKey === key && old.members.includes(entry.member.handle),
          )) {
            const engineId = this.deps.engines.engineFor(key, entry.member.handle);
            if (engineId) recoveredEngines.add(engineId);
          }
        }
        if (used) ended = true;
        this.toldFor(key).delete(id);
        await this.deps.ctx.events.emit('work_outage_ended', { projectKey: key, outageId: id });
      }
      for (const payload of groups.values()) {
        const existing = open.find(({ payload: old }) => old.outage.id === payload.outage.id);
        if (existing) {
          const { checkedAt: _, ...old } = existing.payload;
          const { checkedAt: __, ...current } = WorkOutageAlert.parse(payload);
          if (JSON.stringify(old) !== JSON.stringify(current))
            this.deps.inbox.updateOpenPayload(existing.item.id, payload);
        } else if (!this.toldFor(key).has(payload.outage.id)) {
          // The route rule sends a new outage to the project manager as a signal; it opens no inbox item.
          this.deps.inbox.raiseAlert({ projectKey: key, title: this.title(payload.outage), payload });
          this.toldFor(key).add(payload.outage.id);
        }
      }
      const changedMembers = new Set(
        [...previousViews.keys(), ...this.views.keys()]
          .filter(
            (id) =>
              id.startsWith(`${key}:`) &&
              JSON.stringify(previousViews.get(id)) !== JSON.stringify(this.views.get(id)),
          )
          .map((id) => id.slice(key.length + 1)),
      );
      if (changedMembers.size) await this.deps.members.publishMembers(key, [...changedMembers]);
      const taskKeys = new Set(
        [...(previousProjects.get(key)?.values() ?? []), ...groups.values()].flatMap(
          (payload) => payload.tasks,
        ),
      );
      for (const taskKey of taskKeys) {
        const task = this.deps.ctx.repos.tasks.get(taskKey);
        if (task) this.deps.tasks.publish(task);
      }
    }
    this.evaluated = true;
    for (const id of this.since.keys())
      if (
        ![...this.failures.values(), ...this.engineFailures.values()].some(
          (failure) => failure.outage.id === id,
        )
      )
        this.since.delete(id);
    for (const engineId of recoveredEngines) await this.deps.messageRouter.releaseForEngine(engineId);
    if (ended) this.deps.retry();
    return ended;
  }

  private uses(entry: MemberTarget, outage: WorkOutage): boolean {
    if (outage.kind === 'engine') {
      // No selected engine recovers when a member acquires any connected engine.
      return (
        outage.engine === null ||
        this.deps.engines.engineFor(entry.projectKey, entry.member.handle) === outage.engine.id
      );
    }
    return (
      (entry.member.provider ?? DEFAULT_AGENT_PROVIDER) === outage.provider &&
      this.deps.engines.engineFor(entry.projectKey, entry.member.handle) ===
        (outage.engine?.id ?? LOCAL_ENGINE_ID)
    );
  }

  private title(outage: WorkOutage): string {
    if (outage.kind === 'engine')
      return outage.engine ? `Engine "${outage.engine.name}" is not connected` : 'No engine is connected';
    const label = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', nanogpt: 'NanoGPT' }[outage.provider];
    const problem = {
      not_logged_in: 'is not logged in',
      no_key: 'has no API key',
      cli_too_old: 'CLI needs an update',
      cli_missing: 'CLI is not installed',
      chatgpt_login: 'needs a ChatGPT login',
      setup_incomplete: 'setup is incomplete',
      start_failing: 'sessions keep failing to start',
    }[outage.problem];
    return `${label} ${problem}`;
  }
}
