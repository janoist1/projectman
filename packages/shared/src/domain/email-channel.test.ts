import { describe, expect, it } from 'vitest';
import { AiMemberConfig, EmailMailbox, HumanMemberConfig, ProjectConfig } from '../config/schema';
import { applyConfigPatch, PatchConfigRequest } from '../config/edit';
import {
  applyMemberEmailChange,
  emailChannelOn,
  emailSenderOf,
  emailRecipientRefusal,
  emailContentRefusals,
  emailContactChangeRefusal,
  emailMailboxOf,
  emailMailboxOwners,
  emailMailboxReserved,
  emailMailboxTaken,
  emailMemberAddress,
  emailReplyAddress,
  emailReplySubject,
  EMAIL_SUBJECT_MAX,
  parseEmailMemberAddress,
  parseEmailReplyAddress,
} from './email-channel';
import type { EmailContentContext, EmailContactChangeInput } from './email-channel';
import { emailApprovalOf, EmailParkedAlert, alertPayloadOf, superDecisionRefusal } from './inbox';

const human = HumanMemberConfig.parse({
  kind: 'human',
  handle: 'ann',
  displayName: 'Ann',
  access: 'client',
  email: 'ann@example.org',
});
const ai = AiMemberConfig.parse({
  kind: 'ai',
  handle: 'dev',
  displayName: 'Dev',
  role: 'developer',
  sponsor: 'ann',
});
const project = ProjectConfig.parse({
  schemaVersion: 1,
  project: { key: 'AR', name: 'Test', workspacePath: '/work', repos: [] },
  team: { members: [human, ai], limits: {} },
  pipeline: {
    columns: [{ id: 'all', name: 'All' }],
    stages: [
      { id: 'ready', name: 'Ready', kind: 'queue', columnId: 'all' },
      { id: 'done', name: 'Done', kind: 'done', columnId: 'all' },
    ],
    labels: [],
  },
});

describe('applyMemberEmailChange', () => {
  it.each([
    [
      'switching off clears the approval bypass',
      { enabled: true, sendWithoutApproval: true },
      { enabled: false },
      { enabled: false, sendWithoutApproval: false },
    ],
    [
      'switching on starts with approval',
      { enabled: false, sendWithoutApproval: true },
      { enabled: true },
      { enabled: true, sendWithoutApproval: false },
    ],
    [
      'switching on can set the bypass in the same change',
      undefined,
      { enabled: true, sendWithoutApproval: true },
      { enabled: true, sendWithoutApproval: true },
    ],
    [
      'an omitted field stays',
      { enabled: true, sendWithoutApproval: true },
      { enabled: true },
      { enabled: true, sendWithoutApproval: true },
    ],
  ] as const)('%s', (_name, current, change, expected) => {
    expect(applyMemberEmailChange(current, change)).toEqual(expected);
  });
});

describe('email configuration', () => {
  it('defaults missing settings to disabled', () => {
    expect(emailChannelOn(project)).toBe(false);
    expect(emailSenderOf(project, 'dev')).toBeNull();
  });
  it('patches the project switch', () => {
    const patch = PatchConfigRequest.parse({ baseVersion: 'v', email: { enabled: true } });
    expect(emailChannelOn(applyConfigPatch(project, patch))).toBe(true);
    expect(
      PatchConfigRequest.safeParse({ baseVersion: 'v', email: { enabled: true, extra: true } }).success,
    ).toBe(false);
  });
  it('resolves an AI sender independently of the project switch with approval by default', () => {
    const config = structuredClone(project);
    config.team.members = [human, { ...ai, email: { enabled: true } }];
    expect(emailSenderOf(config, 'dev')).toEqual({ sendWithoutApproval: false });
    config.team.members = [{ ...ai, email: { enabled: true, sendWithoutApproval: true } }];
    expect(emailSenderOf(config, 'dev')).toEqual({ sendWithoutApproval: true });
  });
  it.each(['missing', 'ann'])('rejects a non-AI sender %s', (handle) => {
    expect(emailSenderOf(project, handle)).toBeNull();
  });
});

describe('email recipient', () => {
  it.each([
    [undefined, false, 'not_member'],
    [ai, false, 'not_human'],
    [{ ...human, email: undefined }, false, 'no_address'],
    [human, false, 'not_wanted'],
    [human, true, null],
  ] as const)('checks refusal precedence %#', (member, wants, expected) => {
    expect(emailRecipientRefusal(member, wants)).toBe(expected);
  });
});

