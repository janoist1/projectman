import type { NtfyChannelView } from '@projectman/shared';
import type { NtfySendOutcome } from '../contracts';
import type { Db } from './database';

export interface NtfyChannelRecord {
  user_id: string;
  server_url: string;
  topic: string;
  origin: string | null;
  enabled: number;
  last_sent_at: string | null;
  last_result: NtfyChannelView['lastResult'];
  last_failure: NtfyChannelView['lastFailure'];
  created_at: string;
  updated_at: string;
}
export function ntfyChannelView(row: NtfyChannelRecord): NtfyChannelView {
  return {
    server: row.server_url,
    topic: row.topic,
    enabled: !!row.enabled,
    hasLink: !!row.origin,
    lastSentAt: row.last_sent_at,
    lastResult: row.last_result,
    lastFailure: row.last_failure,
    createdAt: row.created_at,
  };
}
export function createNtfyRepository(db: Db) {
  return {
    channel(userId: string) {
      return db.prepare('SELECT * FROM ntfy_channels WHERE user_id = ?').get(userId) as
        NtfyChannelRecord | undefined;
    },
    save(row: NtfyChannelRecord) {
      db.prepare(
        `INSERT OR REPLACE INTO ntfy_channels VALUES (@user_id, @server_url, @topic, @origin, @enabled, @last_sent_at, @last_result, @last_failure, @created_at, @updated_at)`,
      ).run(row);
    },
    remove(userId: string) {
      db.prepare('DELETE FROM ntfy_channels WHERE user_id = ?').run(userId);
    },
    recordResult(row: NtfyChannelRecord, outcome: NtfySendOutcome, now: string) {
      // Match the address, so a result of an old topic or server does not overwrite a newer setting.
      db.prepare(
        'UPDATE ntfy_channels SET last_sent_at = ?, last_result = ?, last_failure = ? WHERE user_id = ? AND server_url = ? AND topic = ?',
      ).run(
        now,
        outcome.result,
        outcome.result === 'failed' ? outcome.failure : null,
        row.user_id,
        row.server_url,
        row.topic,
      );
    },
  };
}
