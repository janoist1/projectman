import { describe, expect, it } from 'vitest';
import type { CommandOutput } from '../cli';
import { parseClaudeAuthStatus, parseCodexLoginStatus } from './login';

const now = new Date('2026-01-01T00:00:00.000Z');
const out = (stdout: string, stderr = '', code: number | null = 0): CommandOutput => ({
  code,
  stdout,
  stderr,
  error: null,
});

describe('parseClaudeAuthStatus', () => {
  it('reads a subscription login and a missing one', () => {
    expect(
      parseClaudeAuthStatus(
        out(
          '{"loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty", "subscriptionType": "max"}',
        ),
        now,
      ),
    ).toEqual({
      provider: 'claude',
      loggedIn: true,
      method: 'claude.ai',
      checkedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(
      parseClaudeAuthStatus(
        out('{"loggedIn": false, "authMethod": "none", "apiProvider": "firstParty"}', '', 1),
        now,
      ),
    ).toMatchObject({
      loggedIn: false,
      method: 'none',
      problem: 'not_logged_in',
      detail: expect.stringContaining('/login'),
    });
  });

  it('does not count API billing as logged in', () => {
    expect(
      parseClaudeAuthStatus(
        out('{"loggedIn": true, "authMethod": "api_key", "apiProvider": "firstParty"}'),
        now,
      ),
    ).toMatchObject({
      loggedIn: false,
      method: 'api_key',
      problem: 'not_logged_in',
      detail: expect.stringContaining('bills the API'),
    });
    expect(
      parseClaudeAuthStatus(
        out('{"loggedIn": true, "authMethod": "claude.ai", "apiProvider": "bedrock"}'),
        now,
      ),
    ).toMatchObject({ loggedIn: false });
  });

  it('reports unreadable output as unknown', () => {
    expect(parseClaudeAuthStatus(out('', 'error: unknown command auth', 1), now)).toEqual({
      provider: 'claude',
      loggedIn: null,
      method: null,
      checkedAt: '2026-01-01T00:00:00.000Z',
      detail: 'could not read `claude auth status`: error: unknown command auth',
    });
    expect(
      parseClaudeAuthStatus({ code: null, stdout: '', stderr: '', error: 'timed out after 15000 ms' }, now),
    ).toMatchObject({ loggedIn: null, detail: expect.stringContaining('timed out') });
  });
});

describe('parseCodexLoginStatus', () => {
  it('reads the ChatGPT login (printed on stderr) and a missing one', () => {
    expect(parseCodexLoginStatus(out('', 'Logged in using ChatGPT\n'), now)).toEqual({
      provider: 'codex',
      loggedIn: true,
      method: 'chatgpt',
      checkedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(parseCodexLoginStatus(out('', 'Not logged in\n', 1), now)).toMatchObject({
      loggedIn: false,
      method: 'none',
      problem: 'not_logged_in',
      detail: expect.stringContaining('codex login'),
    });
  });

  it('does not count other logins as a subscription', () => {
    expect(parseCodexLoginStatus(out('', 'Logged in using an API key - sk-abc***xyz\n'), now)).toMatchObject({
      loggedIn: false,
      method: 'api_key',
    });
    expect(parseCodexLoginStatus(out('', 'Logged in using Amazon Bedrock API key\n'), now)).toMatchObject({
      loggedIn: false,
      method: 'api_key',
    });
    expect(parseCodexLoginStatus(out('', 'Logged in using access token\n'), now)).toMatchObject({
      loggedIn: false,
      method: 'access_token',
      problem: 'not_logged_in',
    });
  });

  it('reports errors as unknown', () => {
    expect(parseCodexLoginStatus(out('', 'Error checking login status: bad config\n', 1), now)).toMatchObject(
      {
        loggedIn: null,
        method: null,
        detail: 'could not read `codex login status`: Error checking login status: bad config',
      },
    );
  });
});
