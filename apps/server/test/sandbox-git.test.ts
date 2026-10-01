import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { userExcludesFile } from '../src/domain/git-excludes';
import { SANDBOX_GIT_ENV } from '../src/domain/session-policy';

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'pm216-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("the git settings of a developer's sandbox (PM-216)", () => {
  it('finds the global core.excludesfile the way the user configured it', () => {
    expect(userExcludesFile(home)).toBeUndefined();
    writeFileSync(
      path.join(home, '.gitconfig'),
      '[user]\n\texcludesfile = /nope\n[core]\n\tautocrlf = false\n',
    );
    expect(userExcludesFile(home)).toBeUndefined();
    writeFileSync(path.join(home, '.gitconfig'), '[core]\n\texcludesFile = ~/.gitignore_global # mine\n');
    expect(userExcludesFile(home)).toBe(path.join(home, '.gitignore_global'));
    writeFileSync(path.join(home, '.gitconfig'), '[core]\n\texcludesfile = "/etc/ignore"\n');
    expect(userExcludesFile(home)).toBe('/etc/ignore');
    // A relative path means nothing to git; the XDG file comes after ~/.gitconfig.
    writeFileSync(path.join(home, '.gitconfig'), '[core]\n\texcludesfile = relative/ignore\n');
    expect(userExcludesFile(home)).toBeUndefined();
    mkdirSync(path.join(home, '.config', 'git'), { recursive: true });
    writeFileSync(path.join(home, '.config', 'git', 'config'), '[core]\n\texcludesfile = /xdg/ignore\n');
    expect(userExcludesFile(home)).toBe('/xdg/ignore');
  });

  it('keeps git from running gc or maintenance on its own', () => {
    const env = {
      PATH: process.env.PATH ?? '',
      HOME: home,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: path.join(home, 'none'),
      ...SANDBOX_GIT_ENV,
    };
    const get = (key: string) => execFileSync('git', ['config', '--get', key], { env }).toString().trim();
    expect(get('gc.auto')).toBe('0');
    expect(get('maintenance.auto')).toBe('false');
  });
});
