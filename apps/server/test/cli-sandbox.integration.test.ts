import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { routes } from '@projectman/shared';
import type { Task } from '@projectman/shared';
import { afterEach, expect, it, vi } from 'vitest';
import { sensitivePaths, WORKTREE_SANDBOX } from '../src/domain';
import { waitFor } from '../src/runner/test-helpers';
import { createAppHarness, createProject, OWNER_LOGIN, setupOwner } from './helpers/app-harness';
import type { CliAppHarness } from './helpers/app-harness';

/**
 * The CLI's own sandbox as the real runner hands it to the fake CLIs (PM-167): a reviewer in Auto
 * with approver none runs in Auto, in a sandbox that writes only the temp directory, with its
 * working directory and the developer's worktree read-only for the shell and the file tools and
 * the credentials unreadable; the developer's sandbox gets the same read denials; a Codex reviewer
 * keeps its read-only sandbox and nothing else.
 */

let h: CliAppHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

interface Started {
  argv: string[];
}

it(
  'hands the reader and the developer sandbox to Claude Code, and leaves Codex as it was',
  { timeout: 90_000 },
  async () => {
    h = await createAppHarness({ runner: 'fake-cli' });
    const { app, home, userHome, workspace } = h;
    const cookie = await setupOwner(app);
    await createProject(h, cookie);
    const { domain } = app.projectman;
    const author = { actor: { kind: 'human' as const, handle: 'owner' }, author: OWNER_LOGIN };
    await domain.projects.update('AR', author, (config) => {
      for (const member of config.team.members) {
        if (member.kind !== 'ai') continue;
        member.permissionMode = 'auto';
        member.approver = 'none';
      }
      return 'Run every AI member in Auto with approver none';
    });
    const created = await app.inject({
      method: 'POST',
      url: routes.tasks('AR'),
      headers: { cookie },
      payload: { title: 'Acme checkout' },
    });
    const { key } = created.json<Task>();
    const item = { type: 'task' as const, taskKey: key };
    const denyRead = sensitivePaths({ userHome, appHome: home });

    let run = 0;
    const start = async (member: string, provider: 'claude' | 'codex' = 'claude'): Promise<string[]> => {
      const file = join(home, `args-${++run}.json`);
      vi.stubEnv(provider === 'codex' ? 'FAKE_CODEX_ARGS_FILE' : 'FAKE_CLAUDE_ARGS_FILE', file);
      const { session } = await domain.sessions.ensureSession('AR', member, item);
      // The login check writes the file too: wait for the session's own start.
      await waitFor(
        () =>
          existsSync(file) &&
          (JSON.parse(readFileSync(file, 'utf8')) as Started).argv.includes(
            provider === 'codex' ? '--sandbox' : '--settings',
          ),
        { what: `the ${member} session to start` },
      );
      await waitFor(() => domain.sessions.get('AR', session.id).state === 'idle', { what: 'idle' });
      return (JSON.parse(readFileSync(file, 'utf8')) as Started).argv;
    };
    const settingsOf = (argv: string[]) => JSON.parse(argv[argv.indexOf('--settings') + 1]!);
    const option = (argv: string[], name: string) => argv[argv.indexOf(name) + 1];

    const developerArgs = await start('dev-1');
    const worktree = domain.sessions.list('AR', { member: 'dev-1' })[0]!.cwd;
    expect(worktree).not.toBe(workspace);
    expect(option(developerArgs, '--permission-mode')).toBe('auto');
    const developer = settingsOf(developerArgs);
    expect(developer.sandbox).toEqual({
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      failIfUnavailable: true,
      filesystem: { allowWrite: WORKTREE_SANDBOX.allowWrite, denyRead },
      network: { allowedDomains: ['registry.npmjs.org'], strictAllowlist: true, allowLocalBinding: true },
    });
    // The developer edits its worktree: no rule takes that away.
    expect(developer.permissions.deny).not.toContain(`Edit(/${worktree}/**)`);

    const readerArgs = await start('cr');
    expect(option(readerArgs, '--permission-mode')).toBe('auto');
    expect(option(readerArgs, '--add-dir')).toBe(worktree);
    const reader = settingsOf(readerArgs);
    expect(reader.sandbox).toEqual({
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      failIfUnavailable: true,
      filesystem: { allowWrite: [], denyWrite: [workspace, worktree], denyRead },
      network: { allowedDomains: ['registry.npmjs.org'], strictAllowlist: true, allowLocalBinding: true },
      excludedCommands: ['gh pr view', 'gh pr diff'],
    });
    // The built-in file tools are outside the sandbox: the rules keep both directories read-only and
    // the credentials out of reach.
    expect(reader.permissions.deny).toEqual(
      expect.arrayContaining([
        `Edit(/${workspace}/**)`,
        `Edit(/${worktree}/**)`,
        `Read(/${join(userHome, '.ssh')})`,
        `Read(/${join(userHome, '.ssh')}/**)`,
      ]),
    );
    expect(reader.permissions.allow).toContain('Bash(gh pr view:*)');

    // A Codex reviewer: its read-only sandbox and its questions, as before.
    const review = domain.sessions.list('AR', { member: 'cr' })[0]!;
    await domain.sessions.stop('AR', review.id);
    await waitFor(() => !app.projectman.runnerModule.runner.isRunning(review.id), {
      what: 'the review session to stop',
    });
    await domain.projects.update('AR', author, (config) => {
      const cr = config.team.members.find((m) => m.handle === 'cr');
      if (cr?.kind === 'ai') cr.provider = 'codex';
      return 'Run the reviewer on Codex';
    });
    const codexArgs = await start('cr', 'codex');
    expect(option(codexArgs, '--sandbox')).toBe('read-only');
    expect(option(codexArgs, '--ask-for-approval')).toBe('on-request');
    expect(JSON.stringify(codexArgs)).not.toContain('sandbox_workspace_write');
    expect(JSON.stringify(codexArgs)).not.toContain('denyWrite');
  },
);
