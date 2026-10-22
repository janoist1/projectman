import { describe, expect, it } from 'vitest';
import { AiMemberConfig, HumanMemberConfig, ProjectConfig } from '../config/schema';
import { applyConfigPatch, PatchConfigRequest } from '../config/edit';
import {
  emailChannelOn,
  emailSenderOf,
  emailRecipientRefusal,
  emailContentRefusals,
  emailContactChangeRefusal,
  emailReplyAddress,
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
