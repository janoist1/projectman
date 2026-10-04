import { describe, expect, it } from 'vitest';
import { isLoopbackHost, loopbackBaseUrl, parseTerminalMode } from '../src/app';
import type { TerminalModeGuard } from '../src/app';

describe('composition root', () => {
  it('reaches hooks and MCP on the loopback address the server listens on', () => {
    expect(loopbackBaseUrl('127.0.0.1', 4700)).toBe('http://127.0.0.1:4700');
    expect(loopbackBaseUrl('localhost', 4701)).toBe('http://127.0.0.1:4701');
    expect(loopbackBaseUrl('::1', 4702)).toBe('http://[::1]:4702');
  });

  it('accepts only loopback hosts', () => {
    for (const host of ['127.0.0.1', '::1', 'localhost']) expect(isLoopbackHost(host)).toBe(true);
    for (const host of ['0.0.0.0', '::', '', '192.168.1.2']) expect(isLoopbackHost(host)).toBe(false);
  });
});

describe('parseTerminalMode (PM-267)', () => {
  const dev: TerminalModeGuard = {
    home: '/Users/x/.projectman-dev',
    liveHome: '/Users/x/.projectman',
    claudeBin: '/repo/fake-claude.mjs',
    codexBin: '/repo/fake-codex.mjs',
    boundaryConfig: undefined,
    executionProfile: 'legacy',
  };
  const refused = /PROJECTMAN_TERMINAL=pipe is only for development instances with the fake CLIs/;

  it('is pty unless pipe is asked for, and refuses any other value', () => {
    expect(parseTerminalMode(undefined, dev)).toBe('pty');
    expect(parseTerminalMode('', dev)).toBe('pty');
    expect(parseTerminalMode('pty', { ...dev, home: undefined })).toBe('pty');
    expect(() => parseTerminalMode('tty', dev)).toThrow('invalid PROJECTMAN_TERMINAL: tty (pty or pipe)');
  });

  it('allows pipe for a development home with both fake CLIs, also below the live home', () => {
    expect(parseTerminalMode('pipe', dev)).toBe('pipe');
    expect(
      parseTerminalMode('pipe', { ...dev, home: '/Users/x/.projectman/member-caches/dev/projectman-dev' }),
    ).toBe('pipe');
  });

  it('refuses pipe without a home or with the live home', () => {
    expect(() => parseTerminalMode('pipe', { ...dev, home: undefined })).toThrow(refused);
    expect(() => parseTerminalMode('pipe', { ...dev, home: '' })).toThrow(refused);
    expect(() => parseTerminalMode('pipe', { ...dev, home: '/Users/x/.projectman' })).toThrow(refused);
    expect(() => parseTerminalMode('pipe', { ...dev, home: '/Users/x/.projectman/' })).toThrow(refused);
    expect(() => parseTerminalMode('pipe', { ...dev, home: '/Users/x/other/../.projectman' })).toThrow(
      refused,
    );
  });

  it('refuses pipe without CLAUDE_BIN or CODEX_BIN', () => {
    expect(() => parseTerminalMode('pipe', { ...dev, claudeBin: undefined })).toThrow(refused);
    expect(() => parseTerminalMode('pipe', { ...dev, codexBin: '' })).toThrow(refused);
  });

  it('refuses pipe with a boundary configuration or the managed VM profile', () => {
    expect(() =>
      parseTerminalMode('pipe', { ...dev, boundaryConfig: '/etc/projectman/boundary.json' }),
    ).toThrow(refused);
    expect(() => parseTerminalMode('pipe', { ...dev, executionProfile: 'managed_vm' })).toThrow(refused);
  });
});
