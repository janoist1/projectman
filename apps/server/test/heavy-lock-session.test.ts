import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectConfig } from '@projectman/shared';
import { buildCodexArgs } from '../src/runner/providers/codex/args';
import { createDomainHarness, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';

const task = { type: 'task', taskKey: 'AR-1' } as const;

/** The machine's heavy-run queue folder in the sandbox a Codex member starts with (PM-346). */
describe('the heavy-run queue folder of a Codex developer session (PM-346)', () => {
  let h: DomainHarness | undefined;
  let base: string;
  let lockParent: string;
  let lockDir: string;
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'pm-heavy-session-test-')));
    mkdirSync(join(base, 'user-home'));
    mkdirSync(join(base, 'app-home'));
    // The real shape `<tmp>/projectman-<uid>/heavy`; the parent does not exist before the start.
    lockParent = join(base, 'projectman-501');
    lockDir = join(lockParent, 'heavy');
  });
  afterEach(async () => {
    await h?.cleanup();
    h = undefined;
    rmSync(base, { recursive: true, force: true });
  });

  const start = async (adjust?: (config: ProjectConfig) => void) => {
    h = await createDomainHarness({
      userHome: join(base, 'user-home'),
      appHome: join(base, 'app-home'),
      heavyLockDir: lockDir,
      adjust: (config) => {
        const dev = config.team.members.find((m) => m.handle === 'dev-1');
        if (dev?.kind === 'ai') dev.provider = 'codex';
        adjust?.(config);
      },
    });
    await h.domain.tasks.create('AR', { title: 'Login page', repo: 'web' }, OWNER_ACTOR);
    await h.domain.sessions.ensureSession('AR', 'dev-1', task);
    return h.runner.lastStarted();
  };

  it('hands the runner the parent of the folder, makes it, and gives Codex the writable root and the variable', async () => {
    const spec = await start();
    expect(spec.provider).toBe('codex');
    expect(spec.sandbox!.portable).toEqual({
      allowWrite: [lockParent],
      env: { PROJECTMAN_HEAVY_LOCK_DIR: lockDir, npm_config_prefer_offline: 'true' },
    });
    expect(statSync(lockParent).isDirectory()).toBe(true);
    expect(statSync(lockParent).mode & 0o777).toBe(0o700);

    // What Codex is started with: the folder is writable in its own sandbox rules (once its mode lets
    // it write at all) and the variable reaches every command.
    const policy = {
      ...spec.policy!,
      permissions: { ...spec.policy!.permissions, sandbox: 'workspace-write' as const },
    };
    const { args } = buildCodexArgs({
      spec: { ...spec, policy },
      hookUrl: 'http://127.0.0.1:4700/hooks/secret',
      permissionTimeoutMs: 40_000,
      realCwd: spec.cwd,
    });
    const text = args.join('\n');
    expect(text).toContain(`sandbox_workspace_write.writable_roots=["${lockParent}"]`);
    expect(text).toContain(`shell_environment_policy.set.PROJECTMAN_HEAVY_LOCK_DIR="${lockDir}"`);
  });

  it('leaves an existing folder as it is', async () => {
    mkdirSync(lockParent, { mode: 0o700 });
    writeFileSync(join(lockParent, 'keep'), '');
    await start();
    expect(statSync(join(lockParent, 'keep')).isFile()).toBe(true);
  });

  it('starts the session and logs when the folder cannot be made', async () => {
    // A file where the parent should be: the folder cannot be made.
    writeFileSync(lockParent, '');
    const spec = await start();
    expect(spec.sandbox!.portable!.allowWrite).toEqual([lockParent]);
    expect(
      h!.log.warnings.some((entry) => JSON.stringify(entry).includes('could not make a writable path')),
    ).toBe(true);
  });
});
