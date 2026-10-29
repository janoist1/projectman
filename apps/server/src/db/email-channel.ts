import { randomUUID } from 'node:crypto';
import { EMAIL_LOG_PAGE, EMAIL_PARKED_TEXT_DAYS } from '@projectman/shared';
import type {
  EmailContactSource,
  EmailInboundStatus,
  EmailLogEntry,
  EmailLogResponse,
  EmailOutboundStatus,
  EmailParkReason,
} from '@projectman/shared';
import type { Db } from './database';
import { parseJson, toJson } from './json';

interface EmailContactRecord {
  projectKey: string;
  handle: string;
  wants: boolean;
  changedBy: string;
  changedAt: string;
  requestedBy: string | null;
  source: EmailContactSource;
}
interface EmailContactEventRecord {
  id: string;
  projectKey: string;
  handle: string;
  wants: boolean;
  by: string;
  requestedBy: string | null;
  source: EmailContactSource;
  sourceRef: string | null;
  quote: string | null;
  at: string;
}
export interface EmailMessageRecord {
  id: string;
  projectKey: string;
  direction: 'outbound' | 'inbound';
  member: string | null;
  contact: string | null;
  taskKey: string | null;
  subject: string;
  text: string;
  status: EmailOutboundStatus | EmailInboundStatus;
  parkReason: EmailParkReason | null;
  note: string | null;
  fromAddress: string | null;
  attachmentNames: string[];
  replyTokenHash: string | null;
  replyExpiresAt: string | null;
  inReplyTo: string | null;
  providerId: string | null;
  inboxItemId: string | null;
  messageId: string | null;
  mimeMessageId: string | null;
  mimeReferences: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const messageColumns = {
  id: 'id',
  projectKey: 'project_key',
  direction: 'direction',
  member: 'member',
  contact: 'contact',
  taskKey: 'task_key',
  subject: 'subject',
  text: 'text',
  status: 'status',
  parkReason: 'park_reason',
  note: 'note',
  fromAddress: 'from_address',
  attachmentNames: 'attachment_names',
  replyTokenHash: 'reply_token_hash',
  replyExpiresAt: 'reply_expires_at',
  inReplyTo: 'in_reply_to',
  providerId: 'provider_id',
  inboxItemId: 'inbox_item_id',
  messageId: 'message_id',
  mimeMessageId: 'mime_message_id',
  mimeReferences: 'mime_references',
  decidedBy: 'decided_by',
  decidedAt: 'decided_at',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
} as const;
const messageSelect = Object.entries(messageColumns)
  .map(([key, column]) => `${column} AS "${key}"`)
  .join(', ');
type MessageRow = Omit<EmailMessageRecord, 'attachmentNames'> & { attachmentNames: string };
const messageOf = (row: MessageRow | undefined): EmailMessageRecord | null =>
  row ? { ...row, attachmentNames: parseJson<string[]>(row.attachmentNames, []) } : null;
const contactSelect =
  'project_key AS projectKey, handle, wants, changed_by AS changedBy, changed_at AS changedAt, requested_by AS requestedBy, source';
type ContactRow = Omit<EmailContactRecord, 'wants'> & { wants: number };
const contactOf = (row: ContactRow): EmailContactRecord => ({ ...row, wants: !!row.wants });

/** Hub storage only. The caller authorizes and supplies timestamps; no addresses or tokens are generated here. */
export function createEmailChannelRepository(db: Db) {
  const getMessage = (column: 'id' | 'reply_token_hash' | 'provider_id', value: string) =>
    messageOf(
      db.prepare(`SELECT ${messageSelect} FROM email_messages WHERE ${column} = ?`).get(value) as
        MessageRow | undefined,
    );
  return {
    contacts: {
      get(projectKey: string, handle: string): EmailContactRecord | null {
        const row = db
          .prepare(`SELECT ${contactSelect} FROM email_contacts WHERE project_key = ? AND handle = ?`)
          .get(projectKey, handle) as ContactRow | undefined;
        return row ? contactOf(row) : null;
      },
      list(projectKey: string): EmailContactRecord[] {
        return (
          db
            .prepare(`SELECT ${contactSelect} FROM email_contacts WHERE project_key = ? ORDER BY handle`)
            .all(projectKey) as ContactRow[]
        ).map(contactOf);
      },
      /** Every setting change and its audit entry commit together. */
      set(input: Omit<EmailContactEventRecord, 'id'> & { id?: string }): EmailContactEventRecord {
        const event = { ...input, id: input.id ?? `emc_${randomUUID()}` };
        db.transaction(() => {
          db.prepare(
            `INSERT INTO email_contacts (project_key, handle, wants, changed_by, changed_at, requested_by, source)
            VALUES (@projectKey, @handle, @wants, @by, @at, @requestedBy, @source)
            ON CONFLICT(project_key, handle) DO UPDATE SET wants=excluded.wants, changed_by=excluded.changed_by,
            changed_at=excluded.changed_at, requested_by=excluded.requested_by, source=excluded.source`,
          ).run({ ...event, wants: +event.wants });
          db.prepare(
            `INSERT INTO email_contact_events (id, project_key, handle, wants, "by", requested_by, source, source_ref, quote, at)
            VALUES (@id, @projectKey, @handle, @wants, @by, @requestedBy, @source, @sourceRef, @quote, @at)`,
          ).run({ ...event, wants: +event.wants });
        })();
        return event;
      },
    },
    messages: {
      insert(input: Omit<EmailMessageRecord, 'id'> & { id?: string }): EmailMessageRecord {
        const record = { ...input, id: input.id ?? `eml_${randomUUID()}` };
        db.prepare(
          `INSERT INTO email_messages (${Object.values(messageColumns).join(', ')})
          VALUES (${Object.keys(messageColumns)
            .map((key) => `@${key}`)
            .join(', ')})`,
        ).run({ ...record, attachmentNames: toJson(record.attachmentNames) });
        return record;
      },
      /** Drops a row whose work failed, so the same provider id can be tried again. */
      remove(id: string): void {
        db.prepare('DELETE FROM email_messages WHERE id = ?').run(id);
      },
      get: (id: string) => getMessage('id', id),
      byTokenHash: (hash: string) => getMessage('reply_token_hash', hash),
      byProviderId: (id: string) => getMessage('provider_id', id),
      /** Whether this member has already mailed this contact (a delivered or bounced mail counts). */
      sentBefore(projectKey: string, member: string, contact: string): boolean {
        return !!db
          .prepare(
            `SELECT 1 FROM email_messages WHERE project_key = ? AND direction = 'outbound'
            AND member = ? AND contact = ? AND status IN ('sent', 'bounced', 'complained') LIMIT 1`,
          )
          .get(projectKey, member, contact);
      },
      update(
        id: string,
        patch: Partial<Omit<EmailMessageRecord, 'id' | 'projectKey' | 'createdAt'>>,
      ): EmailMessageRecord | null {
        const keys = (Object.keys(messageColumns) as (keyof typeof messageColumns)[])
          .filter(
            (key): key is keyof typeof patch => key !== 'id' && key !== 'projectKey' && key !== 'createdAt',
          )
          .filter((key) => patch[key] !== undefined);
        if (keys.length) {
          const values = Object.fromEntries(
            keys.map((key) => [key, key === 'attachmentNames' ? toJson(patch[key]) : patch[key]]),
          );
          db.prepare(
            `UPDATE email_messages SET ${keys.map((key) => `${messageColumns[key]} = @${key}`).join(', ')} WHERE id = @id`,
          ).run({ ...values, id });
        }
        return getMessage('id', id);
      },
    },
    listOutbound(projectKey: string, status: EmailOutboundStatus): EmailMessageRecord[] {
      return (
        db
          .prepare(
            `SELECT ${messageSelect} FROM email_messages
            WHERE project_key = ? AND direction = 'outbound' AND status = ? ORDER BY created_at, id`,
          )
          .all(projectKey, status) as MessageRow[]
      ).map((row) => messageOf(row)!);
    },
    countOutboundSince(
      projectKey: string,
      filter: { member: string } | { contact: string },
      since: string,
      statuses?: readonly EmailOutboundStatus[],
    ): number {
      const [column, value] = 'member' in filter ? ['member', filter.member] : ['contact', filter.contact];
      const statusPlaceholders = statuses?.length ? statuses.map(() => '?').join(', ') : null;
      return (
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM email_messages WHERE project_key = ? AND direction = 'outbound'
            AND ${column} = ? AND created_at >= ?${statusPlaceholders ? ` AND status IN (${statusPlaceholders})` : ''}`,
          )
          .get(projectKey, value, since, ...(statuses ?? [])) as { count: number }
      ).count;
    },
    /** Parked mails since `since` that raised an alert (the daily limit counts these). */
    countAlertedSince(projectKey: string, since: string): number {
      return (
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM email_messages WHERE project_key = ? AND direction = 'inbound'
            AND status = 'parked' AND inbox_item_id IS NOT NULL AND created_at >= ?`,
          )
          .get(projectKey, since) as { count: number }
      ).count;
    },
    /**
     * Cursor is the last (timestamp,id) pair, so equal timestamps never skip a row. A cursor that cannot be
     * read is a `RangeError`, the only one this method throws.
     */
    log(projectKey: string, before: string | null = null, limit = EMAIL_LOG_PAGE): EmailLogResponse {
      let cursor: unknown = null;
      if (before) {
        try {
          cursor = JSON.parse(Buffer.from(before, 'base64url').toString('utf8'));
        } catch {
          throw new RangeError('Invalid email log cursor');
        }
      }
      if (
        cursor !== null &&
        (!Array.isArray(cursor) || cursor.length !== 2 || cursor.some((part) => typeof part !== 'string'))
      )
        throw new RangeError('Invalid email log cursor');
      const [at, id] = (cursor ?? [null, null]) as [string | null, string | null];
      const pageSize = Math.max(1, Math.min(100, Math.floor(limit)));
      const rows = db
        .prepare(
          `SELECT kind, id, at FROM (
        SELECT direction AS kind, id, created_at AS at FROM email_messages WHERE project_key = @projectKey
        UNION ALL SELECT 'setting' AS kind, id, at FROM email_contact_events WHERE project_key = @projectKey
      ) WHERE @at IS NULL OR at < @at OR (at = @at AND id < @id) ORDER BY at DESC, id DESC LIMIT @limit`,
        )
        .all({ projectKey, at, id, limit: pageSize + 1 }) as {
        kind: EmailLogEntry['kind'];
        id: string;
        at: string;
      }[];
      const entries = rows.slice(0, pageSize).map((row): EmailLogEntry => {
        if (row.kind === 'setting') {
          const event = db
            .prepare(
              'SELECT handle AS contact, wants, "by", requested_by AS requestedBy, source, quote, source_ref AS sourceRef FROM email_contact_events WHERE id = ?',
            )
            .get(row.id) as Omit<
            Extract<EmailLogEntry, { kind: 'setting' }>,
            'kind' | 'id' | 'at' | 'wants'
          > & { wants: number };
          return { ...row, ...event, kind: 'setting', wants: !!event.wants };
        }
        const message = getMessage('id', row.id)!;
        const common = {
          id: row.id,
          at: row.at,
          member: message.member,
          contact: message.contact,
          taskKey: message.taskKey,
          subject: message.subject,
          text: message.text,
        };
        return row.kind === 'outbound'
          ? {
              ...common,
              kind: 'outbound',
              member: message.member!,
              contact: message.contact!,
              status: message.status as EmailOutboundStatus,
              decidedBy: message.decidedBy,
              decidedAt: message.decidedAt,
              note: message.note,
            }
          : {
              ...common,
              kind: 'inbound',
              fromAddress: message.fromAddress ?? '',
              status: message.status as EmailInboundStatus,
              parkReason: message.parkReason,
              attachmentNames: message.attachmentNames,
            };
      });
      const last = entries.at(-1);
      return {
        entries,
        nextCursor:
          rows.length > pageSize && last
            ? Buffer.from(JSON.stringify([last.at, last.id])).toString('base64url')
            : null,
      };
    },
    prune(now: string): number {
      const before = new Date(Date.parse(now) - EMAIL_PARKED_TEXT_DAYS * 86400000).toISOString();
      return db
        .prepare(
          `UPDATE email_messages SET text = '', from_address = '', updated_at = ?
        WHERE direction = 'inbound' AND status = 'parked' AND created_at < ? AND (text <> '' OR from_address <> '')`,
        )
        .run(now, before).changes;
    },
  };
}
