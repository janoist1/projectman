import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { userExcludesFile } from '../src/domain/git-excludes';
import { SANDBOX_GIT_CONFIG, SANDBOX_GIT_CONFIG_FILE } from '../src/domain/session-policy';

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'pm216-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("the git settings of a developer's sandbox (PM-216)", () => {
  it('finds the global core.excludesfile the way the user configured it', () => {
    const config = path.join(home, '.gitconfig');
    const ignore = path.join(home, '.gitignore_global');
    writeFileSync(ignore, '*.log\n');
    expect(userExcludesFile(home)).toBeUndefined();
    writeFileSync(config, '[user]\n\texcludesfile = /nope\n[core]\n\tautocrlf = false\n');
    expect(userExcludesFile(home)).toBeUndefined();
    writeFileSync(config, '[core]\n\texcludesFile = ~/.gitignore_global # mine\n');
    expect(userExcludesFile(home)).toBe(ignore);
    writeFileSync(config, `[core] excludesfile = ${ignore}\n`);
    expect(userExcludesFile(home)).toBe(ignore);
    writeFileSync(config, `[core "other"]\n\texcludesfile = ${ignore}\n`);
    expect(userExcludesFile(home)).toBeUndefined();
    // A relative path means nothing to git.
    writeFileSync(config, '[core]\n\texcludesfile = relative/ignore\n');
    expect(userExcludesFile(home)).toBeUndefined();
    // Only an existing regular file: not the home, a directory above it, or a missing file.
    for (const value of ['~', '~/', path.dirname(home), path.join(home, 'missing')]) {
      writeFileSync(config, `[core]\n\texcludesfile = ${value}\n`);
      expect(userExcludesFile(home)).toBeUndefined();
    }
    // The XDG file comes after ~/.gitconfig.
    const xdg = path.join(home, 'xdg-ignore');
    writeFileSync(xdg, '*.tmp\n');
    mkdirSync(path.join(home, '.config', 'git'), { recursive: true });
    writeFileSync(path.join(home, '.config', 'git', 'config'), `[core]\n\texcludesfile = ${xdg}\n`);
    expect(userExcludesFile(home)).toBe(xdg);
  });

  it('keeps git from running gc or maintenance on its own and from waiting for the denied lock', () => {
    const file = path.join(home, SANDBOX_GIT_CONFIG_FILE);
    writeFileSync(file, SANDBOX_GIT_CONFIG);
    const env = {
      PATH: process.env.PATH ?? '',
      HOME: home,
      GIT_CONFIG_GLOBAL: path.join(home, 'none'),
      GIT_CONFIG_SYSTEM: file,
      // A session's own entries (safe.directory) keep working next to the file.
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'safe.directory',
      GIT_CONFIG_VALUE_0: home,
    };
    const get = (key: string) => execFileSync('git', ['config', '--get', key], { env }).toString().trim();
    expect(get('gc.auto')).toBe('0');
    expect(get('maintenance.auto')).toBe('false');
    expect(get('core.packedRefsTimeout')).toBe('0');
    expect(get('safe.directory')).toBe(home);
  });
});
