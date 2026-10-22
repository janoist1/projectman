import { createHash, randomUUID } from 'node:crypto';
import {
  canSeeInboxItem,
  deviceLabelOf,
  isAllowedPushEndpoint,
  isPushableItem,
  pushCategoryOf,
  quietWindowAt,
} from '@projectman/shared';
import type {
  InboxItem,
  ProjectConfig,
  PushPayload,
  PushSettings,
  SubscribePushRequest,
} from '@projectman/shared';
import { hu } from '@projectman/templates';
import type { FastifyBaseLogger } from 'fastify';
import type { PushSendOutcome, PushTransport } from '../../contracts';
import type { PresenceService } from '../../core/members';
import { projectAccessFor } from '../../core/members';
import { pushDeviceView } from '../../db';
import type { PushDeviceRecord, Repositories } from '../../db';
import { conflict, DomainError, invalid, notFound, unavailable } from '../../kernel';
import { loadOrCreateVapidKey, vapidKeyId } from './secret';
import { createPushTransport } from './transport';

interface WebPushOptions {
  home?: string;
  enabled?: boolean;
  standby?: boolean;
  subject?: string;
  transport?: PushTransport;
  repos: Repositories;
  presence: PresenceService;
  config: (key: string) => Promise<ProjectConfig>;
  logger: FastifyBaseLogger;
  now?: () => Date;
}
const endpointHash = (endpoint: string) => createHash('sha256').update(endpoint).digest('hex');
function subjectIsValid(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'mailto:' || (url.protocol === 'https:' && !url.username && !url.password);
  } catch {
    return false;
  }
}