const context: EmailContentContext = {
  projectKey: 'AR',
  canSee: (key) => key === 'AR-1',
  recipientAccess: 'client',
  labelIds: ['review-ok'],
  allowedAddresses: ['ann@example.org'],
  secrets: ['known-password'],
  paths: ['/opt/private'],
};
const content = (
  text: string,
  extra: Partial<EmailContentContext> = {},
  taskKey: string | null = null,
  subject = '',
) => emailContentRefusals({ subject, text, taskKey }, { ...context, ...extra });
describe('email content', () => {
  it('checks task references joined by punctuation or embedded in other text', () => {
    expect(content('AR-2-AR-3 xAR-4')).toEqual([
      { reason: 'task_not_visible', match: 'AR-2' },
      { reason: 'task_not_visible', match: 'AR-3' },
      { reason: 'task_not_visible', match: 'AR-4' },
    ]);
  });
  it('checks explicit, subject and body task keys once each', () => {
    expect(content('AR-3 AR-2 AR-1', {}, 'AR-4', 'AR-2')).toEqual([
      { reason: 'task_not_visible', match: 'AR-2' },
      { reason: 'task_not_visible', match: 'AR-3' },
      { reason: 'task_not_visible', match: 'AR-4' },
    ]);
  });
  it.each(['known-password', 'Authorization: Bearer abcdefghijklmnop'])(
    'uses existing secret detection without revealing matches %#',
    (text) => {
      expect(content(text)).toEqual([{ reason: 'secret' }]);
    },
  );
  it.each(['/opt/private/log', '/Users/someone/work/project'])(
    'uses existing path detection without revealing matches %#',
    (text) => {
      expect(content(text)).toEqual([{ reason: 'path' }]);
    },
  );
  it('allows known addresses case insensitively and refuses other addresses', () => {
    expect(content('ANN@example.org other@example.org')).toEqual([
      { reason: 'email_address', match: 'other@example.org' },
    ]);
  });
  it('refuses whole label ids only for clients', () => {
    expect(content('review-ok')).toEqual([{ reason: 'label_id', match: 'review-ok' }]);
    expect(content('review-ok', { recipientAccess: 'developer' })).toEqual([]);
    expect(content('pre-review-ok review-ok-extra')).toEqual([]);
  });
  it('permits visible references and ordinary content', () => {
    expect(content('AR-1: done. ann@example.org')).toEqual([]);
  });
});

const change: EmailContactChangeInput = {
  wants: true,
  target: 'ann',
  requestedBy: 'ann',
  caller: 'dev',
  ownersAndAdmins: ['owner'],
  source: { kind: 'message', from: 'ann', to: ['dev'], at: '2026-10-20T00:00:00Z' },
  now: '2026-10-22T00:00:00Z',
};
describe('email contact change', () => {
  it.each<[string, Partial<EmailContactChangeInput>, string | null]>([
    ['missing request', { requestedBy: null }, 'request_required'],
    ['unauthorized requester', { requestedBy: 'other' }, 'requester_not_allowed'],
    ['missing source', { source: null }, 'source_missing'],
    [
      'wrong sender',
      { source: { kind: 'message', from: 'other', to: ['dev'], at: change.now } },
      'source_mismatch',
    ],
    [
      'wrong recipient',
      { source: { kind: 'message', from: 'ann', to: ['other'], at: change.now } },
      'source_mismatch',
    ],
    [
      'stale source',
      { source: { kind: 'message', from: 'ann', to: ['dev'], at: '2026-10-14T00:00:00Z' } },
      'source_too_old',
    ],
    [
      'boundary age',
      { source: { kind: 'message', from: 'ann', to: ['dev'], at: '2026-10-15T00:00:00Z' } },
      null,
    ],
    [
      'invalid time',
      { source: { kind: 'message', from: 'ann', to: ['dev'], at: 'invalid' } },
      'source_too_old',
    ],
    [
      'future time',
      { source: { kind: 'message', from: 'ann', to: ['dev'], at: '2026-10-23T00:00:00Z' } },
      'source_too_old',
    ],
    ['own email', { source: { kind: 'email', from: 'ann' } }, null],
    ['another email', { source: { kind: 'email', from: 'owner' } }, 'source_mismatch'],
    [
      'owner email cannot opt in someone else',
      { requestedBy: 'owner', source: { kind: 'email', from: 'owner' } },
      'source_mismatch',
    ],
    [
      'owner request via message',
      { requestedBy: 'owner', source: { kind: 'message', from: 'owner', to: ['dev'], at: change.now } },
      null,
    ],
    ['valid request', {}, null],
    ['disable without source by anyone', { wants: false, requestedBy: 'other', source: null }, null],
    ['disable still requires request', { wants: false, requestedBy: null, source: null }, 'request_required'],
    [
      'disable checks provided source',
      { wants: false, source: { kind: 'email', from: 'other' } },
      'source_mismatch',
    ],
  ])('%s', (_name, extra, expected) => {
    expect(emailContactChangeRefusal({ ...change, ...extra })).toBe(expected);
  });
});

