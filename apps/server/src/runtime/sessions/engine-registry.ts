import { createHash, randomBytes } from 'node:crypto';
import { assertSuperMutation } from '../../kernel';
import { EngineProvider, canSeeEngine, canSeeEngineMachine, projectEngineOf } from '@projectman/shared';
import type {
  CreateEngineResponse,
  EngineId,
  EngineStatusView,
  EngineView,
  ProjectEngineBinding,
  ProjectEngineView,
} from '@projectman/shared';
import { z } from 'zod';
import type { EventBus } from '../../contracts';
import type { EngineRecord, Repositories } from '../../db';
import { conflict, DomainError } from '../../kernel';

const StoredHello = z.object({
  hostname: z.string(),
  platform: z.enum(['darwin', 'linux']),
  version: z.string(),
  providers: z.array(EngineProvider),
  /** PM-1068: 'engine' when the engine holds its own NanoGPT key file; the key itself never reaches the cloud. */
  nanogptKey: z.literal('engine').optional(),
});
export type EngineHelloMetadata = z.infer<typeof StoredHello>;
export const machineKeyHash = (key: string): string => createHash('sha256').update(key).digest('hex');

/**
 * A new engine identity: the id, the machine key (shown once) and what the registry stores of it. One
 * place makes them: the registry (`create`) and the move to the hybrid mode (PM-318, which makes the key
 * on the Mac and carries only the hash to the cloud).
 */
export function newMachineKey(): { id: EngineId; key: string; hash: string; prefix: string } {
  const key = `pme_${randomBytes(32).toString('base64url')}`;
  return {
    id: `eng_${randomBytes(6).toString('hex')}`,
    key,
    hash: machineKeyHash(key),
    prefix: key.slice(0, 10),
  };
}

/** What the cloud counts per engine for the settings view (PM-315): sessions and what waits for it. */
export interface EngineCounters {
  runningSessions: number;
  waitingStarts: number;
  waitingMessages: number;
}

/** Who asks for engines: the user and the keys of the projects they are a member of. */
export interface EngineViewer {
  userId: string;
  projectKeys: readonly string[];
}

/** Cloud registry. Secrets are returned once; only their hashes and display prefixes persist. */
export class EngineRegistry {
  private readonly online = new Set<EngineId>();
  private readonly revokeListeners = new Set<(id: EngineId) => void>();
  private readonly onlineListeners = new Set<(id: EngineId, online: boolean) => void>();
  private counters: (id: EngineId) => EngineCounters = () => ({
    runningSessions: 0,
    waitingStarts: 0,
    waitingMessages: 0,
  });
  private wake: (projectKey: string) => void = () => {};
  private projectOwners: (projectKey: string) => string[] = () => [];
  private projectHolds: (id: EngineId, projectKey: string) => boolean = () => false;
  private isHostOwner: (userId: string) => boolean = () => false;
  private readonly projectEngineListeners = new Set<(projectKey: string) => void>();
  private readonly repos: Repositories;
  private readonly bus: EventBus;
  private readonly version: string;
  private readonly now: () => Date;

  constructor(options: { repos: Repositories; bus: EventBus; version: string; now?: () => Date }) {
    this.repos = options.repos;
    this.bus = options.bus;
    this.version = options.version;
    this.now = options.now ?? (() => new Date());
  }

  /** `viewerUserId`: the caller, who is told whether the engine is theirs (`ownedByMe`); without one the field is absent. */
  private view(row: EngineRecord, viewerUserId?: string): EngineView {
    const hello = row.last_hello ? StoredHello.parse(JSON.parse(row.last_hello)) : null;
    return {
      ...(viewerUserId === undefined ? {} : { ownedByMe: row.created_by === viewerUserId }),
      id: row.id,
      name: row.name,
      isDefault: !!row.is_default,
      online: !row.revoked_at && this.online.has(row.id),
      lastSeenAt: row.last_seen_at,
      keyPrefix: row.key_prefix,
      createdAt: row.created_at,
      createdBy: row.creator_name,
      revokedAt: row.revoked_at,
      lastSeenIp: row.last_seen_ip,
      hostname: hello?.hostname ?? null,
      platform: hello?.platform ?? null,
      version: hello?.version ?? null,
      versionMismatch: !!hello && hello.version !== this.version,
      providers: hello?.providers ?? [],
      ...this.counters(row.id),
    };
  }