export function createWebPushService(opts: WebPushOptions) {
  const now = opts.now ?? (() => new Date());
  const repo = opts.repos.webPush;
  const key = opts.enabled !== false && !opts.standby && opts.home ? loadOrCreateVapidKey(opts.home) : null;
  const keyId = key ? vapidKeyId(key.publicKey) : null;
  const transport = opts.transport ?? createPushTransport();
  if (opts.subject && !subjectIsValid(opts.subject))
    throw new Error('Invalid web push subject; expected mailto: or https:.');
  if (keyId) repo.expireOtherKeys(keyId, now().toISOString());
  const testTimes = new Map<string, number>();
  let lastPruned = 0;
  let sweeping: Promise<void> | undefined;
  const available = () => {
    if (!key) throw unavailable('web_push_unavailable', 'Web push is unavailable');
    return key;
  };
  const device = (userId: string, id: string) => {
    const row = repo.device(userId, id);
    if (!row) throw notFound('push device', id);
    return row;
  };
  const active = (userId: string) => repo.devices(userId).filter((d) => d.state === 'active' && d.enabled);

  async function send(row: PushDeviceRecord, payload: PushPayload): Promise<void> {
    if (!key || !keyId) return;
    if (row.vapid_key_id !== keyId) {
      repo.expireOtherKeys(keyId, now().toISOString());
      return;
    }
    const subject = opts.subject ?? row.origin;
    let outcome: PushSendOutcome;
    if (
      !row.endpoint ||
      !row.p256dh ||
      !row.auth ||
      !isAllowedPushEndpoint(row.endpoint) ||
      !subject ||
      !subjectIsValid(subject)
    ) {
      outcome = { result: 'failed', failure: 'rejected' };
    } else {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        outcome = await Promise.race([
          Promise.resolve().then(() =>
            transport.send({
              endpoint: row.endpoint!,
              keys: { p256dh: row.p256dh!, auth: row.auth! },
              payload: JSON.stringify(payload),
              ttlSeconds: 86400,
              urgency: payload.kind === 'digest' ? 'normal' : 'high',
              vapid: { subject, publicKey: key!.publicKey, privateKey: key!.privateKey },
              timeoutMs: 10000,
            }),
          ),
          new Promise<PushSendOutcome>((resolve) => {
            timer = setTimeout(() => resolve({ result: 'failed', failure: 'timeout' }), 10000);
          }),
        ]);
      } catch {
        outcome = { result: 'failed', failure: 'network' };
      } finally {
        clearTimeout(timer);
      }
    }
    repo.recordResult(row, outcome, now().toISOString());
    opts.logger.info({ deviceId: row.id, result: outcome.result }, 'web push delivery');
  }
  const sendAll = (userId: string, payload: PushPayload, createdBefore?: string) =>
    Promise.all(
      active(userId)
        .filter((d) => !createdBefore || d.created_at <= createdBefore)
        .map((d) => send(d, payload)),
    );

  async function recipients(item: InboxItem) {
    const config = await opts.config(item.projectKey);
    const seen = new Set<string>();
    return config.team.members.flatMap((member) => {
      if (member.kind !== 'human' || !member.email || !isPushableItem(item, member.handle)) return [];
      const access = projectAccessFor(config, member.email);
      if (!access || !canSeeInboxItem(access, item)) return [];
      const user = opts.repos.users.findByEmail(member.email);
      if (!user || seen.has(user.id)) return [];
      seen.add(user.id);
      return [user];
    });
  }

  async function sweepRound(): Promise<void> {
    if (!key) return;
    const time = now();
    if (time.getTime() - lastPruned >= 86400000) {
      repo.prune(new Date(time.getTime() - 30 * 86400000).toISOString());
      lastPruned = time.getTime();
    }
    for (const { user_id: userId } of repo.due(time.toISOString())) {
      const settings = repo.settings(userId);
      const window = quietWindowAt(settings.quietHours, time);
      if (window.quiet) {
        repo.setDue(userId, window.endsAt);
        continue;
      }
      const items: InboxItem[] = [];
      const batch = repo.quiet(userId);
      for (const row of batch) {
        const item = opts.repos.inbox.get(row.inbox_item_id);
        const category = item && pushCategoryOf(item);
        if (
          item &&
          category &&
          settings.categories[category] &&
          (await recipients(item)).some((u) => u.id === userId)
        )
          items.push(item);
      }
      // Finalize before awaiting delivery so a concurrent upsert starts a fresh quiet batch.
      opts.repos.transaction(() => {
        repo.digest(
          userId,
          batch.map((row) => row.inbox_item_id),
        );
        repo.setDue(userId, repo.quiet(userId).length ? time.toISOString() : null);
      });
      const latest = items.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (latest)
        await sendAll(userId, {
          v: 1,
          kind: 'digest',
          title: hu.webPush.digest.title.replace('{n}', String(items.length)),
          body: hu.webPush.digest.body,
          tag: 'digest',
          url: `/p/${encodeURIComponent(latest.projectKey)}/inbox`,
        });
    }
    for (const [id, time] of testTimes) if (now().getTime() - time >= 5000) testTimes.delete(id);
  }

  return {
    overview(userId: string) {
      return {
        available: !!key,
        publicKey: key?.publicKey ?? null,
        settings: repo.settings(userId),
        devices: repo.devices(userId).map(pushDeviceView),
      };
    },
    settings(userId: string, settings: PushSettings) {
      const time = now();
      opts.repos.transaction(() => {
        repo.saveSettings(userId, settings, time.toISOString());
        if (repo.quiet(userId).length) {
          const window = quietWindowAt(settings.quietHours, time);
          repo.setDue(userId, window.quiet ? window.endsAt : time.toISOString());
        }
      });
      return settings;
    },
    subscribe(userId: string, input: SubscribePushRequest, userAgent: string, origin?: string) {
      available();
      if (!isAllowedPushEndpoint(input.endpoint))
        throw invalid('web_push_endpoint_invalid', 'Push endpoint is not allowed');
      const hash = endpointHash(input.endpoint);
      return opts.repos.transaction(() => {
        const previous = repo.byEndpoint(hash);
        const own = previous?.user_id === userId ? previous : undefined;
        if (!own && repo.devices(userId).length >= 20)
          throw conflict('web_push_device_limit', 'Push device limit reached');
        const time = now().toISOString();
        if (previous && !own) repo.remove(previous.user_id, previous.id);
        const row: PushDeviceRecord = {
          id: own?.id ?? randomUUID(),
          user_id: userId,
          endpoint: input.endpoint,
          endpoint_hash: hash,
          p256dh: input.keys.p256dh,
          auth: input.keys.auth,
          vapid_key_id: keyId!,
          origin: origin ?? null,
          ...deviceLabelOf(userAgent),
          installed: +input.installed,
          enabled: 1,
          state: 'active',
          last_sent_at: own?.last_sent_at ?? null,
          last_result: own?.last_result ?? null,
          last_failure: own?.last_failure ?? null,
          created_at: own?.created_at ?? time,
          updated_at: time,
        };
        repo.saveDevice(row);
        return { created: !own, device: pushDeviceView(row) };
      });
    },
    updateDevice(userId: string, id: string, enabled: boolean) {
      device(userId, id);
      repo.setEnabled(userId, id, enabled, now().toISOString());
      return pushDeviceView(device(userId, id));
    },
    removeDevice(userId: string, id: string) {
      device(userId, id);
      repo.remove(userId, id);
      testTimes.delete(id);
    },
    unsubscribe(userId: string, endpoint: string) {
      repo.unsubscribe(userId, endpointHash(endpoint));
    },
    async test(userId: string, id: string) {
      available();
      const row = device(userId, id);
      if (row.state !== 'active' || !row.endpoint)
        throw invalid('web_push_endpoint_invalid', 'Push device has expired');
      const time = now().getTime();
      if (time - (testTimes.get(id) ?? -Infinity) < 5000)
        throw new DomainError('web_push_test_too_soon', 'Wait before testing again', { status: 429 });
      testTimes.set(id, time);
      await send(row, { v: 1, kind: 'test', ...hu.webPush.test, tag: `test-${id}`, url: '/' });
      return pushDeviceView(device(userId, id));
    },
    async onItem(item: InboxItem) {
      if (!key || item.state !== 'open' || !pushCategoryOf(item)) return;
      for (const user of await recipients(item)) {
        if (!active(user.id).length) continue;
        const time = now();
        const category = pushCategoryOf(item)!;
        const settings = repo.settings(user.id);
        const skip = !settings.categories[category]
          ? 'category_off'
          : opts.presence.isViewing(user.email)
            ? 'viewing'
            : null;
        const window = quietWindowAt(settings.quietHours, time);
        const claimed = opts.repos.transaction(() => {
          if (
            !repo.claim({
              user_id: user.id,
              inbox_item_id: item.id,
              project_key: item.projectKey,
              outcome: skip ? 'skipped' : window.quiet ? 'quiet' : 'sent',
              skip_reason: skip,
              created_at: time.toISOString(),
            })
          )
            return false;
          if (!skip && window.quiet) {
            repo.saveSettings(user.id, settings, time.toISOString(), true);
            repo.setDue(user.id, window.endsAt, true);
          }
          return true;
        });
        if (!claimed || skip || window.quiet) continue;
        await sendAll(
          user.id,
          {
            v: 1,
            kind: 'item',
            title: hu.webPush.title[category],
            body: item.kind === 'release' ? item.projectKey : (item.taskKey ?? item.projectKey),
            tag: `inbox-${item.id}`,
            url: `/p/${encodeURIComponent(item.projectKey)}/inbox?via=push#inbox-item-${encodeURIComponent(item.id)}`,
            itemId: item.id,
            projectKey: item.projectKey,
          },
          item.createdAt,
        );
      }
    },
    sweep(): Promise<void> {
      return (sweeping ??= sweepRound().finally(() => {
        sweeping = undefined;
      }));
    },
  };
}
export type WebPushService = ReturnType<typeof createWebPushService>;
