import { randomBytes } from 'node:crypto';
import { instanceOriginOf, ntfyServerOf } from '@projectman/shared';
import type { NtfyChannelView, NtfyOverview, SaveNtfyChannelRequest } from '@projectman/shared';
import { hu } from '@projectman/templates';
import type { FastifyBaseLogger } from 'fastify';
import type { NtfySendOutcome, NtfyTransport, PhoneChannel, PhoneMessage } from '../../contracts';
import { ntfyChannelView } from '../../db';
import type { NtfyChannelRecord, Repositories } from '../../db';
import { DomainError, invalid, notFound, unavailable } from '../../kernel';
import { createNtfyTransport } from './transport';

interface NtfyOptions {
  enabled?: boolean;
  standby?: boolean;
  transport?: NtfyTransport;
  repos: Repositories;
  logger: FastifyBaseLogger;
  now?: () => Date;
}
/** 128 random bits in a URL-safe form; the topic is the password of a public ntfy server. */
const newTopic = () => randomBytes(16).toString('base64url');

export function createNtfyService(opts: NtfyOptions) {
  const now = opts.now ?? (() => new Date());
  const repo = opts.repos.ntfy;
  const transport = opts.transport ?? createNtfyTransport();
  const usable = opts.enabled !== false && !opts.standby;
  const lastTest = new Map<string, number>();
  const available = () => {
    if (!usable) throw unavailable('ntfy_unavailable', 'ntfy is unavailable');
  };
  const channel = (userId: string) => {
    const row = repo.channel(userId);
    if (!row) throw notFound('ntfy channel', userId);
    return row;
  };

  async function send(row: NtfyChannelRecord, message: PhoneMessage): Promise<NtfySendOutcome> {
    let outcome: NtfySendOutcome;
    try {
      outcome = await transport.send({
        server: row.server_url,
        topic: row.topic,
        title: message.title,
        message: message.body,
        ...(row.origin ? { click: `${row.origin}/` } : {}),
        priority: message.urgent ? 'high' : 'default',
        timeoutMs: 10000,
      });
    } catch {
      outcome = { result: 'failed', failure: 'network' };
    }
    repo.recordResult(row, outcome, now().toISOString());
    // Neither the server address nor the topic is logged.
    opts.logger.info({ result: outcome.result }, 'ntfy delivery');
    return outcome;
  }

  const view = (userId: string): NtfyChannelView => ntfyChannelView(channel(userId));
  return {
    overview(userId: string): NtfyOverview {
      const row = repo.channel(userId);
      return { available: usable, channel: row ? ntfyChannelView(row) : null };
    },
    /** Creates the channel with a fresh topic, or changes the server and the switch of the existing one. */
    save(userId: string, input: SaveNtfyChannelRequest, origin?: string): NtfyChannelView {
      available();
      const server = ntfyServerOf(input.server);
      if (!server) throw invalid('ntfy_server_invalid', 'ntfy server address is not allowed');
      const time = now().toISOString();
      const previous = repo.channel(userId);
      repo.save({
        user_id: userId,
        server_url: server,
        topic: previous?.topic ?? newTopic(),
        origin: instanceOriginOf(origin) ?? previous?.origin ?? null,
        enabled: +input.enabled,
        last_sent_at: previous?.server_url === server ? previous.last_sent_at : null,
        last_result: previous?.server_url === server ? previous.last_result : null,
        last_failure: previous?.server_url === server ? previous.last_failure : null,
        created_at: previous?.created_at ?? time,
        updated_at: time,
      });
      return view(userId);
    },
    /** Replaces the topic, so whoever learnt the old one stops receiving. */
    renewTopic(userId: string): NtfyChannelView {
      available();
      const row = channel(userId);
      repo.save({
        ...row,
        topic: newTopic(),
        last_sent_at: null,
        last_result: null,
        last_failure: null,
        updated_at: now().toISOString(),
      });
      return view(userId);
    },
    remove(userId: string): void {
      repo.remove(userId);
      lastTest.delete(userId);
    },
    async test(userId: string): Promise<NtfyChannelView> {
      available();
      const row = channel(userId);
      const time = now().getTime();
      if (time - (lastTest.get(userId) ?? -Infinity) < 5000)
        throw new DomainError('web_push_test_too_soon', 'Wait before testing again', { status: 429 });
      lastTest.set(userId, time);
      await send(row, { ...hu.webPush.ntfy.test, urgent: false });
      for (const [id, at] of lastTest) if (time - at >= 5000) lastTest.delete(id);
      return view(userId);
    },
    /** The channel the web push service delivers through next to the browser devices. */
    phone(): PhoneChannel {
      return {
        active: (userId) => usable && !!repo.channel(userId)?.enabled,
        async deliver(userId, message) {
          const row = repo.channel(userId);
          if (usable && row?.enabled) await send(row, message);
        },
      };
    },
  };
}
export type NtfyService = ReturnType<typeof createNtfyService>;