  /** The domain provides the counters once it exists (the registry is built before it). */
  useCounters(counters: (id: EngineId) => EngineCounters): void {
    this.counters = counters;
  }

  /** The user ids of the project's `owner` members; the domain provides them (the project configuration is its). */
  useProjectOwners(owners: (projectKey: string) => string[]): void {
    this.projectOwners = owners;
  }

  /** Whether the engine's `hello` lists the project (a folder of it on the machine); the link layer provides it. */
  useProjectHolds(holds: (id: EngineId, projectKey: string) => boolean): void {
    this.projectHolds = holds;
  }

  /** Whether the user is the chopper's host owner; the auth module provides it (PM-1061). Until then nobody is. */
  useHostOwner(isHostOwner: (userId: string) => boolean): void {
    this.isHostOwner = isHostOwner;
  }

  /** The machine-wide default engine: the one that is not revoked and is marked default; null when there is none. */
  defaultId(): EngineId | null {
    return this.defaultRecord()?.id ?? null;
  }

  /**
   * The host's machine: the default engine while the host owner owns it (PM-1061). The machine display, the
   * administration and the builds go only here; a default engine of another owner is nobody's host machine.
   */
  hostEngine(): EngineId | null {
    const row = this.defaultRecord();
    return row && this.isHostOwner(row.created_by) ? row.id : null;
  }

  /** The engine belongs to the host owner: the only kind that may be given the host's secrets. */
  ownedByHost(id: EngineId): boolean {
    const owner = this.ownerOf(id);
    return owner !== null && this.isHostOwner(owner);
  }

  /** The engine's latest hello said it holds its own NanoGPT key (PM-1068): it needs nothing from the cloud for NanoGPT. */
  ownNanogptKey(id: EngineId): boolean {
    const row = this.repos.engines.get(id);
    if (!row?.last_hello) return false;
    return StoredHello.parse(JSON.parse(row.last_hello)).nanogptKey === 'engine';
  }

  /** The project's work may go to this engine: it is bound to the project, or it is the project's fallback engine. */
  isBound(id: EngineId, projectKey: string): boolean {
    if (this.projectEngine(projectKey) === id) return true;
    return this.projectBindings(projectKey).some((binding) => binding.engineId === id && !binding.revoked);
  }

  private defaultRecord(): EngineRecord | null {
    return this.repos.engines.list().find((row) => row.is_default && !row.revoked_at) ?? null;
  }

  /** The user id of the engine's owner (`engines.created_by`); null when there is no such engine. */
  ownerOf(id: EngineId): string | null {
    return this.repos.engines.get(id)?.created_by ?? null;
  }

  projectBindings(projectKey: string): ProjectEngineBinding[] {
    return this.repos.projectEngines.list(projectKey).map((row) => ({
      engineId: row.engine_id,
      isDefault: !!row.is_default,
      revoked: row.revoked_at !== null,
    }));
  }

  /** The engine the project's new session goes to (`projectEngineOf`): the binding, else the global default of its owners. */
  projectEngine(projectKey: string): EngineId | null {
    const fallback = this.defaultRecord();
    return projectEngineOf({
      bindings: this.projectBindings(projectKey),
      globalDefault: fallback ? { id: fallback.id, ownerUserId: fallback.created_by } : null,
      projectOwnerUserIds: this.projectOwners(projectKey),
      projectCreatedBy: this.repos.projects.get(projectKey)?.createdBy ?? null,
    });
  }

  /** Called after the project's engine choice may have changed (a write of its bindings, a revocation, a new global default). */
  onProjectEngineChange(listener: (projectKey: string) => void): () => void {
    this.projectEngineListeners.add(listener);
    return () => {
      this.projectEngineListeners.delete(listener);
    };
  }

  private projectEngineChanged(keys: Iterable<string>): void {
    for (const key of new Set(keys)) for (const listener of this.projectEngineListeners) listener(key);
  }

