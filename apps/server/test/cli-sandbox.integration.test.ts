import { waitForSession } from './helpers/domain-harness';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isOperator, routes } from '@projectman/shared';
import type { Task } from '@projectman/shared';
import { afterEach, expect, it, vi } from 'vitest';
import { SESSION_CONFIG_DIR } from '../src/contracts';
import {
  HARD_DENIED_HOSTS,
  SANDBOX_DENIED_ENV_VARS,
  SANDBOX_PTY_ENV,
  sensitivePaths,
} from '../src/runtime/sessions';
import { claudeLoadedFile, inlineLoadedClaudeConfig, waitFor } from '../src/runner/test-helpers';
import { createAppHarness, createProject, OWNER_LOGIN, setupOwner } from './helpers/app-harness';
import type { CliAppHarness } from './helpers/app-harness';

/**
 * The CLI's own sandbox as the real runner hands it to the fake CLIs (PM-167): a reviewer in Auto
 * with approver none runs in Auto, in a sandbox that writes only the temp directory, with its
 * working directory, the developer's worktree and the app home read-only for the shell and the
 * file tools and the credentials unreadable; the developer's sandbox gets the same read denials; a Codex reviewer
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
  'hands native reader and developer profiles to the CLIs without an automatic Codex home boundary',
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
        // The Operator is fixed (PM-473): its permission mode is not for a test to change.
        if (member.kind !== 'ai' || isOperator(member)) continue;
        member.permissionMode = 'auto';
        member.approver = 'none';
        // PM-355: the network is on by default; the reader has it switched off, to see both shapes.
        if (member.handle === 'cr') member.outboundNetwork = false;
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
    const sessionConfigRoot = join(home, SESSION_CONFIG_DIR);

    let run = 0;
    const start = async (member: string, provider: 'claude' | 'codex' = 'claude'): Promise<string[]> => {
      const file = join(home, `args-${++run}.json`);
      vi.stubEnv(provider === 'codex' ? 'FAKE_CODEX_ARGS_FILE' : 'FAKE_CLAUDE_ARGS_FILE', file);
      vi.stubEnv('FAKE_CLAUDE_LOADED_FILE', claudeLoadedFile(file));
      const { session } = await domain.sessions.ensureSession('AR', member, item);
      // The login check writes the file too: wait for the session's own start.
      await waitFor(
        () =>
          existsSync(file) &&
          (JSON.parse(readFileSync(file, 'utf8')) as Started).argv.includes(
            provider === 'codex' ? '--ask-for-approval' : '--settings',
          ),
        { what: `the ${member} session to start` },
      );
      await waitFor(() => domain.sessions.get('AR', session.id).state === 'idle', { what: 'idle' });
      const { argv } = JSON.parse(readFileSync(file, 'utf8')) as Started;
      // Claude Code is given private launch files that are gone once the session ends (PM-156): the
      // argv here carries the JSON the fake loaded from them.
      return provider === 'claude' ? inlineLoadedClaudeConfig(argv, file) : argv;
    };
    const settingsOf = (argv: string[]) => JSON.parse(argv[argv.indexOf('--settings') + 1]!);
    const option = (argv: string[], name: string) => argv[argv.indexOf(name) + 1];

    const developerArgs = await start('dev-1');
    const worktree = (await waitForSession(domain, { member: 'dev-1' })).cwd;
    expect(worktree).not.toBe(workspace);
    expect(option(developerArgs, '--permission-mode')).toBe('auto');
    const developer = settingsOf(developerArgs);
    // PM-153: nothing below the user's home and the app home is read but its own work; the default
    // branch and the integrating checkout of the shared git directory are not written; no tokens.
    const shared = ['refs/heads/main', 'HEAD', 'index', 'packed-refs'];
    // PM-193: its npm cache and development data are its own, not the host's `~/.npm` and `~/.projectman-dev`.
    const own = [
      join(home, 'member-caches', 'AR', 'dev-1', 'npm-cache'),
      join(home, 'member-caches', 'AR', 'dev-1', 'projectman-dev'),
    ];
    const gitConfig = join(home, 'member-caches', 'AR', 'dev-1', 'gitconfig');
    expect(developer.sandbox).toEqual({
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      failIfUnavailable: true,
      filesystem: {
        allowWrite: own,
        denyWrite: [
          ...shared.flatMap((file) => [
            expect.stringMatching(new RegExp(`/\\.git/${file}$`)),
            expect.stringMatching(new RegExp(`/\\.git/${file}\\.lock$`)),
          ]),
          expect.stringMatching(/\/\.git\/refs\/replace$/),
          expect.stringMatching(/\/\.git\/refs\/projectman$/),
          expect.stringMatching(/\/\.git\/info\/grafts$/),
          // PM-156: the private launch files of the sessions, closed to writing as to reading.
          sessionConfigRoot,
        ],
        denyRead: [userHome, home, ...denyRead],
        allowRead: expect.arrayContaining([worktree, ...own, gitConfig, join(userHome, '.gitconfig')]),
      },
      // PM-355: the network is open by default, minus the blocked hosts.
      network: {
        allowedDomains: ['*'],
        deniedDomains: HARD_DENIED_HOSTS,
        strictAllowlist: true,
        allowLocalBinding: true,
      },
      credentials: { envVars: SANDBOX_DENIED_ENV_VARS.map((name) => ({ name, mode: 'deny' })) },
    });
    expect(developer.env).toEqual({
      npm_config_cache: own[0],
      PROJECTMAN_HOME: own[1],
      ...SANDBOX_PTY_ENV,
      // PM-216: its git settings, a file it can read and not write.
      GIT_CONFIG_SYSTEM: gitConfig,
    });
    expect(developer.sandbox.filesystem.allowWrite).not.toContain(gitConfig);
    // The developer edits its worktree: no rule takes that away; the shared git files it cannot.
    expect(developer.permissions.deny).not.toContain(`Edit(/${worktree}/**)`);
    expect(developer.permissions.deny).toEqual(
      expect.arrayContaining([expect.stringMatching(/^Edit\(\/\/.*\/\.git\/refs\/heads\/main\)$/)]),
    );

    const readerArgs = await start('cr');
    expect(option(readerArgs, '--permission-mode')).toBe('auto');
    expect(option(readerArgs, '--add-dir')).toBe(worktree);
    const reader = settingsOf(readerArgs);
    expect(reader.sandbox).toEqual({
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      failIfUnavailable: true,
      // The app home holds every member's worktree and workspace: read-only as a whole (PM-188).
      filesystem: {
        allowWrite: [],
        denyWrite: [workspace, worktree, home, sessionConfigRoot],
        // PM-425: the home and the app home are closed to reading, with every Claude transcript; only its
        // own project and card (the worktree, the git settings) are opened again.
        denyRead: expect.arrayContaining([
          userHome,
          home,
          ...denyRead,
          join(userHome, '.claude', 'projects'),
        ]),
        allowRead: expect.arrayContaining([worktree, join(userHome, '.gitconfig')]),
      },
      network: { allowedDomains: ['registry.npmjs.org'], strictAllowlist: true, allowLocalBinding: true },
      // The repository is on GitHub: `gh` with any arguments, as a command of its own (PM-188).
      excludedCommands: ['gh pr view:*', 'gh pr diff:*'],
    });
    // The built-in file tools are outside the sandbox: the rules keep the directories read-only and
    // the credentials out of reach.
    expect(reader.permissions.deny).toEqual(
      expect.arrayContaining([
        `Edit(/${workspace})`,
        `Edit(/${workspace}/**)`,
        `Edit(/${worktree}/**)`,
        `Edit(/${home}/**)`,
        `Read(/${join(userHome, '.ssh')})`,
        `Read(/${join(userHome, '.ssh')}/**)`,
        `Read(/${join(userHome, '.claude', 'projects')}/**)`,
      ]),
    );
    expect(reader.permissions.allow).toContain('Bash(gh pr view:*)');
    // PM-425: no file tool is allowed on every path; the card's worktree is allowed by name.
    expect(reader.permissions.allow).not.toEqual(expect.arrayContaining(['Read']));
    expect(reader.permissions.allow).not.toEqual(expect.arrayContaining(['Grep']));
    expect(reader.permissions.allow).not.toEqual(expect.arrayContaining(['Glob']));
    expect(reader.permissions.allow).toContain(`Read(/${worktree}/**)`);

    // A Codex reviewer: its read-only sandbox and its questions, as before.
    const review = await waitForSession(domain, { member: 'cr' });
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
    expect(codexArgs).not.toContain('--sandbox');
    expect(codexArgs).toContain('default_permissions="projectman"');
    expect(
      codexArgs.some(
        (arg) => arg.startsWith('permissions.projectman=') && arg.includes('extends=":read-only"'),
      ),
    ).toBe(true);
    // PM-425: the reviewer's profile closes the home and the app home, and opens its own worktree again.
    const reviewerProfile = codexArgs.find((arg) => arg.startsWith('permissions.projectman='))!;
    expect(reviewerProfile).toContain(`"${userHome}"="deny"`);
    expect(reviewerProfile).toContain(`"${home}"="deny"`);
    expect(reviewerProfile).toContain(`"${worktree}"="read"`);
    expect(option(codexArgs, '--ask-for-approval')).toBe('on-request');
    expect(JSON.stringify(codexArgs)).not.toContain('sandbox_workspace_write');
    expect(JSON.stringify(codexArgs)).not.toContain('denyWrite');

    await domain.projects.update('AR', author, (config) => {
      const dev = config.team.members.find((m) => m.handle === 'dev-2');
      if (dev?.kind === 'ai') dev.provider = 'codex';
      return 'Run a developer on Codex';
    });
    for (const resume of [false, true]) {
      const argv = await start('dev-2', 'codex');
      const running = await waitForSession(domain, { member: 'dev-2' });
      const profile = argv.find((arg) => arg.startsWith('permissions.projectman='))!;
      expect(profile).not.toContain(`"${userHome}"="deny"`);
      expect(profile).not.toContain(`"${home}"="deny"`);
      expect(profile).toContain(':workspace_roots');
      expect(profile).toContain(`"${join(userHome, '.ssh')}"="deny"`);
      expect(profile).toContain('":tmpdir"="write"');
      expect(profile).toContain('":slash_tmp"="write"');
      expect(argv.includes('resume')).toBe(resume);
      await domain.sessions.stop('AR', running.id);
      await waitFor(() => !app.projectman.runnerModule.runner.isRunning(running.id), {
        what: 'the Codex developer to stop',
      });
    }
  },
);
