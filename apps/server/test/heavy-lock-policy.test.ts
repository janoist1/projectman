import { describe, expect, it } from 'vitest';
import type { AgentSandbox, SessionPolicy } from '../src/contracts';
import { buildSessionPolicy, sensitivePaths, sessionSandbox } from '../src/domain/session-policy';
import { describeSandbox } from '../src/domain/unattended-commands';
import { testConfig } from './helpers/test-template';

/** The machine's heavy-run queue in the members' sandboxes (PM-336). */
const source = '/fictional/source';
const sharedGit = '/fictional/repo/.git';
const userHome = '/fictional/user';
const appHome = '/fictional/app';
const heavyLockDir = '/fictional/tmp/projectman-501/heavy';

function policy(role: string, placement: SessionPolicy['placement']) {
  return buildSessionPolicy({
    config: testConfig(),
    role,
    task: { repo: 'web' },
    placement,
    permissionMode: 'acceptEdits',
    deniedPaths: sensitivePaths({ userHome, appHome }),
  });
}
const developer = () => policy('developer', { kind: 'task_worktree', path: source, gitDir: sharedGit });
const reader = () => policy('qa', { kind: 'read_only', path: source });
const paths = { userHome, appHome, defaultBranch: 'main' };

describe('the heavy-run queue in the sandbox of a worktree session', () => {
  it('writes the parent of the queue folder, names the folder, and installs from the npm cache', () => {
    const sandbox = sessionSandbox(developer(), { ...paths, heavyLockDir })!;
    expect(sandbox.allowWrite).toEqual(['/fictional/tmp/projectman-501']);
    expect(sandbox.env).toMatchObject({
      PROJECTMAN_HEAVY_LOCK_DIR: heavyLockDir,
      npm_config_prefer_offline: 'true',
    });
  });

  it('is unchanged without a folder', () => {
    const sandbox = sessionSandbox(developer(), paths)!;
    expect(sandbox.allowWrite).toEqual([]);
    expect(sandbox.env).not.toHaveProperty('PROJECTMAN_HEAVY_LOCK_DIR');
    expect(sandbox.env).not.toHaveProperty('npm_config_prefer_offline');
  });

  it('leaves it out when its parent is the home, above it, the app home, above it, or denied', () => {
    for (const dir of [
      `${userHome}/heavy`,
      '/fictional/heavy',
      `${appHome}/heavy`,
      `${userHome}/.ssh/q/heavy`,
    ]) {
      const sandbox = sessionSandbox(developer(), { ...paths, heavyLockDir: dir })!;
      expect(sandbox.allowWrite, dir).toEqual([]);
      expect(sandbox.env, dir).not.toHaveProperty('PROJECTMAN_HEAVY_LOCK_DIR');
    }
  });
});

describe('the heavy-run queue in the sandbox of a reader', () => {
  it('writes the parent of the queue folder and names the folder', () => {
    const sandbox = sessionSandbox(reader(), { heavyLockDir })!;
    expect(sandbox.allowWrite).toEqual(['/fictional/tmp/projectman-501']);
    expect(sandbox.denyWrite).toEqual([source]);
    expect(sandbox.env).toMatchObject({
      PROJECTMAN_HEAVY_LOCK_DIR: heavyLockDir,
      npm_config_prefer_offline: 'true',
    });
  });

  it('is unchanged without a folder', () => {
    const sandbox = sessionSandbox(reader(), {})!;
    expect(sandbox.allowWrite).toEqual([]);
    expect(sandbox.env).not.toHaveProperty('PROJECTMAN_HEAVY_LOCK_DIR');
  });
});

describe('describeSandbox: the machine queue', () => {
  const base = {
    allowWrite: [],
    denyWrite: ['/fictional/work'],
    allowedDomains: ['registry.npmjs.org'],
    allowLocalBinding: true,
  };
  const text = (sandbox: AgentSandbox) =>
    describeSandbox({ sandbox, cwd: '/fictional/work', localOnly: false }).join('\n');

  it('tells the member the heavy runs wait their turn, one at a time, and are best started in the background', () => {
    const out = text({
      ...base,
      env: { PROJECTMAN_HEAVY_LOCK_DIR: heavyLockDir, npm_config_prefer_offline: 'true' },
    });
    expect(out).toContain(
      "- Machine queue: the full test (`npm test` at the root), the full type check (`npm run typecheck`) and `npm run shots` wait their turn in the machine's heavy-run queue, one at a time across members and the server's full test, so start them in the background; targeted runs inside one workspace do not queue.",
    );
  });

  it('keeps the two variables out of the line about the own npm cache', () => {
    const out = text({
      ...base,
      env: {
        npm_config_cache: '/fictional/app/member-caches/AR/dev-1/npm-cache',
        PROJECTMAN_HEAVY_LOCK_DIR: heavyLockDir,
        npm_config_prefer_offline: 'true',
      },
    });
    const line = out.split('\n').find((l) => l.startsWith('- Your own npm cache'))!;
    expect(line).toContain('`npm_config_cache`');
    expect(line).not.toContain('PROJECTMAN_HEAVY_LOCK_DIR');
    expect(line).not.toContain('npm_config_prefer_offline');
  });

  it('says nothing about the queue without the folder', () => {
    expect(text({ ...base, env: {} })).not.toContain('Machine queue');
  });
});
