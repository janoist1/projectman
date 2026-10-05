import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cliExists, resolveCliPath, resolveCommand, runQuietly } from './cli';
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

describe('resolveCliPath', () => {
  it('resolves the first executable on PATH through a symlink chain and keeps scripts supported', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'pm-cli-path-'));
    try {
      const dir = await realpath(tmp);
      await mkdir(path.join(dir, 'bin'));
      const executable = path.join(dir, 'codex-real');
      await writeFile(executable, '#!/bin/sh\n', { mode: 0o700 });
      await symlink(executable, path.join(dir, 'link'));
      await symlink(path.join(dir, 'link'), path.join(dir, 'bin', 'codex'));
      expect(await resolveCliPath('codex', path.join(dir, 'bin'))).toBe(executable);
      expect(await resolveCliPath(path.join(dir, 'link'), '')).toBe(executable);
      const script = path.join(dir, 'fake.mjs');
      await writeFile(script, '', { mode: 0o600 });
      expect(await resolveCliPath(script, '')).toBe(script);
      expect(await resolveCliPath('missing', path.join(dir, 'bin'))).toBeNull();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
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