  /** The project's engines for a member: its bindings, or the fallback engine as the only, default one. */
  projectEngineViews(projectKey: string, viewerUserId: string): ProjectEngineView[] {
    const rows = this.repos.projectEngines.list(projectKey);
    const view = (engine: EngineRecord, isDefault: boolean): ProjectEngineView => ({
      id: engine.id,
      name: engine.name,
      online: !engine.revoked_at && this.online.has(engine.id),
      isDefault,
      holdsProject: this.projectHolds(engine.id, projectKey),
      ownedByMe: engine.created_by === viewerUserId,
    });
    if (rows.length === 0) {
      const fallback = this.projectEngine(projectKey);
      const engine = fallback ? this.repos.engines.get(fallback) : null;
      return engine ? [view(engine, true)] : [];
    }
    return rows.flatMap((row) => {
      const engine = this.repos.engines.get(row.engine_id);
      return engine ? [view(engine, !!row.is_default)] : [];
    });
  }

  /**
   * Binds the engine to the project (PM-1060); who may is the caller's to decide (`canBindEngine`). The
   * project's first binding is its default; later ones become default only when asked, and the old default
   * is taken off in the same transaction. Binding again changes nothing unless it makes the engine default.
   */
  bind(projectKey: string, engineId: EngineId, userId: string, options: { default?: boolean }): void {
    this.active(engineId);
    this.projectWrite(projectKey, engineId, () => {
      const existing = this.repos.projectEngines.list(projectKey);
      const bound = existing.find((row) => row.engine_id === engineId);
      const makeDefault = options.default === true || existing.length === 0;
      if (bound && (!makeDefault || bound.is_default)) return false;
      if (!bound) this.repos.projectEngines.insert({ projectKey, engineId, addedBy: userId, at: this.at() });
      if (makeDefault) this.repos.projectEngines.setDefault(projectKey, engineId);
      return true;
    });
  }

  /** Ends the binding. Refused while the project has a session on the engine, and for the default while another binding stays. */
  unbind(projectKey: string, engineId: EngineId): void {
    this.projectWrite(projectKey, engineId, () => {
      const bound = this.repos.projectEngines.get(projectKey, engineId);
      if (!bound) throw new DomainError('engine_not_found', 'The engine is not bound', { status: 404 });
      if (this.repos.projectEngines.hasOpenSession(projectKey, engineId))
        throw conflict('engine_in_use', 'The project has a session on this engine');
      if (bound.is_default && this.repos.projectEngines.list(projectKey).length > 1)
        throw conflict('engine_is_default', 'Make another engine the default first');
      this.repos.projectEngines.remove(projectKey, engineId);
      return true;
    });
  }

  /** One write of a project's bindings in one transaction with the project's journal entry, then the wake and the events. */
  private projectWrite(projectKey: string, engineId: EngineId, write: () => boolean): void {
    const changed = this.repos.transaction(() => {
      if (!write()) return false;
      this.repos.projectChanges.append(projectKey, 'engine', engineId, this.at());
      return true;
    });
    if (!changed) return;
    this.wake(projectKey);
    this.changed(engineId, projectKey);
    this.projectEngineChanged([projectKey]);
  }

  private at(): string {
    return this.now().toISOString();
  }

  /** Every engine that is not revoked. */
  ids(): EngineId[] {
    return this.repos.engines
      .list()
      .filter((row) => !row.revoked_at)
      .map((row) => row.id);
  }

  /** Connected, or disconnected for less than `ENGINE_OFFLINE_AFTER_MS` (the link's own timer sets it). */
  isOnline(id: EngineId): boolean {
    return this.online.has(id);
  }

  /** Called when the online flag changes (not for a change of the registry's other fields). */
  onOnlineChange(listener: (id: EngineId, online: boolean) => void): () => void {
    this.onlineListeners.add(listener);
    return () => {
      this.onlineListeners.delete(listener);
    };
  }

