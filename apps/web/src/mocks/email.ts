import {
  EMAIL_LOG_PAGE,
  SetEmailContactRequest,
  emailMailboxState,
  emailRecipientRefusal,
  emailSenderOf,
} from '@projectman/shared';
import type {
  EmailChannelView,
  EmailContact,
  EmailContactSource,
  EmailLogEntry,
  EmailLogResponse,
  ErrorCode,
  ProjectConfig,
  ServerEvent,
} from '@projectman/shared';
import { mockId, nowIso } from './time';

interface MockResponse {
  status: number;
  body?: unknown;
}

/** What the fake e-mail channel needs from the backend that hosts it; read when used, a test may swap them. */
export interface MockEmailHost {
  config(): ProjectConfig;
  viewerHandle(): string;
  emit(event: ServerEvent): void;
}

/** What the fake keeps of one contact's choice; the address and the name come from the member. */
export interface MockEmailContactRecord {
  wants: boolean;
  changedBy: string | null;
  changedAt: string | null;
  requestedBy: string | null;
  source: EmailContactSource | null;
}

function failure(status: number, code: ErrorCode, message: string): MockResponse {
  return { status, body: { error: { code, message } } };
}

/**
 * The e-mail channel of the fake backend (PM-942): the state, the contacts' choices and the log. It
 * applies the pure rules of `@projectman/shared` and holds no rule of its own; a test or a scenario
 * fills `log` and `records`.
 */
export class MockEmail {
  /** False on an instance without a mail sender: the channel cannot be switched on. */
  configured = true;
  fromAddress: string | null = 'projectman@mail.example.com';
  /** The domain of the members' addresses. */
  memberDomain = 'mail.example.com';
  /** The other projects of the server: their members' mailbox names count too. A test fills it. */
  otherProjects: ProjectConfig[] = [];
  /** Newest first, as the server returns it. */
  log: EmailLogEntry[] = [];
  records = new Map<string, MockEmailContactRecord>();

  private readonly host: MockEmailHost;

  constructor(host: MockEmailHost) {
    this.host = host;
  }

  view(): EmailChannelView {
    const config = this.host.config();
    const contacts: EmailContact[] = [];
    for (const member of config.team.members) {
      if (member.kind !== 'human') continue;
      const record = this.records.get(member.handle);
      contacts.push({
        handle: member.handle,
        displayName: member.displayName,
        access: member.access,
        address: member.email ?? null,
        wants: record?.wants ?? false,
        changedBy: record?.changedBy ?? null,
        changedAt: record?.changedAt ?? null,
        requestedBy: record?.requestedBy ?? null,
        source: record?.source ?? null,
      });
    }
    const domain = this.configured ? this.memberDomain : null;
    const senders = config.team.members.flatMap((member) => {
      const sender = emailSenderOf(config, member.handle);
      return sender && member.kind === 'ai'
        ? [
            {
              handle: member.handle,
              displayName: member.displayName,
              sendWithoutApproval: sender.sendWithoutApproval,
              ...emailMailboxState([config, ...this.otherProjects], config.project.key, member, domain),
            },
          ]
        : [];
    });
    return {
      configured: this.configured,
      enabled: config.project.email?.enabled === true,
      fromAddress: config.project.email?.enabled === true ? this.fromAddress : null,
      memberDomain: domain,
      senders,
      contacts,
    };
  }

  logPage(before: string | null): EmailLogResponse {
    const start = before ? this.log.findIndex((entry) => entry.id === before) + 1 : 0;
    const entries = this.log.slice(start, start + EMAIL_LOG_PAGE);
    const more = start + entries.length < this.log.length;
    return { entries, nextCursor: more ? (entries.at(-1)?.id ?? null) : null };
  }

  /** `rest` is the path below `/email`; null when the route is not the channel's. */
  handle(method: string, rest: string, body: unknown, query: URLSearchParams): MockResponse | null {
    const viewer = this.host
      .config()
      .team.members.find((member) => member.handle === this.host.viewerHandle());
    if (viewer?.kind !== 'human' || !['owner', 'admin'].includes(viewer.access))
      return failure(403, 'insufficient_access', 'Owner or admin required');
    if (rest === '' && method === 'GET') return { status: 200, body: this.view() };
    if (rest === '/log' && method === 'GET') return { status: 200, body: this.logPage(query.get('before')) };
    const contact = /^\/contacts\/([^/]+)$/.exec(rest);
    if (contact && method === 'PUT') return this.setContact(decodeURIComponent(contact[1]!), body);
    return null;
  }

  private setContact(handle: string, body: unknown): MockResponse {
    const parsed = SetEmailContactRequest.safeParse(body);
    if (!parsed.success) return failure(400, 'invalid_request', 'Invalid request');
    const { wants } = parsed.data;
    const member = this.host.config().team.members.find((candidate) => candidate.handle === handle);
    if (emailRecipientRefusal(member, wants)) return failure(409, 'email_contact_refused', 'Contact refused');
    const at = nowIso();
    const by = this.host.viewerHandle();
    this.records.set(handle, { wants, changedBy: by, changedAt: at, requestedBy: by, source: 'settings' });
    this.log = [
      {
        kind: 'setting',
        id: mockId('eml'),
        at,
        contact: handle,
        wants,
        by,
        requestedBy: by,
        source: 'settings',
        quote: null,
        sourceRef: null,
      },
      ...this.log,
    ];
    this.host.emit({ type: 'email_changed', projectKey: this.host.config().project.key });
    return { status: 200, body: this.view() };
  }
}
