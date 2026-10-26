import { describe, expect, it } from 'vitest';

import { OperatorStep, SetSystemFeedbackForwardingRequest, SystemFeedbackPrepared } from '../index';
import {
  SYSTEM_FEEDBACK_PREFILL_URL_MAX,
  SYSTEM_FEEDBACK_REPOSITORY,
  formatSystemFeedbackBody,
  parseSystemFeedbackIssueUrl,
  redactSystemFeedback,
  redactionCounts,
  systemFeedbackAccess,
  systemFeedbackIssueUrl,
} from './system-feedback';
import type { RedactionContext } from './system-feedback';

const ctx: RedactionContext = {
  secrets: ['hunter2-the-secret', 'short'],
  paths: ['/srv/projectman/data', 'C:\\Work\\Repos'],
  projectKeys: ['PM', 'A'],
  projectNames: ['Acme Portal', 'Zoltán', 'janoist1', 'projectman'],
  members: ['István Jano', 'ist1@example.com', 'Kata', 'Bo'],
  clients: ['Ügyfél Kft', 'client@acme.example', 'Éva'],
};

const redact = (text: string, context: RedactionContext = ctx) => redactSystemFeedback(text, context);
const textOf = (text: string, context: RedactionContext = ctx) => redact(text, context).text;

describe('redactSystemFeedback: secrets', () => {
  it.each([
    ['a known secret value', 'leaked hunter2-the-secret here', 'leaked [redacted:secret] here'],
    [
      'a PEM block',
      'k:\n-----BEGIN PRIVATE KEY-----\nabc\ndef\n-----END PRIVATE KEY-----\nend',
      'k:\n[redacted:secret]\nend',
    ],
    ['an unterminated PEM block', 'x -----BEGIN RSA PRIVATE KEY-----\nabc', 'x [redacted:secret]'],
    ['a postgres connection string', 'db postgres://u:p@db.local:5432/app ok', 'db [redacted:secret] ok'],
    ['a mongodb+srv connection string', 'mongodb+srv://u:p@c.example.net/db', '[redacted:secret]'],
    ['a redis connection string', 'redis://:pw@cache:6379/0', '[redacted:secret]'],
    [
      'a password in a URL',
      'https://bob:s3cr3t@git.example.com/x.git',
      'https://bob:[redacted:secret]@git.example.com/x.git',
    ],
    [
      'an Authorization header',
      'Authorization: Basic dXNlcjpwYXNz',
      'Authorization: Basic [redacted:secret]',
    ],
    ['a Bearer token', 'curl -H "x: Bearer abcd1234efgh5678"', 'curl -H "x: Bearer [redacted:secret]"'],
    ['a GitHub token', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', '[redacted:secret]'],
    ['a fine-grained GitHub token', 'github_pat_11ABCDEFG0abcdefghijklmnop_qrstuv', '[redacted:secret]'],
    ['an sk- key', 'key sk-ant-api03-abcdefghijklmnop', 'key [redacted:secret]'],
    ['a Slack token', 'xoxb-1234567890-abcdefghij', '[redacted:secret]'],
    ['an AWS access key', 'id AKIAIOSFODNN7EXAMPLE end', 'id [redacted:secret] end'],
    ['a Google key', 'AIzaSyA1234567890abcdefghijklmnopqrstuv', '[redacted:secret]'],
    [
      'a JWT',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r',
      '[redacted:secret]',
    ],
    ['a key=value password', 'password=hunter99 next', 'password=[redacted:secret] next'],
    ['a quoted JSON secret', '{"client_secret": "abc def"}', '{"client_secret": "[redacted:secret]"}'],
    ['a key: value token', 'accessToken: abc123xyz', 'accessToken: [redacted:secret]'],
    ['an api key', 'api_key = zzz999', 'api_key = [redacted:secret]'],
    ['an upper-case environment variable', 'run FOO_BAR=baz node', 'run FOO_BAR=[redacted:secret] node'],
    ['a long mixed-case token', 'id Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0UvWx end', 'id [redacted:secret] end'],
  ])('covers %s', (_name, input, expected) => {
    const result = redact(input);
    expect(result.text).toBe(expected);
    expect(result.counts.secret).toBe(1);
  });

  it.each([
    ['a git sha', 'commit 0e24d808fc16807871e0e5b3c04ede56617011b5 merged'],
    ['an uppercase hex digest', 'sum ABCDEF0123456789ABCDEF0123456789ABCDEF01'],
    ['a branch name', 'branch PM-478-visszajelzesek-1-3-kozos-szerzodes-es is'],
    ['a UUID', 'id 123e4567-e89b-12d3-a456-426614174000'],
    ['a short secret value', 'the word short stays'],
    ['a boolean value of a secret key', 'secret: true'],
  ])('leaves %s', (_name, input) => {
    expect(textOf(input, { ...ctx, projectKeys: [], projectNames: [] })).toBe(input);
  });
});

describe('redactSystemFeedback: paths', () => {
  it.each([
    ['a context path', 'see /srv/projectman/data/db/x.sqlite now', 'see [redacted:path] now'],
    ['the context path itself', 'in /srv/projectman/data.', 'in [redacted:path].'],
    ['a Windows context path', 'C:\\Work\\Repos\\app\\a.ts failed', '[redacted:path] failed'],
    ['a macOS home path', 'open /Users/jane/Documents/x.txt please', 'open [redacted:path] please'],
    ['a Linux home path', 'at (/home/jane/app/index.js:3:4)', 'at ([redacted:path])'],
    ['a Windows home path', 'C:\\Users\\Jane\\app\\x.js', '[redacted:path]'],
    ['a tilde path', 'cd ~/work/repo && ls', 'cd [redacted:path] && ls'],
  ])('covers %s', (_name, input, expected) => {
    const result = redact(input);
    expect(result.text).toBe(expected);
    expect(result.counts.path).toBe(1);
  });

  it('does not take another directory for a context path', () => {
    expect(textOf('/srv/projectman/database/x')).toBe('/srv/projectman/database/x');
  });

  it('leaves a web path that is not a home directory', () => {
    expect(textOf('GET https://example.com/api/home/list ok')).toBe(
      'GET https://example.com/api/home/list ok',
    );
  });
});

describe('redactSystemFeedback: e-mail, client, member, project', () => {
  it('covers an e-mail address', () => {
    const result = redact('write to jane.doe@corp.example.');
    expect(result.text).toBe('write to [redacted:email].');
    expect(result.counts).toEqual({ email: 1 });
  });

  it('files the address of a member and of a client under its own kind', () => {
    const result = redact('ist1@example.com, client@acme.example and CLIENT@acme.example');
    expect(result.text).toBe('[redacted:member], [redacted:client] and [redacted:client]');
    expect(result.counts).toEqual({ member: 1, client: 2 });
  });

  it('leaves a package version that looks like an address', () => {
    expect(textOf('lodash@4.17.21')).toBe('lodash@4.17.21');
  });

  it('covers a project key as a whole word, KEY-123 as one', () => {
    const result = redact('PM-12 and PM, not pm or PMS or XPM-3');
    expect(result.text).toBe('[redacted:project] and [redacted:project], not pm or PMS or XPM-3');
    expect(result.counts).toEqual({ project: 2 });
  });

  it('covers a one-character key only as KEY-123', () => {
    expect(textOf('A task: A-7 opened')).toBe('A task: [redacted:project] opened');
  });

  it('covers a project name with an ending, whatever its case', () => {
    expect(textOf('az ACME PORTAL-ban és Zoltánnak')).toBe('az [redacted:project]-ban és [redacted:project]');
  });

  it.each([
    ['member', 'Katának írt', '[redacted:member] írt'],
    ['member', 'István Jano és ISTVÁN  jano', '[redacted:member] és [redacted:member]'],
    ['client', 'Ügyfél Kft-nek és Éva', '[redacted:client]-nek és [redacted:client]'],
  ])('covers a %s name', (_kind, input, expected) => {
    expect(textOf(input)).toBe(expected);
  });
  it('matches a multi-word name only as the whole phrase', () => {
    expect(textOf('István és Jano')).toBe('István és Jano');
  });

  it('matches a 3-character name only as a whole word and shorter ones never', () => {
    const three: RedactionContext = { ...ctx, members: ['Ann', 'Bo'], clients: [], projectNames: [] };
    expect(textOf('Ann, Annabel and Bo', three)).toBe('[redacted:member], Annabel and Bo');
  });

  it('covers a client before a member before a project when they share a name', () => {
    const shared: RedactionContext = {
      ...ctx,
      clients: ['Orsolya'],
      members: ['Orsolya'],
      projectNames: ['Orsolya'],
    };
    expect(redact('Orsolya', shared).counts).toEqual({ client: 1 });
  });
});

describe('redactSystemFeedback: what it never covers', () => {
  it('leaves the word projectman and the public repository', () => {
    const text =
      'projectman issue at janoist1/projectman and https://github.com/janoist1/projectman/issues/4';
    expect(textOf(text)).toBe(text);
  });

  it('still covers the GitHub owner elsewhere', () => {
    expect(textOf('github.com/janoist1/other')).toBe('github.com/[redacted:project]/other');
  });

  it('leaves the AI members out of the names it covers', () => {
    expect(textOf('claude-opus-5-5-high asked dev-3')).toBe('claude-opus-5-5-high asked dev-3');
  });
});

describe('redactSystemFeedback: idempotence and counts', () => {
  const sample = [
    'password=hunter99 at /Users/jane/x with jane.doe@corp.example',
    'PM-12 István Jano Éva Zoltánnak ist1@example.com',
    'postgres://u:p@h/db ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'FOO_BAR="a b" Authorization: Bearer abcd1234efgh5678 janoist1/projectman',
  ].join('\n');

  it('gives the same text when run over its own output, and counts nothing the second time', () => {
    const first = redact(sample);
    const second = redact(first.text);
    expect(second.text).toBe(first.text);
    expect(second.counts).toEqual({});
  });

  it('is counted by redactionCounts alike', () => {
    const first = redact(sample);
    expect(redactionCounts(first.text)).toEqual(first.counts);
    expect(redactionCounts('no markers [redacted:nothing]')).toEqual({});
  });

  it('leaves a clean text and its counts alone', () => {
    expect(redact('nothing to see')).toEqual({ text: 'nothing to see', counts: {} });
  });
});

describe('issue address', () => {
  it('puts title and body into the address', () => {
    const { url, bodyInUrl } = systemFeedbackIssueUrl('A b', 'x&y\nz');
    expect(url).toBe(
      `https://github.com/${SYSTEM_FEEDBACK_REPOSITORY}/issues/new?title=A%20b&body=x%26y%0Az`,
    );
    expect(bodyInUrl).toBe(true);
  });

  it('leaves the body out when the address would be too long', () => {
    const { url, bodyInUrl } = systemFeedbackIssueUrl('T', 'x'.repeat(SYSTEM_FEEDBACK_PREFILL_URL_MAX));
    expect(bodyInUrl).toBe(false);
    expect(url).toBe(`https://github.com/${SYSTEM_FEEDBACK_REPOSITORY}/issues/new?title=T`);
  });

  it('keeps a body that just fits', () => {
    const base = `https://github.com/${SYSTEM_FEEDBACK_REPOSITORY}/issues/new?title=T&body=`;
    const body = 'x'.repeat(SYSTEM_FEEDBACK_PREFILL_URL_MAX - base.length);
    expect(systemFeedbackIssueUrl('T', body).bodyInUrl).toBe(true);
    expect(systemFeedbackIssueUrl('T', `${body}x`).bodyInUrl).toBe(false);
  });

  it.each([
    ['https://github.com/janoist1/projectman/issues/12', 12],
    ['https://github.com/janoist1/projectman/issues/12/', 12],
    ['https://github.com/janoist1/projectman/issues/12?x=1', 12],
    ['https://github.com/janoist1/projectman/issues/12#issuecomment-5', 12],
    [' https://github.com/janoist1/projectman/issues/7 ', 7],
  ])('reads the number of %s', (url, number) => {
    expect(parseSystemFeedbackIssueUrl(url)).toBe(number);
  });

  it.each([
    'https://github.com/other/projectman/issues/12',
    'https://github.com/janoist1/other/issues/12',
    'https://github.com/janoist1/projectman/pull/12',
    'http://github.com/janoist1/projectman/issues/12',
    'https://github.com/janoist1/projectman/issues/new',
    'https://github.com/janoist1/projectman/issues/12/extra',
    'https://github.com/janoist1/projectman/issues/0',
    'https://github.com.evil.example/janoist1/projectman/issues/12',
    'https://user@github.com/janoist1/projectman/issues/12',
    'https://github.com/janoist1/projectman-extra/issues/12',
  ])('refuses %s', (url) => {
    expect(parseSystemFeedbackIssueUrl(url)).toBeNull();
  });
});

describe('access and body', () => {
  it.each([
    [true, null, 'manage'],
    [true, 'owner', 'manage'],
    [false, 'owner', 'read'],
    [false, 'admin', null],
    [false, 'developer', null],
    [false, 'client', null],
    [false, 'viewer', null],
    [false, null, null],
  ] as const)('instance owner %s, project access %s -> %s', (instanceOwner, access, expected) => {
    expect(systemFeedbackAccess(instanceOwner, access)).toBe(expected);
  });

  it('builds the body from the headings', () => {
    const labels = { what: 'W', workaround: 'K', fix: 'F', version: 'V', occurrences: 'O' };
    expect(
      formatSystemFeedbackBody(
        { what: 'a', workaround: 'b', fix: 'c', version: '1.2', occurrences: 3 },
        labels,
      ),
    ).toBe('### W\na\n\n### K\nb\n\n### F\nc\n\n---\nV: 1.2 · O: 3');
  });
});

describe('contract', () => {
  it('requires a project exactly for the card mode', () => {
    expect(SetSystemFeedbackForwardingRequest.safeParse({ mode: 'card', projectKey: 'PM' }).success).toBe(
      true,
    );
    expect(SetSystemFeedbackForwardingRequest.safeParse({ mode: 'manual' }).success).toBe(true);
    expect(SetSystemFeedbackForwardingRequest.safeParse({ mode: 'card' }).success).toBe(false);
    expect(SetSystemFeedbackForwardingRequest.safeParse({ mode: 'off', projectKey: 'PM' }).success).toBe(
      false,
    );
  });

  it('tells the prepared results apart', () => {
    expect(SystemFeedbackPrepared.safeParse({ result: 'ready', url: 'u', bodyInUrl: false }).success).toBe(
      true,
    );
    expect(
      SystemFeedbackPrepared.safeParse({ result: 'refiltered', title: 't', body: 'b', counts: { path: 1 } })
        .success,
    ).toBe(true);
    expect(SystemFeedbackPrepared.safeParse({ result: 'ready', title: 't' }).success).toBe(false);
  });

  it('parses an Operator step without the system feedback field as before', () => {
    const step = {
      id: 's',
      requestId: 'r',
      at: 'now',
      action: 'task_move',
      status: 'done',
      taskKey: null,
      member: null,
      changes: [],
      configVersion: null,
      inboxItemId: null,
      signalId: null,
      refusal: null,
    };
    expect(OperatorStep.safeParse(step).success).toBe(true);
    expect(
      OperatorStep.safeParse({
        ...step,
        action: 'system_feedback',
        systemFeedback: { id: 'fb_1', title: 't', occurrence: 2 },
      }).success,
    ).toBe(true);
  });
});
