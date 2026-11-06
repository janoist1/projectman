import { describe, expect, it } from 'vitest';
import { exitOutputTail, OutputTail, redactOutput } from './exit-output';

describe('redactOutput', () => {
  it.each([
    ['http://127.0.0.1:4700/mcp/AbC123dEf456GhI789jKl012MnO345pQ', '/mcp/[redacted]'],
    ['POST /hooks/sometoken failed', '/hooks/[redacted]'],
    ['Authorization: Bearer abc.def.ghi', 'Bearer [redacted]'],
    ['PROJECTMAN_TOKEN=supersecretvalue', 'PROJECTMAN_TOKEN=[redacted]'],
    ['spawn --mcp-token abcdef123456 failed', '--mcp-token [redacted]'],
    ['key pme_abcdefghijklmnopqrstuvwxyz0123456789', '[redacted]'],
    ['value 3f9a1c0b7d2e4a58b6c1d0e9f8a7b6c5d4e3f2a1', '[redacted]'],
  ])('hides the credential in %s', (line, expected) => {
    const out = redactOutput(line);
    expect(out).toContain(expected);
    expect(out).not.toMatch(/AbC123|sometoken|abc\.def|supersecret|abcdef123456|pme_abc|3f9a1c0b/);
  });

  it('keeps a long lowercase branch name and a short value after a secret word', () => {
    const text = 'branch PM-1207-codex-munkamenet-a-ready-elott-kilep: token expired, token: missing';
    expect(redactOutput(text)).toBe(text);
  });
});

describe('OutputTail', () => {
  it('keeps the end of the stream as plain text, without escape sequences', () => {
    const tail = new OutputTail();
    tail.push('\x1b[?2004h\x1b[1;1H\x1b[31mError:\x1b[0m bad config\r\n');
    tail.push('\x1b]0;title\x07second line\r\n');
    expect(tail.plainText()).toBe('\nError: bad config\nsecond line\n');
  });

  it('forgets the start of a long stream', () => {
    const tail = new OutputTail();
    tail.push(`first\n${'x'.repeat(30_000)}\nlast`);
    expect(tail.plainText()).not.toContain('first');
    expect(tail.plainText().endsWith('last')).toBe(true);
  });
});

describe('exitOutputTail', () => {
  it('keeps the last non-empty lines as one bounded line', () => {
    const screen = [...Array.from({ length: 20 }, (_, i) => `line ${i}`), '', ''].join('\n');
    const tail = exitOutputTail(screen);
    expect(tail.endsWith('line 19')).toBe(true);
    expect(tail).not.toContain('line 11');
    expect(tail.split(' | ')).toHaveLength(8);
  });

  it('cuts a very long output to its end', () => {
    const tail = exitOutputTail(Array.from({ length: 8 }, (_, i) => `${i} ${'x'.repeat(300)}`).join('\n'));
    expect(tail.length).toBeLessThanOrEqual(481);
    expect(tail.startsWith('…')).toBe(true);
  });

  it('is empty for an empty screen', () => {
    expect(exitOutputTail('\n  \n')).toBe('');
  });
});
