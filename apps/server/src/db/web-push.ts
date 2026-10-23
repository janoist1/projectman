import { DEFAULT_PUSH_SETTINGS, PushSettings } from '@projectman/shared';
import type { PushDeviceView } from '@projectman/shared';
import type { PushSendOutcome } from '../contracts';
import type { Db } from './database';

export interface PushDeviceRecord {
  id: string;
  user_id: string;
  endpoint: string | null;
  endpoint_hash: string;
  p256dh: string | null;
  auth: string | null;
  vapid_key_id: string;
  origin: string | null;
  browser: string;
  os: string;
  form: 'desktop' | 'phone';
  installed: number;
  enabled: number;
  state: 'active' | 'expired';
  last_sent_at: string | null;
  last_result: PushDeviceView['lastResult'];
  last_failure: PushDeviceView['lastFailure'];
  created_at: string;
  updated_at: string;
}
interface PushItemRecord {
  user_id: string;
  inbox_item_id: string;
  project_key: string;
  outcome: 'sent' | 'quiet' | 'digested' | 'skipped';
  skip_reason: 'category_off' | 'viewing' | null;
  created_at: string;
}
export function pushDeviceView(row: PushDeviceRecord): PushDeviceView {
  return {
    id: row.id,
    endpointHash: row.endpoint_hash,
    browser: row.browser,
    os: row.os,
    form: row.form,
    installed: !!row.installed,
    enabled: !!row.enabled,
    state: row.state,
    lastSentAt: row.last_sent_at,
    lastResult: row.last_result,
    lastFailure: row.last_failure,
    createdAt: row.created_at,
  };
}
export function createWebPushRepository(db: Db) {
  const devices = (userId: string) =>
    db
      .prepare('SELECT * FROM web_push_devices WHERE user_id = ? ORDER BY created_at, id')
      .all(userId) as PushDeviceRecord[];
  const device = (userId: string, id: string) =>
    db.prepare('SELECT * FROM web_push_devices WHERE user_id = ? AND id = ?').get(userId, id) as
      PushDeviceRecord | undefined;
  const quiet = (userId: string) =>
    db
      .prepare(
        "SELECT * FROM web_push_items WHERE user_id = ? AND outcome = 'quiet' ORDER BY created_at, inbox_item_id",
      )
      .all(userId) as PushItemRecord[];
  return {
    devices,
    device,
    quiet,
    byEndpoint(hash: string) {
      return db.prepare('SELECT * FROM web_push_devices WHERE endpoint_hash = ?').get(hash) as
        PushDeviceRecord | undefined;
    },
    saveDevice(row: PushDeviceRecord) {
      db.prepare(
        `INSERT OR REPLACE INTO web_push_devices VALUES (@id, @user_id, @endpoint, @endpoint_hash, @p256dh, @auth, @vapid_key_id, @origin, @browser, @os, @form, @installed, @enabled, @state, @last_sent_at, @last_result, @last_failure, @created_at, @updated_at)`,
      ).run(row);
    },
    remove(userId: string, id: string) {
      db.prepare('DELETE FROM web_push_devices WHERE user_id = ? AND id = ?').run(userId, id);
    },
    unsubscribe(userId: string, hash: string) {
      db.prepare('DELETE FROM web_push_devices WHERE user_id = ? AND endpoint_hash = ?').run(userId, hash);
    },
    setEnabled(userId: string, id: string, enabled: boolean, now: string) {
      db.prepare('UPDATE web_push_devices SET enabled = ?, updated_at = ? WHERE user_id = ? AND id = ?').run(
        +enabled,
        now,
        userId,
        id,
      );
    },
    expireOtherKeys(keyId: string, now: string) {
      db.prepare(
        "UPDATE web_push_devices SET state = 'expired', endpoint = NULL, p256dh = NULL, auth = NULL, last_result = 'expired', last_failure = NULL, updated_at = ? WHERE vapid_key_id <> ? AND state = 'active'",
      ).run(now, keyId);
    },
    recordResult(row: PushDeviceRecord, outcome: PushSendOutcome, now: string) {
      // Match subscription credentials, not the timestamp another delivery or pause can change.
      db.prepare(
        `UPDATE web_push_devices SET last_sent_at = ?, last_result = ?, last_failure = ?, updated_at = ?, state = ?, endpoint = ?, p256dh = ?, auth = ? WHERE id = ? AND user_id = ? AND vapid_key_id = ? AND endpoint IS ? AND p256dh IS ? AND auth IS ? AND state = 'active'`,
      ).run(
        now,
        outcome.result,
        outcome.result === 'failed' ? outcome.failure : null,
        now,
        outcome.result === 'expired' ? 'expired' : row.state,
        outcome.result === 'expired' ? null : row.endpoint,
        outcome.result === 'expired' ? null : row.p256dh,
        outcome.result === 'expired' ? null : row.auth,
        row.id,
        row.user_id,
        row.vapid_key_id,
        row.endpoint,
        row.p256dh,
        row.auth,
      );
    },
    settings(userId: string): PushSettings {
      const row = db.prepare('SELECT * FROM web_push_settings WHERE user_id = ?').get(userId) as
        | {
            categories: string;
            quiet_enabled: number;
            quiet_start: string;
            quiet_end: string;
            time_zone: string;
          }
        | undefined;
      return row
        ? PushSettings.parse({
            categories: JSON.parse(row.categories),
            quietHours: {
              enabled: !!row.quiet_enabled,
              start: row.quiet_start,
              end: row.quiet_end,
              timeZone: row.time_zone,
            },
          })
        : structuredClone(DEFAULT_PUSH_SETTINGS);
    },
    saveSettings(userId: string, settings: PushSettings, now: string, onlyIfMissing = false) {
      const q = settings.quietHours;
      db.prepare(
        `INSERT INTO web_push_settings (user_id, categories, quiet_enabled, quiet_start, quiet_end, time_zone, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO ${onlyIfMissing ? 'NOTHING' : 'UPDATE SET categories = excluded.categories, quiet_enabled = excluded.quiet_enabled, quiet_start = excluded.quiet_start, quiet_end = excluded.quiet_end, time_zone = excluded.time_zone, updated_at = excluded.updated_at'}`,
      ).run(userId, JSON.stringify(settings.categories), +q.enabled, q.start, q.end, q.timeZone, now);
    },
    setDue(userId: string, due: string | null, onlyEmpty = false) {
      db.prepare(
        `UPDATE web_push_settings SET digest_due_at = ? WHERE user_id = ?${onlyEmpty ? ' AND digest_due_at IS NULL' : ''}`,
      ).run(due, userId);
    },
    due(now: string) {
      return db.prepare('SELECT user_id FROM web_push_settings WHERE digest_due_at <= ?').all(now) as {
        user_id: string;
      }[];
    },
    claim(row: PushItemRecord): boolean {
      return (
        db
          .prepare(
            'INSERT OR IGNORE INTO web_push_items VALUES (@user_id, @inbox_item_id, @project_key, @outcome, @skip_reason, @created_at)',
          )
          .run(row).changes > 0
      );
    },
    digest(userId: string, itemIds: string[]) {
      const update = db.prepare(
        "UPDATE web_push_items SET outcome = 'digested' WHERE user_id = ? AND inbox_item_id = ? AND outcome = 'quiet'",
      );
      for (const id of itemIds) update.run(userId, id);
    },
    prune(before: string) {
      db.prepare('DELETE FROM web_push_items WHERE created_at < ?').run(before);
    },
  };
}
