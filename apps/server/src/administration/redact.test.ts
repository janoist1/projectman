import { describe, expect, it } from 'vitest';
import { REDACTED, redactLine } from './redact';

describe('redactLine', () => {
  const SECRET = 'S3cr3tValue0123456789';

  it.each([
    ['a project key', `calling with pmk_${SECRET} now`],
    ['a bearer token', `Authorization: Bearer ${SECRET}.abc-def`],
    ['an API key', `using sk-${SECRET}`],
    ['a GitHub personal token', `ghp_${SECRET}`],
    ['a GitHub OAuth token', `gho_${SECRET}`],
    ['a token assignment', `retry token=${SECRET} failed`],
    ['a key assignment', `api_key=${SECRET}`],
    ['a quoted password assignment', `password="${SECRET} with spaces"`],
    ['a JSON token field', `{"access_token":"${SECRET}","ok":true}`],
    ['a quoted assignment truncated before the closing quote', `password="${SECRET} with spaces`],
    ['a JSON token truncated before the closing quote', `{"access_token":"${SECRET}`],
    ['a long hex run', `digest ${'ab12'.repeat(10)}`],
    ['a long base64 run', `blob ${'Zm9vYmFy0123'.repeat(4)}==`],
  ])('replaces %s', (_name, line) => {
    const redacted = redactLine(line);
    expect(redacted).toContain(REDACTED);
    expect(redacted).not.toContain(SECRET);
    expect(redacted).not.toContain('ab12ab12ab12');
    expect(redacted).not.toContain('Zm9vYmFy0123Zm9v');
  });

  it('leaves an ordinary line, a short id and a long path alone', () => {
    const line =
      'listening on port 4700 for request req_12345 at /Users/someone/projects/application/server/src';
    expect(redactLine(line)).toBe(line);
  });

  it('processes a 64 KiB dotted name without repeated rescanning', () => {
    const line = 'a.'.repeat(32 * 1024);
    const started = performance.now();
    expect(redactLine(line)).toBe(line);
    // The old word-boundary pattern takes several seconds; leave ample room for a busy test host.
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