  list(): EngineView[] {
    return this.repos.engines.list().map((row) => this.view(row));
  }
  status(): EngineStatusView[] {
    return this.list()
      .filter((row) => !row.revokedAt)
      .map(({ id, name, isDefault, online, lastSeenAt }) => ({ id, name, isDefault, online, lastSeenAt }));
  }
  /**
   * The engines the projects have to do with (PM-1061): the fallback engine and every binding, a revoked one
   * too, so that the members still hear of its revocation (the status list leaves a revoked engine out).
   */
  private engineIdsOfProjects(projectKeys: readonly string[]): Set<EngineId> {
    const ids = new Set<EngineId>();
    for (const projectKey of projectKeys) {
      const fallback = this.projectEngine(projectKey);
      if (fallback) ids.add(fallback);
      for (const binding of this.projectBindings(projectKey)) ids.add(binding.engineId);
    }
    return ids;
  }

  /** The engines this viewer may see in the status list, as `EngineViewer` says; `projectKeys` are the viewer's projects. */
  private visibleRows(viewer: EngineViewer): EngineRecord[] {
    const viewerIsHostOwner = this.isHostOwner(viewer.userId);
    const ofProjects = this.engineIdsOfProjects(viewer.projectKeys);
    return this.repos.engines.list().filter((row) =>
      canSeeEngine({
        viewerUserId: viewer.userId,
        viewerIsHostOwner,
        engineOwnerUserId: row.created_by,
        usedByViewerProject: ofProjects.has(row.id),
      }),
    );
  }

  /** Whether the viewer may hear of / see this engine; the websocket asks per event. */
  canSee(id: EngineId, viewer: EngineViewer): boolean {
    return this.visibleRows(viewer).some((row) => row.id === id);
  }

  /** The status list for one viewer (PM-1061): the engines they may see, none revoked. */
  statusFor(viewer: EngineViewer): EngineStatusView[] {
    return this.visibleRows(viewer)
      .filter((row) => !row.revoked_at)
      .map((row) => this.view(row))
      .map(({ id, name, isDefault, online, lastSeenAt }) => ({ id, name, isDefault, online, lastSeenAt }));
  }

  /**
   * The management list for one viewer (PM-1061): the host owner sees every engine, anyone else their own.
   * The machine's name and address go only to the engine's owner and the host owner.
   */
  listFor(viewer: { userId: string }): EngineView[] {
    const viewerIsHostOwner = this.isHostOwner(viewer.userId);
    return this.repos.engines
      .list()
      .filter((row) => viewerIsHostOwner || row.created_by === viewer.userId)
      .map((row) => {
        const view = this.view(row, viewer.userId);
        const machine = canSeeEngineMachine({
          viewerUserId: viewer.userId,
          viewerIsHostOwner,
          engineOwnerUserId: row.created_by,
        });
        return machine ? view : { ...view, hostname: null, lastSeenIp: null };
      });
  }

  private active(id: string): EngineRecord {
    const row = this.repos.engines.get(id);
    if (!row) throw new DomainError('engine_not_found', 'Engine not found', { status: 404 });
    if (row.revoked_at) throw new DomainError('engine_revoked', 'Engine revoked', { status: 409 });
    return row;
  }
  /** Called with a project key once the registry has written the project's change journal (the readers wait on it). */
  useJournalWake(wake: (projectKey: string) => void): void {
    this.wake = wake;
  }

  /**
   * Runs a registry write and names it in the journal of every project it concerns (PM-761), in one
   * transaction: a rollback takes both. The projects that concern an engine are those with a session stored
   * on it, and all of them while it is the default (new sessions go to the default engine, whichever project
   * they belong to); the default before and after the write both count, so taking the default away from an
   * engine, or revoking the default, reaches the projects that used it. The online flag is memory, not
   * registry state, and is not journaled.
   */
  private journaled<T>(ids: EngineId[], write: () => T): T {
    const woken = new Set<string>();
    const result = this.repos.transaction(() => {
      const before = this.defaultId();
      const out = write();
      const defaults = [before, this.defaultId()];
      const at = this.now().toISOString();
      for (const id of ids) {
        const keys = new Set([
          ...this.repos.projectChanges.projectKeysOnEngine(id),
          ...this.repos.projectEngines.projectKeysOf(id),
        ]);
        if (defaults.includes(id)) for (const key of this.repos.projectChanges.projectKeys()) keys.add(key);
        for (const key of keys) {
          this.repos.projectChanges.append(key, 'engine', id, at);
          woken.add(key);
        }
      }
      return out;
    });
    for (const key of woken) this.wake(key);
    return result;
  }

