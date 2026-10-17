import { createHash, randomBytes } from 'node:crypto';
import { assertSuperMutation } from '../../kernel';
import { EngineProvider } from '@projectman/shared';
import type { CreateEngineResponse, EngineId, EngineStatusView, EngineView } from '@projectman/shared';
import { z } from 'zod';
import type { EventBus } from '../../contracts';
import type { EngineRecord, Repositories } from '../../db';
import { DomainError } from '../../kernel';

const StoredHello = z.object({
  hostname: z.string(),
  platform: z.enum(['darwin', 'linux']),
  version: z.string(),
  providers: z.array(EngineProvider),
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

  private view(row: EngineRecord): EngineView {
    const hello = row.last_hello ? StoredHello.parse(JSON.parse(row.last_hello)) : null;
    return {
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

  /** The engine a new session goes to: the default one that is not revoked; null when there is none. */
  defaultId(): EngineId | null {
    return this.repos.engines.list().find((row) => row.is_default && !row.revoked_at)?.id ?? null;
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
        const keys = new Set(this.repos.projectChanges.projectKeysOnEngine(id));
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
    return { engine: this.view(row), key };
  }
  resolve(key: string): EngineId | null {
    if (!/^pme_[A-Za-z0-9_-]{43}$/.test(key)) return null;
    return this.repos.engines.resolve(machineKeyHash(key))?.id ?? null;
  }
  revoke(id: string, userId: string): EngineView {
    assertSuperMutation(null, { kind: 'remove', resource: 'engine', id });
    this.active(id);
    this.journaled([id], () => this.repos.engines.revoke(id, userId, this.now().toISOString()));
    // A revoked engine stops counting as available now, and what waits for it is told.
    this.setOnline(id, false);
    for (const listener of this.revokeListeners) listener(id);
    this.changed(id);
    return this.view(this.repos.engines.get(id)!);
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
  private changed(id: EngineId): void {
    const row = this.repos.engines.get(id);
    if (!row) return;
    const { name, isDefault, online, lastSeenAt } = this.view(row);
    this.bus.publish({ type: 'engine_changed', engine: { id, name, isDefault, online, lastSeenAt } });
  }
}
