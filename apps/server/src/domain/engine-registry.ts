import { createHash, randomBytes } from 'node:crypto';
import { EngineProvider } from '@projectman/shared';
import type { CreateEngineResponse, EngineId, EngineStatusView, EngineView } from '@projectman/shared';
import { z } from 'zod';
import type { EventBus } from '../contracts';
import type { EngineRecord, Repositories } from '../db';
import { DomainError } from './errors';

const StoredHello = z.object({
  hostname: z.string(),
  platform: z.enum(['darwin', 'linux']),
  version: z.string(),
  providers: z.array(EngineProvider),
});
export type EngineHelloMetadata = z.infer<typeof StoredHello>;
export const machineKeyHash = (key: string): string => createHash('sha256').update(key).digest('hex');

/** Cloud registry. Secrets are returned once; only their hashes and display prefixes persist. */
export class EngineRegistry {
  private readonly online = new Set<EngineId>();
  private readonly revokeListeners = new Set<(id: EngineId) => void>();
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
      runningSessions: 0,
      waitingStarts: 0,
      waitingMessages: 0,
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
  create(name: string, userId: string): CreateEngineResponse {
    const key = `pme_${randomBytes(32).toString('base64url')}`;
    const id = `eng_${randomBytes(6).toString('hex')}`;
    const row = this.repos.engines.create({
      id,
      name,
      userId,
      hash: machineKeyHash(key),
      prefix: key.slice(0, 10),
      at: this.now().toISOString(),
    });
    this.changed(id);
    return { engine: this.view(row), key };
  }
  resolve(key: string): EngineId | null {
    if (!/^pme_[A-Za-z0-9_-]{43}$/.test(key)) return null;
    return this.repos.engines.resolve(machineKeyHash(key))?.id ?? null;
  }
  revoke(id: string, userId: string): EngineView {
    this.active(id);
    this.repos.engines.revoke(id, userId, this.now().toISOString());
    this.online.delete(id);
    for (const listener of this.revokeListeners) listener(id);
    this.changed(id);
    return this.view(this.repos.engines.get(id)!);
  }
  setDefault(id: string): EngineView[] {
    this.active(id);
    const previous = this.status().find((engine) => engine.isDefault)?.id;
    this.repos.engines.setDefault(id);
    if (previous && previous !== id) this.changed(previous);
    this.changed(id);
    return this.list();
  }
  seen(id: EngineId, ip: string, hello?: EngineHelloMetadata): void {
    const row = this.active(id);
    const now = this.now();
    if (!row.last_seen_at || now.getTime() - Date.parse(row.last_seen_at) >= 60_000) {
      this.repos.engines.seen(
        id,
        now.toISOString(),
        ip,
        hello ? JSON.stringify(StoredHello.parse(hello)) : undefined,
      );
    } else if (hello) {
      this.repos.engines.hello(id, JSON.stringify(StoredHello.parse(hello)));
    }
    if (hello && this.online.has(id)) this.changed(id);
  }
  setOnline(id: EngineId, online: boolean): void {
    const before = this.online.has(id);
    if (online) this.online.add(id);
    else this.online.delete(id);
    if (before !== online) this.changed(id);
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