describe('email reply address', () => {
  const token = 'abcdefghijklmnopqrstuvwxyz';
  it('round trips a lowercase base32 token and project key', () => {
    const address = emailReplyAddress('AR', token, 'reply.example.org');
    expect(address).toBe(`r-ar-${token}@reply.example.org`);
    expect(parseEmailReplyAddress(address, 'reply.example.org')).toEqual({ projectKey: 'AR', token });
  });
  it.each([
    `r-ar-${token}@other.example.org`,
    `r-ar-${token.slice(1)}@reply.example.org`,
    `r-ar-0${token.slice(1)}@reply.example.org`,
    `r-ar-${token.toUpperCase()}@reply.example.org`,
    `r-ar-${token}@replyXexample.org`,
    `r-ar-${token}@reply.example.org\n`,
  ])('refuses malformed address %#', (address) => {
    expect(parseEmailReplyAddress(address, 'reply.example.org')).toBeNull();
  });
});

describe('email member address', () => {
  const domain = 'reply.example.org';
  const on = (handle: string, email: object = { enabled: true }) =>
    AiMemberConfig.parse({ ...ai, handle, email });
  const configOf = (key: string, members: AiMemberConfig[], enabled = true): ProjectConfig => ({
    ...project,
    project: { ...project.project, key, email: { enabled } },
    team: { ...project.team, members },
  });

  it('round trips a mailbox name through the address', () => {
    expect(emailMemberAddress('pm', domain)).toBe('pm@reply.example.org');
    expect(parseEmailMemberAddress('pm@reply.example.org', domain)).toBe('pm');
  });
  it.each([
    'r-ar-abcdefghijklmnopqrstuvwxyz@reply.example.org',
    'pm@other.example.org',
    'pm@replyXexample.org',
    'PM@reply.example.org',
    'pm@reply.example.org\n',
  ])('refuses address %#', (address) => {
    expect(parseEmailMemberAddress(address, domain)).toBeNull();
  });
  it('uses the handle unless a mailbox is chosen', () => {
    expect(emailMailboxOf(on('pm'))).toBe('pm');
    expect(emailMailboxOf(on('pm', { enabled: true, mailbox: 'planner' }))).toBe('planner');
  });
  it('finds the live owner of a mailbox in any project', () => {
    const configs = [configOf('AR', [on('dev')]), configOf('BR', [on('pm')])];
    expect(emailMailboxOwners(configs, 'pm')).toEqual([{ projectKey: 'BR', handle: 'pm' }]);
    expect(emailMailboxOwners(configs, 'nobody')).toEqual([]);
  });
  it('leads a former handle to the renamed member, unless a live name bears it', () => {
    const renamed = AiMemberConfig.parse({
      ...ai,
      handle: 'haini',
      formerHandles: ['dev'],
      email: { enabled: true },
    });
    expect(emailMailboxOwners([configOf('AR', [renamed])], 'dev')).toEqual([
      { projectKey: 'AR', handle: 'haini' },
    ]);
    expect(emailMailboxOwners([configOf('AR', [renamed, on('dev')])], 'dev')).toEqual([
      { projectKey: 'AR', handle: 'dev' },
    ]);
  });
  it('reports every owner when two members share a mailbox', () => {
    const configs = [configOf('AR', [on('pm')]), configOf('BR', [on('pm')])];
    expect(emailMailboxOwners(configs, 'pm')).toHaveLength(2);
  });
  it.each([
    ['a member with the switch off', configOf('AR', [on('pm', { enabled: false })])],
    ['a project with the channel off', configOf('AR', [on('pm')], false)],
  ])('gives no live owner for %s', (_name, config) => {
    expect(emailMailboxOwners([config], 'pm')).toEqual([]);
  });
  it('takes a name from another member whatever its switches', () => {
    const configs = [configOf('AR', [on('pm', { enabled: false }), on('dev')])];
    expect(emailMailboxTaken(configs, 'AR', 'dev', 'pm')).toBe(true);
    expect(emailMailboxTaken(configs, 'AR', 'pm', 'pm')).toBe(false);
    expect(emailMailboxTaken(configs, 'AR', 'dev', 'free')).toBe(false);
  });
  it('reserves the former handle of a renamed member in every project', () => {
    const renamed = AiMemberConfig.parse({ ...ai, handle: 'haini', formerHandles: ['dev'] });
    const configs = [configOf('AR', [renamed]), configOf('BR', [on('pm')])];
    expect(emailMailboxReserved(configs, 'BR', 'pm', 'dev')).toBe(true);
    expect(emailMailboxTaken(configs, 'BR', 'pm', 'dev')).toBe(true);
    expect(emailMailboxReserved(configs, 'AR', 'haini', 'dev')).toBe(false);
    expect(emailMailboxReserved(configs, 'BR', 'pm', 'free')).toBe(false);
  });
  it('keeps the mailbox when the switches change', () => {
    expect(applyMemberEmailChange({ enabled: true, mailbox: 'planner' }, { enabled: false })).toEqual({
      enabled: false,
      sendWithoutApproval: false,
      mailbox: 'planner',
    });
  });
  it('stores nothing for a mailbox equal to the handle', () => {
    expect(applyMemberEmailChange({ enabled: true, mailbox: 'planner' }, { mailbox: 'pm' }, 'pm')).toEqual({
      enabled: true,
    });
  });
  it.each(['r-pm', '-pm', 'a'.repeat(33), 'Pm', 'p_m', ''])('refuses the mailbox name %j', (name) => {
    expect(EmailMailbox.safeParse(name).success).toBe(false);
  });
});

