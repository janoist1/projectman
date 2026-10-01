import { describe, expect, it } from 'vitest';
import { cliExists, resolveCommand, runQuietly } from './cli';
import { FAKE_CLAUDE } from './test-helpers';

describe('resolveCommand', () => {
  it('runs JavaScript CLIs with the current Node binary', () => {
    expect(resolveCommand('/x/fake-claude.mjs', ['-a'])).toEqual({
      file: process.execPath,
      args: ['/x/fake-claude.mjs', '-a'],
    });
    expect(resolveCommand('claude', ['-a'])).toEqual({ file: 'claude', args: ['-a'] });
  });
});

describe('cliExists', () => {
  it('checks that the CLI can be started', async () => {
    const fake = new URL('../../test/fixtures/fake-claude.mjs', import.meta.url).pathname;
    expect(await cliExists(fake, '')).toBe(true);
    expect(await cliExists('/nonexistent/fake-claude.mjs', '')).toBe(false);
    expect(await cliExists('sh', '/usr/bin:/bin')).toBe(true);
    expect(await cliExists('sh', '/nonexistent')).toBe(false);
    expect(await cliExists('/bin/sh', '')).toBe(true);
    expect(await cliExists('/etc', '')).toBe(false);
  });
});

describe('runQuietly', () => {
  it('collects the output and exit code of a short command', async () => {
    const out = await runQuietly(FAKE_CLAUDE, ['--version'], { PATH: process.env.PATH ?? '' });
    expect(out).toMatchObject({ code: 0, error: null });
    expect(out.stdout).toContain('Fake Claude Code');
  });

  it('runs the fake Claude Code only with well-formed --agents, as Claude Code (PM-179)', async () => {
    const env = { PATH: process.env.PATH ?? '' };
    const run = (agents: unknown) =>
      runQuietly(
        FAKE_CLAUDE,
        ['--agents', typeof agents === 'string' ? agents : JSON.stringify(agents), '--version'],
        env,
      );
    const reader = { description: 'Reads logs.', prompt: 'Be short.', tools: ['Read'], model: 'haiku' };
    expect(await run({ 'reader-haiku': reader })).toMatchObject({ code: 0 });
    for (const bad of [
      '{not json',
      [reader],
      { 'reader-haiku': { ...reader, prompt: undefined } },
      { 'reader-haiku': { ...reader, description: '' } },
      { 'reader-haiku': { ...reader, tools: 'Read' } },
      { 'reader-haiku': { ...reader, model: 3 } },
    ]) {
      const out = await run(bad);
      expect(out.code, JSON.stringify(bad)).toBe(1);
      expect(out.stderr).toContain('fake-claude:');
    }
  });

  it('reports a command that cannot be started instead of rejecting', async () => {
    const out = await runQuietly('/nonexistent/cli', [], { PATH: '' });
    expect(out.code).toBeNull();
    expect(out.error).toBeTruthy();
  });
});