  create(name: string, userId: string): CreateEngineResponse {
    assertSuperMutation(null, { kind: 'routine', operation: 'engine_create' });
    const { id, key, hash, prefix } = newMachineKey();
    const row = this.journaled([id], () =>
      this.repos.engines.create({ id, name, userId, hash, prefix, at: this.now().toISOString() }),
    );
    this.changed(id);
    return { engine: this.view(row, userId), key };
  }
  resolve(key: string): EngineId | null {
    if (!/^pme_[A-Za-z0-9_-]{43}$/.test(key)) return null;
    return this.repos.engines.resolve(machineKeyHash(key))?.id ?? null;
  }
  revoke(id: string, userId: string): EngineView {
    assertSuperMutation(null, { kind: 'remove', resource: 'engine', id });
    this.active(id);
    const wasDefault = this.defaultId() === id;
    this.journaled([id], () => this.repos.engines.revoke(id, userId, this.now().toISOString()));
    // A revoked engine stops counting as available now, and what waits for it is told.
    this.setOnline(id, false);
    for (const listener of this.revokeListeners) listener(id);
    this.changed(id);
    // The projects bound to it, and every project that fell back on it, now choose another engine (or none).
    this.projectEngineChanged(
      wasDefault ? this.repos.projectChanges.projectKeys() : this.repos.projectEngines.projectKeysOf(id),
    );
    return this.view(this.repos.engines.get(id)!, userId);
  }
  /** Renames an engine that is not revoked; the machine's hello brings no name, so the hub's is the only one (PM-1077). */
  rename(id: string, name: string, userId: string): EngineView {
    assertSuperMutation(null, { kind: 'routine', operation: 'engine_rename' });
    this.active(id);
    this.journaled([id], () => this.repos.engines.rename(id, name));
    this.changed(id);
    return this.view(this.repos.engines.get(id)!, userId);
  }
  setDefault(id: string): EngineView[] {
    assertSuperMutation(null, { kind: 'routine', operation: 'engine_default' });
    this.active(id);
    const previous = this.status().find((engine) => engine.isDefault)?.id;
    this.journaled(previous && previous !== id ? [previous, id] : [id], () =>
      this.repos.engines.setDefault(id),
    );
    if (previous && previous !== id) this.changed(previous);
    this.changed(id);
    // A project without a binding falls back on the global default.
    if (previous !== id) this.projectEngineChanged(this.repos.projectChanges.projectKeys());
    return this.list();
  }
  seen(id: EngineId, ip: string, hello?: EngineHelloMetadata): void {
    const row = this.active(id);
    const now = this.now();
    const helloJson = hello ? JSON.stringify(StoredHello.parse(hello)) : undefined;
    // The journal names the first sight of an engine and a changed hello; the refresh of the last-seen time
    // every minute is a heartbeat, and a journal that is never trimmed would grow by it for ever.
    const announce = !row.last_seen_at || (helloJson !== undefined && helloJson !== row.last_hello);
    this.journaled(announce ? [id] : [], () => {
      if (!row.last_seen_at || now.getTime() - Date.parse(row.last_seen_at) >= 60_000) {
        this.repos.engines.seen(id, now.toISOString(), ip, helloJson);
      } else if (helloJson !== undefined) {
        this.repos.engines.hello(id, helloJson);
      }
    });
    if (hello && this.online.has(id)) this.changed(id);
  }
  setOnline(id: EngineId, online: boolean): void {
    const before = this.online.has(id);
    if (online) this.online.add(id);
    else this.online.delete(id);
    if (before !== online) {
      this.changed(id);
      for (const listener of this.onlineListeners) listener(id, online);
    }
  }
  onRevoke(listener: (id: EngineId) => void): () => void {
    this.revokeListeners.add(listener);
    return () => {
      this.revokeListeners.delete(listener);
    };
  }
  private changed(id: EngineId, projectKey?: string): void {
    const row = this.repos.engines.get(id);
    if (!row) return;
    const { name, isDefault, online, lastSeenAt } = this.view(row);
    this.bus.publish({
      type: 'engine_changed',
      engine: { id, name, isDefault, online, lastSeenAt },
      ...(projectKey !== undefined ? { projectKey } : {}),
    });
  }
}