describe('email inbox payloads', () => {
  const email = {
    emailId: 'eml_1',
    member: 'dev',
    contact: 'ann',
    contactName: 'Ann',
    taskKey: null,
    subject: 'Update',
    text: 'Done',
  };
  it('reads email approvals only from approval items', () => {
    expect(emailApprovalOf({ kind: 'approval', payload: { email } })).toEqual(email);
    expect(emailApprovalOf({ kind: 'question', payload: { email } })).toBeNull();
    expect(emailApprovalOf({ kind: 'approval', payload: { email: {} } })).toBeNull();
  });
  it('prevents delegated approval even for a malformed email field', () => {
    expect(
      superDecisionRefusal(
        { kind: 'approval', source: 'dev', payload: { email: null } },
        { operatorHandle: 'operator', sessionMember: 'dev' },
      ),
    ).toBe('owner_approval_required');
  });
  it('reads parked alerts with bounded subject and excerpt', () => {
    const payload = {
      alert: 'email_parked',
      emailId: 'eml_2',
      reason: 'unknown_sender',
      fromAddress: 'unknown@example.org',
      subject: 'Hello',
      excerpt: 'Text',
      attachmentNames: ['file.pdf'],
    };
    expect(alertPayloadOf({ kind: 'alert', payload })).toEqual(payload);
    expect(EmailParkedAlert.safeParse({ ...payload, subject: 'a'.repeat(201) }).success).toBe(false);
    expect(EmailParkedAlert.safeParse({ ...payload, excerpt: 'a'.repeat(1001) }).success).toBe(false);
  });
});

describe('emailReplySubject', () => {
  it.each(['Re: Plan', 'rE: Plan', 'AW: Plan', 'sv: Plan', 'VÁ: Plan', 'Válasz: Plan'])(
    'keeps the reply prefix of %s',
    (subject) => {
      expect(emailReplySubject(subject)).toBe(subject);
    },
  );
  it('prefixes a new subject and bounds its length', () => {
    expect(emailReplySubject('Plan')).toBe('Re: Plan');
    expect(emailReplySubject('a'.repeat(EMAIL_SUBJECT_MAX))).toHaveLength(EMAIL_SUBJECT_MAX);
  });
});
