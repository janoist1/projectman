import { describe, expect, it } from 'vitest';
import { AI_BUILT_IN_ROLE_IDS, BUILT_IN_ROLE_IDS } from '@projectman/shared';
import { testConfig, testTemplate } from './helpers/test-template';
import { aiRoleDefaults } from '@projectman/templates';
import {
  allowedToolsFor,
  DEVELOPMENT_TOOLS,
  LOCAL_ONLY_DENIED_TOOLS,
  deniedToolsFor,
  commandVerdict,
  readableRootsFor,
  READ_ONLY_REVIEW_TOOLS,
  sessionPolicyFor,
  TEAM_TOOLS_ALLOWED,
  usesWorktree,
} from '../src/domain';

describe('role session policy', () => {
  // The built-in duty bundles: no overrides and no custom roles.
  const team = testConfig();

  it('pre-approves list_tasks alongside get_task for every AI role', () => {
    for (const role of [...AI_BUILT_IN_ROLE_IDS, 'data_steward']) {
      expect(allowedToolsFor(role, team)).toContain('mcp__team__*');
    }
  });

  it('pre-approves the read-only tools for review and research roles', () => {
    const readers = BUILT_IN_ROLE_IDS.filter((role) => sessionPolicyFor(role, team).readOnlyTools);
    expect(readers).toContain('code_review');
    expect(readers).toContain('devops');
    expect(allowedToolsFor('architect', team)).toEqual([...TEAM_TOOLS_ALLOWED, ...READ_ONLY_REVIEW_TOOLS]);
    expect(allowedToolsFor('developer', team)).toEqual([...TEAM_TOOLS_ALLOWED, ...DEVELOPMENT_TOOLS]);
  });

  it('runs the roles that change files in the task worktree, and every role starts on Auto', () => {
    const worktreeRoles = BUILT_IN_ROLE_IDS.filter((role) => usesWorktree(role, team));
    expect(worktreeRoles.sort()).toEqual(
      ['content', 'designer', 'developer', 'docs', 'maintainer', 'translator'].sort(),
    );
    for (const role of AI_BUILT_IN_ROLE_IDS) {
      expect(aiRoleDefaults(role).permissionMode, role).toBe('auto');
      // Nobody both changes files and gets the review tools pre-approved.
      expect(sessionPolicyFor(role, team).readOnlyTools && usesWorktree(role, team), role).toBe(false);
    }
  });

  it('gives custom roles the team tools only, in the workspace', () => {
    expect(allowedToolsFor('data_steward', team)).toEqual(TEAM_TOOLS_ALLOWED);
    expect(usesWorktree('data_steward', team)).toBe(false);
  });
});

const config = testTemplate.build({
  key: 'AR',
  name: 'Fictional project',
  workspacePath: '/workspace',
  language: 'en',
  owner: { handle: 'owner', displayName: 'Example Owner', email: 'owner@example.com' },
});
config.project.repos.push({ name: 'local', path: 'local', defaultBranch: 'main' });
const cwd = '/worktrees/AR/AR-1-local';
const input = {
  config,
  session: { cwd, role: 'developer' },
  task: { repo: 'local' },
  toolName: 'Bash',
  worktreesRootDir: '/worktrees',
};
const verdict = (command: string) => commandVerdict({ ...input, toolInput: { command } });

describe('automatic command policy', () => {
  it.each(['git status', 'cat README.md', 'npm ci', 'git add -A', 'git commit -m "Example"'])(
    'requires an explicit NanoGPT decision for %s',
    (command) => {
      const request = { ...input, readableRoots: [cwd], toolInput: { command } };
      for (const provider of ['claude', 'codex'] as const)
        expect(commandVerdict({ ...request, session: { ...input.session, provider } })).toEqual({
          behavior: 'allow',
        });
      expect(commandVerdict({ ...request, session: { ...input.session, provider: 'nanogpt' } })).toBeNull();
    },
  );

  it.each(['git push', 'gh pr create', 'gh pr merge 12', 'sed -i s/a/b/ README.md'])(
    'retains automatic NanoGPT denials for %s',
    (command) => {
      expect(
        commandVerdict({
          ...input,
          session: { ...input.session, provider: 'nanogpt' },
          toolInput: { command },
        }),
      ).toMatchObject({ behavior: 'deny' });
    },
  );

  it('only refuses publishing rules for a configured local-only task repository', () => {
    expect(deniedToolsFor(config, { repo: 'local' })).toEqual(LOCAL_ONLY_DENIED_TOOLS);
    for (const task of [null, { repo: null }, { repo: 'web' }, { repo: 'missing' }])
      expect(deniedToolsFor(config, task)).toEqual([]);
    expect(DEVELOPMENT_TOOLS).toContain('Bash(npm install)');
    expect(DEVELOPMENT_TOOLS).toContain('Bash(npm ci)');
    expect(DEVELOPMENT_TOOLS).not.toContain('Bash(npm install:*)');
  });

  it.each([
    'git push',
    'git push origin HEAD',
    'cd /workspace && git push origin main',
    'gh pr create --title "Example"',
    'gh pr merge 12',
    'npm test && git push',
    'git\tpush',
    'git commit -m "Example" && gh pr create',
  ])('denies local-only publishing: %s', (command) => {
    expect(verdict(command)).toEqual({
      behavior: 'deny',
      message: 'The owner has not allowed publishing from this repository.',
    });
  });

  it.each([
    'echo "git push"',
    'git pushy',
    'gh pr view 12',
    'git status',
    'git remote add push-mirror /example',
  ])('does not treat quoted prose or other commands as publishing: %s', (command) => {
    expect(verdict(command)).toBeNull();
  });

  it.each([
    'git commit -m "Document git push"',
    "git commit -m 'Document gh pr create and gh pr merge'",
    String.raw`git commit -m "Mention \"git push\" in docs"`,
  ])('allows a commit whose message only mentions publishing: %s', (command) => {
    expect(verdict(command)).toEqual({ behavior: 'allow' });
  });

  // Whatever the allow rules understand, the deny rule reads the raw text: a command the parser
  // refuses is denied just the same.
  it.each([
    'git push origin HEAD &',
    'git push $(git remote)',
    'git push\norigin HEAD',
    'ls\ngit push',
    'echo x > out && git push',
    "git commit -m 'unbalanced && git push",
    'git push 2>&1 | tee log',
    'cd ~ && git push',
    'git push; git push',
    'gh pr create --title "unbalanced',
    'npm ci && gh pr merge 12 || true',
    'git status && git push',
    'git log | head && git push',
  ])(
    'denies local-only publishing in a command that cannot be parsed or is otherwise allowed: %s',
    (command) => {
      const denied = {
        behavior: 'deny',
        message: 'The owner has not allowed publishing from this repository.',
      };
      expect(verdict(command)).toEqual(denied);
      expect(commandVerdict({ ...input, readableRoots: [cwd], toolInput: { command } })).toEqual(denied);
      expect(
        commandVerdict({
          ...input,
          session: { cwd: '/workspace', role: 'code_review' },
          readableRoots: ['/workspace', cwd],
          toolInput: { command },
        }),
      ).toEqual(denied);
    },
  );

  it('leaves publishing from GitHub repositories for a human, regardless of cwd', () => {
    expect(
      commandVerdict({ ...input, task: { repo: 'web' }, toolInput: { command: 'git push' } }),
    ).toBeNull();
    expect(
      commandVerdict({
        ...input,
        session: { cwd: '/workspace', role: 'code_review' },
        toolInput: { command: 'git push' },
      })?.behavior,
    ).toBe('deny');
  });

  it.each([
    'npm ci',
    'npm install',
    ' npm ci ',
    'npm\tci',
    'npm ci --prefer-offline --no-audit --no-fund',
    'npm install --no-fund --no-audit',
    `cd ${cwd} && npm ci`,
    `cd '${cwd}' && npm install`,
    `cd "${cwd}" && npm ci --no-audit`,
    'cd . && npm ci',
  ])('allows lockfile installs in the worktree: %s', (command) => {
    expect(verdict(command)).toEqual({ behavior: 'allow' });
  });

  it.each([
    'npm install left-pad',
    'npm ci --ignore-scripts',
    'npm install --save left-pad',
    'cd /elsewhere && npm ci',
    'cd .. && npm ci',
    'cd "$PWD" && npm ci',
    'npm ci | tee log.txt',
    'npm ci > /elsewhere/log',
    'npm ci\necho done',
    'npm\nci',
    'npm ci &',
    'env npm ci',
    `cd ${cwd} && cd ${cwd} && npm ci`,
    'npm ci --no-audit=true',
  ])('leaves wider installs and shell commands for a human: %s', (command) => {
    expect(verdict(command)).toBeNull();
  });

  it('does not allow installs outside the root, without a task or for a review role', () => {
    for (const cwd of ['/workspace', '/worktrees', '/worktrees-other/AR/AR-1', '/worktrees/../outside'])
      expect(
        commandVerdict({ ...input, session: { cwd, role: 'developer' }, toolInput: { command: 'npm ci' } }),
      ).toBeNull();
    expect(commandVerdict({ ...input, task: null, toolInput: { command: 'npm ci' } })).toBeNull();
    expect(
      commandVerdict({ ...input, worktreesRootDir: undefined, toolInput: { command: 'npm ci' } }),
    ).toBeNull();
    expect(
      commandVerdict({ ...input, session: { cwd, role: 'code_review' }, toolInput: { command: 'npm ci' } }),
    ).toBeNull();
  });

  it('ignores non-Bash tools and malformed command inputs', () => {
    expect(commandVerdict({ ...input, toolName: 'Read', toolInput: { command: 'git push' } })).toBeNull();
    for (const toolInput of [null, 'git push', {}, { command: 42 }])
      expect(commandVerdict({ ...input, toolInput })).toBeNull();
  });
});

describe('routine formatting in the developer worktree (PM-109)', () => {
  const allowed = { behavior: 'allow' };

  it.each([
    'npx prettier --write apps/web/src/features/board/TaskDrawer.test.tsx',
    'npx prettier -w .',
    'npx prettier src/a.ts --write docs/a.md',
    'npx prettier --write "docs/a file.md"',
    "npx prettier --write 'src/**/*.ts' *.md .prettierrc.json",
    'npx prettier --write -- -odd-name.ts',
    `npx prettier --write ${cwd}/src/a.ts ${cwd}`,
    'npm run format',
    'npx prettier --write src/a.ts && npx vitest run test/a.test.ts',
    'npx prettier -w src/a.ts || npm run format',
    'git status; npm run format; git add -A',
    `cd ${cwd} && npm run format && npm run typecheck`,
    'npx prettier --write src/a.ts 2>&1 | tail -3',
    'npm run format 2>&1 | grep formatted | head -10',
    'npm run format >/dev/null 2>&1; npm test',
    "npx prettier --write apps/web/src/features/board/TaskDrawer.test.tsx >/dev/null 2>&1; npm run typecheck 2>&1 | grep -v '^npm\\|^$\\|^>' | head; npm test 2>&1 | grep -E 'Test Files|Tests |FAIL|×' | head -30",
  ])('allows %s', (command) => {
    expect(verdict(command)).toEqual(allowed);
  });

  it.each([
    'npx prettier --write ../other/x.ts',
    'npx prettier -w ..',
    'npx prettier --write /elsewhere/x.ts',
    `npx prettier --write ${cwd}-other/x.ts`,
    'npx prettier --write src/a.ts ../other/x.ts',
    'npx prettier --write -- ../other/x.ts',
    'npx prettier --write src/../../other/x.ts',
    "npx prettier --write '.*'",
    'npx prettier --write',
    'npx prettier --write ""',
    'npx prettier --write=false .',
    'npx prettier --write . --config /elsewhere/prettier.json',
    'npx prettier --write . --plugin ./plugin.js',
    'npx prettier --write . --ignore-path ../other/ignore',
    'npm run format -- ../other/x.ts',
    'npm run format --prefix /elsewhere',
    'npm run format:other',
    'cd apps && npx prettier --write .',
    'npx prettier --write src/a.ts | tee log.txt',
    'cat files.txt | npx prettier --write src/a.ts',
    'npm run format > log.txt',
    'npx prettier --write src/a.ts; touch other.ts',
    'npx prettier --write ../other/x.ts && npm test',
    'npx prettier --write /elsewhere/x.ts 2>&1 | head',
  ])('leaves wider formatting commands for a human: %s', (command) => {
    expect(commandVerdict({ ...input, readableRoots: [cwd], toolInput: { command } })).toBeNull();
  });

  it.each(['npx prettier --write src/a.ts', 'npx prettier -w .', 'npm run format'])(
    'keeps %s to task sessions that may write in their worktree',
    (command) => {
      for (const overrides of [
        { session: { cwd: '/workspace', role: 'developer' } },
        { session: { cwd, role: 'code_review' } },
        { task: null },
        { worktreesRootDir: undefined },
      ]) {
        expect(
          commandVerdict({
            ...input,
            ...overrides,
            readableRoots: ['/workspace', cwd],
            toolInput: { command },
          }),
        ).toBeNull();
      }
    },
  );
});

describe('routine git steps in the developer worktree (PM-77)', () => {
  const allowed = { behavior: 'allow' };

  it.each([
    // The commands a Codex developer asked a human about, whose sandbox keeps the shared .git read-only.
    'git commit -am "Clarify the settings history section"',
    'git merge --ff-only main',
    'git merge --ff-only 7480374',
    // Steps and their spellings.
    'git add -A && git commit -m "x"',
    `cd ${cwd} && git commit -am 'y'`,
    `cd "${cwd}/" && git add . && git commit -m "Add the history section" && git merge --ff-only origin/main`,
    'cd . && git add -A',
    'git add .',
    'git add -A',
    'git add --all',
    'git add -u',
    'git add --update',
    'git add',
    'git add apps/web/src/features/settings/HistorySection.tsx docs/ROADMAP.md',
    'git add ./apps/web "docs/a file.md" src/**/*.ts *.md [a-c]?.txt',
    'git add -- -odd-name.txt',
    'git add -A -- apps/web',
    `git add ${cwd}/apps/web ${cwd}`,
    'git add ../AR-1-local/apps',
    'git commit -m x',
    'git commit -m x -m y',
    'git commit -a -m "x"',
    'git commit --all --quiet --message "x"',
    'git commit -q -am x',
    'git commit --message=x',
    'git commit --message=x --message "y"',
    'git commit -m ""',
    'git commit -m -a',
    'git commit -m "Fix a && b; c | d > e"',
    'git commit -m "Run git push next"',
    "git commit -m 'Cost: $5, `x`, (y), {z}, ~w, #v, !u, \\t, <s>'",
    'git commit -m "Update the \\"history\\" section"',
    'git merge --ff-only abcdef0123456789abcdef0123456789abcdef01',
    'git merge --quiet --ff-only ABCDEF0',
    'git merge --ff-only -q origin/main',
    'git merge --ff-only --ff-only main',
    'npm ci && git add -A && git commit -m "Install"',
    'git commit -m x && git merge --ff-only main && npm install --no-audit',
    // Patterns that stay inside the worktree, and dot files that are named.
    'git add apps/*',
    'git add *.ts src/*',
    'git add src/**/*.tsx',
    'git add .gitignore .github/* src/.hidden/x',
    // Read-only commands between the routine steps (a chain of them alone is for the read-only rule).
    'git status && git add -A && git commit -m x',
    'git status --short && git diff --stat && git add -A && git commit -m "Add the history section"',
    'git commit -m x && git status',
    'git commit -m x && git log -1 --oneline && git merge --ff-only main',
    `cd ${cwd} && git status && git add apps/web && git commit -m x`,
    'ls apps/web && git add apps/web && git commit -m x',
    'cat README.md && git add README.md',
    'npm ci && npm run typecheck && git add -A && git commit -m x',
    'git diff --name-only main && git add -A',
    'git branch --show-current && git commit -am x',
    'git rev-parse --short HEAD && git merge --ff-only main',
    'cat apps/*/package.json && git add -A',
  ])('allows %s', (command) => {
    expect(verdict(command)).toEqual(allowed);
  });

  it.each([
    // Rewriting, skipping checks, an editor, other sources of a message, empty commits.
    'git commit --amend -m x',
    'git commit --amend --no-edit',
    'git commit -m x --amend',
    'git commit --no-verify -m x',
    'git commit -n -m x',
    'git commit -m x -n',
    'git commit',
    'git commit -a',
    'git commit -q',
    'git commit -m',
    'git commit -am',
    'git commit -F message.txt',
    'git commit --file message.txt',
    'git commit --file=message.txt -m x',
    'git commit -C HEAD',
    'git commit -c HEAD -m x',
    'git commit --fixup HEAD -m x',
    'git commit --fixup=HEAD',
    'git commit --squash HEAD -m x',
    'git commit --author="A <a@example.com>" -m x',
    'git commit --allow-empty -m x',
    'git commit --date=2020-01-01 -m x',
    'git commit -s -m x',
    'git commit -e -m x',
    'git commit -m x file.txt',
    'git commit -m x -- file.txt',
    'git commit -mx',
    'git commit -ma',
    'git commit -qam x',
    'git commit --message',
    'git commit --mess=x',
    // Options before the subcommand, but a `-C` to the working directory itself (see `git -C` below).
    'git -C /other commit -m x',
    'git -c user.name=x commit -m x',
    'git --git-dir=/other/.git commit -m x',
    'git --work-tree=/other commit -m x',
    'git --no-pager commit -m x',
    'git -P add -A',
    'git add -A && git -C /other commit -m x',
    // Paths outside the worktree, options of `git add` that add more or ask questions.
    'git add ../outside',
    'git add ../../AR-2-local/x',
    'git add /etc/passwd',
    'git add /worktrees/AR/AR-2-local',
    'git add /worktrees',
    'git add ..',
    'git add ../AR-1-local/..',
    'git add apps/../../outside',
    'git add apps/..',
    'git add -A ../outside',
    'git add -- ../outside',
    'git add -f .env',
    'git add --force .',
    'git add -p',
    'git add -i',
    'git add -e',
    'git add -N x',
    'git add --intent-to-add x',
    'git add --chmod=+x x',
    'git add --pathspec-from-file=list.txt',
    'git add --dry-run .',
    'git add -n .',
    'git add -v .',
    'git add -Au',
    // Merges that are not a fast-forward of the default branch or a commit.
    'git merge main',
    'git merge origin/main',
    'git merge --ff-only',
    'git merge --ff-only feature-x',
    'git merge --ff-only origin/feature-x',
    'git merge --ff-only main extra',
    'git merge --ff-only main origin/main',
    'git merge --ff-only abcdef',
    'git merge --ff-only abcdef0123456789abcdef0123456789abcdef012',
    'git merge --ff-only ghijklm',
    'git merge --ff-only HEAD~1',
    'git merge --ff-only -',
    'git merge --ff-only --abort',
    'git merge --no-ff main',
    'git merge --ff main',
    'git merge --abort',
    'git merge --ff-only main --no-verify',
    'git merge --ff-only -m x main',
    'git merge -s ours --ff-only main',
    'git merge --ff-only refs/heads/main',
    // Installs other than a lockfile install.
    'npm publish',
    'npm test',
    'npm run build',
    'npm cache clean --force',
    'npm i',
    'npm ci-foo',
    'npm',
    // A `cd` anywhere but first and to the working directory.
    'cd /tmp && git add .',
    "cd '' && git add .",
    'cd "" && npm ci',
    'cd .. && git add .',
    'cd apps && git add .',
    'cd && git add .',
    'cd - && git add .',
    'cd ~ && git add .',
    `cd ${cwd} cd && git add .`,
    `cd ${cwd} && cd ${cwd} && git add .`,
    'git add . && cd . && git add .',
    // A chain of read-only commands alone is for the read-only rule, and `cd` is not one of them.
    'cd . && git status',
    'git status && git log -1',
    'ls && cat README.md',
    'cd .',
    // Read-only steps between routine ones that leave the worktree, write, or are no command of their own.
    'git status && cat ../outside && git add -A',
    'git add -A && cat ../outside',
    'cat /etc/passwd && git add -A',
    'git status && ls .. && git commit -m x',
    'git status && ls /worktrees && git add -A',
    'git status && ls /worktrees/AR/AR-2-local && git add -A',
    'git status && cat ../AR-2-local/x && git add -A',
    'git status && cat apps/../../x && git add -A',
    'git status && git log --output=/tmp/x && git add -A',
    'git status && git -C /other log && git add -A',
    'git status && find . -delete && git add -A',
    "git status && find . -exec rm '{}' ';' && git add -A",
    'git status && sort -o out README.md && git add -A',
    'git status && tail -f log && git add -A',
    'git status && rm -rf dist && git add -A',
    'git status && touch x && git add -A',
    'git status && git checkout main && git add -A',
    'git status && git reset --hard && git add -A',
    'git status && git commit --amend -m x',
    'git status && git add ../x',
    'git status && git merge main',
    'git status && npm install left-pad && git add -A',
    'git status && npm publish',
    'git status && cd apps && git add -A',
    'git status && cd .. && git add -A',
    'git status && xargs cat && git add -A',
    'git status & git add -A',
    // Patterns that can match `.` and `..` climb out of the worktree (bash before 5.2).
    'git add .*',
    'git add -A .*',
    'git add -- .*',
    'git add src/.*',
    'git add .?',
    'git add .[a-z]*',
    'git add .*/x',
    'git status && cat .* && git add -A',
    'git status && ls .? && git commit -m x',
    // Anything the parser does not understand completely.
    'git commit -m "$(rm -rf /)"',
    'git commit -m "`rm -rf /`"',
    'git commit -m $(rm -rf /)',
    'git commit -m x; rm -rf /',
    'git commit -m x && rm -rf /',
    'git commit -m x > f',
    'git commit -m x >> f',
    'git commit -m x < f',
    'git commit -m x &',
    'git commit -m x\nrm -rf /',
    'git commit -m "$HOME"',
    'git commit -m unbalanced"',
    'git add ~/notes',
    'git add $HOME',
    'git add {a,b}',
    'git add (x)',
    'GIT_DIR=/other git commit -m x',
    'env git commit -m x',
    'sudo git commit -m x',
    'command git commit -m x',
    '/usr/bin/git commit -m x',
    './git commit -m x',
    'git   ',
    'git',
    'commit -m x',
    '',
  ])('leaves %j for a human', (command) => {
    expect(verdict(command)).toBeNull();
  });

  it('uses the default branch of the task repository', () => {
    const released = testTemplate.build({
      key: 'AR',
      name: 'Fictional project',
      workspacePath: '/workspace',
      language: 'en',
      owner: { handle: 'owner', displayName: 'Example Owner', email: 'owner@example.com' },
    });
    released.project.repos.push({ name: 'local', path: 'local', defaultBranch: 'release/1.0' });
    const merge = (ref: string, withConfig = released) =>
      commandVerdict({
        ...input,
        config: withConfig,
        toolInput: { command: `git merge --ff-only ${ref}` },
      });
    expect(merge('release/1.0')).toEqual(allowed);
    expect(merge('origin/release/1.0')).toEqual(allowed);
    expect(merge('main')).toBeNull();
    expect(merge('origin/main')).toBeNull();
    expect(merge('abcdef0')).toEqual(allowed);

    // A repository the configuration does not know has no default branch to merge.
    const mergeUnknown = (ref: string) =>
      commandVerdict({
        ...input,
        task: { repo: 'unknown' },
        toolInput: { command: `git merge --ff-only ${ref}` },
      });
    expect(mergeUnknown('main')).toBeNull();
    expect(mergeUnknown('origin/main')).toBeNull();
    expect(mergeUnknown('origin/undefined')).toBeNull();
    expect(mergeUnknown('abcdef0')).toEqual(allowed);

    // A default branch that looks like an option is never a ref to merge.
    const odd = testTemplate.build({
      key: 'AR',
      name: 'Fictional project',
      workspacePath: '/workspace',
      language: 'en',
      owner: { handle: 'owner', displayName: 'Example Owner', email: 'owner@example.com' },
    });
    odd.project.repos.push({ name: 'local', path: 'local', defaultBranch: '--abort' });
    expect(merge('--abort', odd)).toBeNull();
  });

  it('does not apply outside the worktrees root, without a task repository or for a review role', () => {
    const commit = { command: 'git commit -am "Example"' };
    for (const elsewhere of [
      '/',
      '/workspace',
      '/worktrees',
      '/worktrees-other/AR/AR-1',
      '/worktrees/../outside',
    ])
      expect(
        commandVerdict({ ...input, session: { cwd: elsewhere, role: 'developer' }, toolInput: commit }),
      ).toBeNull();
    expect(commandVerdict({ ...input, task: null, toolInput: commit })).toBeNull();
    expect(commandVerdict({ ...input, task: { repo: null }, toolInput: commit })).toBeNull();
    expect(commandVerdict({ ...input, worktreesRootDir: undefined, toolInput: commit })).toBeNull();
    for (const role of ['code_review', 'architect', 'devops', 'data_steward'])
      expect(commandVerdict({ ...input, session: { cwd, role }, toolInput: commit }), role).toBeNull();
    // Every role whose duties change files is a developer for this rule.
    for (const role of ['developer', 'designer', 'docs', 'maintainer', 'translator', 'content'])
      expect(commandVerdict({ ...input, session: { cwd, role }, toolInput: commit }), role).toEqual(allowed);
  });

  it("applies in a developer's own member workspace too (PM-138)", () => {
    const commit = { command: 'git commit -am "Example"' };
    const own = { cwd: '/workspaces/AR/dev-1/local/repo', role: 'developer' };
    const roots = { worktreesRootDir: '/worktrees', workspacesRootDir: '/workspaces' };
    expect(commandVerdict({ ...input, ...roots, session: own, toolInput: commit })).toEqual(allowed);
    expect(commandVerdict({ ...input, session: own, toolInput: commit })).toBeNull();
    for (const elsewhere of [
      '/workspaces',
      '/workspaces-other/AR/dev-1/local/repo',
      '/workspaces/../outside',
    ])
      expect(
        commandVerdict({
          ...input,
          ...roots,
          session: { cwd: elsewhere, role: 'developer' },
          toolInput: commit,
        }),
      ).toBeNull();
    expect(
      commandVerdict({ ...input, ...roots, session: { ...own, role: 'code_review' }, toolInput: commit }),
    ).toBeNull();
  });

  it('also holds for a review role when it is given the git steps in the read-only rule', () => {
    const roots = ['/workspace', cwd];
    const reviewer = { ...input, session: { cwd: '/workspace', role: 'code_review' }, readableRoots: roots };
    for (const command of [
      'git commit -m x',
      'git add -A',
      'git merge --ff-only main',
      'npm ci',
      'git status && git add -A && git commit -m x',
      `cd ${cwd} && git commit -m x`,
      `cd ${cwd} && git status && git commit -m x`,
    ])
      expect(commandVerdict({ ...reviewer, toolInput: { command } }), command).toBeNull();
  });

  it('reads the read-only steps of a chain with the worktree as the only directory', () => {
    // Its own rule would allow the reviewer to read the workspace as well, the chain may not.
    const roots = { readableRoots: ['/workspace', cwd] };
    const chain = (command: string) => commandVerdict({ ...input, ...roots, toolInput: { command } });
    expect(chain('git status && git add -A && git commit -m x')).toEqual(allowed);
    expect(chain('ls apps && git add -A')).toEqual(allowed);
    expect(chain('cat /workspace/README.md && git add -A')).toBeNull();
    expect(chain('ls /workspace && git add -A')).toBeNull();
    expect(chain('cat ../AR-2-local/x && git add -A')).toBeNull();
    // The same read-only command alone is for the read-only rule, which has both roots.
    expect(chain('cat /workspace/README.md')).toEqual(allowed);
  });

  it('keeps a chain with read-only steps from publishing', () => {
    const chain = (repo: string, command: string) =>
      commandVerdict({ ...input, task: { repo }, toolInput: { command } });
    // A repository without GitHub: denied first, as before.
    expect(chain('local', 'git status && git add -A && git push')).toEqual({
      behavior: 'deny',
      message: 'The owner has not allowed publishing from this repository.',
    });
    // A repository on GitHub: a human decides.
    expect(chain('web', 'git status && git add -A && git push')).toBeNull();
    expect(chain('web', 'git status && git add -A && git commit -m x')).toEqual(allowed);
    expect(chain('web', 'git status && gh pr create --title x')).toBeNull();
  });
});

describe('escapes inside double quotes', () => {
  it.each([
    'git commit -m "a\\nb"',
    'git commit -m "costs \\$5, not \\`free\\`"',
    'git commit -m "a\\$(rm -rf /)"',
  ])('allows %s: the shell keeps it as literal message text', (command) => {
    expect(verdict(command)).toEqual({ behavior: 'allow' });
  });
});

// The first real trial stalled on three harmless commands: a commit with a message of several lines,
// a chain that mixed `&&`, `;` and a pipeline, and `git -C` to the worktree itself.
describe('the commands of the first trial', () => {
  const allowed = { behavior: 'allow' };
  const publishing = {
    behavior: 'deny',
    message: 'The owner has not allowed publishing from this repository.',
  };
  const commit =
    'git add apps && git commit -q -m "Subject line (PM-93)\n\nCo-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"';
  const chain = `${commit} && git log --oneline | head -1; git status --short`;
  /** The session may read its own worktree too, so the read-only rule has its say. */
  const withRoots = (command: string, roots = [cwd]) =>
    commandVerdict({ ...input, readableRoots: roots, toolInput: { command } });

  it('allows the commit with a message of several lines, and the chain that went on from it', () => {
    for (const command of [commit, chain, `cd ${cwd} && ${chain}`]) {
      expect(verdict(command), command).toEqual(allowed);
      expect(withRoots(command), command).toEqual(allowed);
    }
  });

  it('allows `git -C` to the worktree of the session', () => {
    const command = `git -C ${cwd} log --oneline -1`;
    expect(withRoots(command)).toEqual(allowed);
    expect(withRoots(`${command} && git -C ${cwd} status --short`)).toEqual(allowed);
    // The routine rule has no step in it: a reader alone waits for the read-only rule and its roots.
    expect(verdict(command)).toBeNull();
  });

  describe('a newline inside quotes', () => {
    it.each([
      'git commit -m "one\ntwo"',
      "git commit -m 'one\ntwo'",
      'git commit -m "Subject\n\nBody line\n\nCo-Authored-By: A <a@example.com>"',
      'git commit -m "a" -m "b\nc"',
      'git commit --message="one\ntwo"',
      'git commit -am "one\ntwo" && git merge --ff-only main',
      'git add -A && git commit -m "a && b;\nc | d > e\n(f) {g} ~h #i !j"',
      // A line continuation in double quotes joins the lines.
      'git commit -m "one \\\ntwo"',
    ])('allows a commit message of several lines: %j', (command) => {
      expect(verdict(command)).toEqual(allowed);
    });

    it.each([
      // A newline outside quotes ends a command in a shell.
      'git status\nrm -rf /',
      'git add -A\ngit commit -m x',
      'git commit -m x\nrm -rf /',
      'git commit -m "one\ntwo"\nrm -rf /',
      'git add -A &&\ngit commit -m x',
      'git add -A\n&& git commit -m x',
      'git add -A;\ngit commit -m x',
      'git add -A\n',
      '\ngit add -A',
      'npm ci\necho done',
      // A backslash before a newline outside quotes.
      'git add -A \\\n&& git commit -m x',
      'git commit -m x \\\n-m y',
      // A carriage return and every other control character, inside quotes too.
      'git commit -m "one\r\ntwo"',
      'git commit -m "one\rtwo"',
      "git commit -m 'one\rtwo'",
      'git commit -m "one\u0000two"',
      'git commit -m "one\u000btwo"',
      'git commit -m "one\u001btwo"',
      'git commit -m "one\u007ftwo"',
      'git commit -m "one\u0085two"',
      // Quotes that do not close, however many lines follow.
      'git commit -m "one\ntwo',
      "git commit -m 'one\ntwo",
      'git commit -m "one\\\n',
      // An expansion hides in a message of several lines as it does in one.
      'git commit -m "one\n$(rm -rf /)"',
      'git commit -m "one\n`rm -rf /`"',
      'git commit -m "one\n$HOME"',
      'git commit -m "one\\\n$HOME"',
    ])('leaves %j for a human', (command) => {
      expect(verdict(command)).toBeNull();
      expect(withRoots(command)).toBeNull();
    });

    it('still denies publishing next to a message of several lines', () => {
      for (const command of [
        'git commit -m "one\ntwo" && git push',
        "git commit -m 'one\ntwo' && gh pr create --title x",
        'git commit -m "one\ntwo"\ngit push',
        // The quotes must pair up as the shell pairs them, or a `git push` hides between two strings.
        'git commit -m "one\\\ntwo" && git push && echo "x"',
        'git commit -m "one\\\ntwo" && gh pr merge 12 || echo "x"',
      ])
        expect(verdict(command), command).toEqual(publishing);
    });

    it('does not take prose of several lines for publishing', () => {
      for (const command of [
        'git commit -m "Document\ngit push"',
        "git commit -m 'Document\ngh pr create and gh pr merge'",
        'git commit -m "Document \\\ngit push"',
        'git commit -m "a\\\nb" -m "git push"',
      ])
        expect(verdict(command), command).toEqual(allowed);
    });

    it('reads a line continuation as the shell does, so a path is checked where it leads', () => {
      // The shell runs `cat ../etc/passwd`, which is outside the worktree.
      for (const command of [
        'cat "..\\\n/etc/passwd"',
        'git add -A && cat "..\\\n/etc/passwd"',
        'cat "..\\\n/etc/passwd" | head ; git add -A',
        'git add "..\\\n/outside"',
        'git add -A && ls "..\\\n/"',
        'cat ".\\\n./x" | head',
        `cd "${cwd}/..\\\n" && git add -A`,
      ]) {
        expect(verdict(command), command).toBeNull();
        expect(withRoots(command), command).toBeNull();
      }
      // The two characters are removed, not kept: the `cd` names the working directory, the paths lie inside it.
      expect(verdict(`cd "${cwd}\\\n" && git add -A`)).toEqual(allowed);
      expect(verdict('git add "apps\\\n/web"')).toEqual(allowed);
      expect(withRoots('cat "README\\\n.md" | head')).toEqual(allowed);
    });
  });

  describe('a chain of routine and read-only steps joined with &&, || and ;', () => {
    it.each([
      `${chain}`,
      'git add -A ; git commit -m x',
      'git add . || git commit -m x',
      'git add -A; git commit -m x; git log -1 --oneline',
      'git add -A && git commit -m x || git status',
      'npm ci; echo done',
      'npm ci && npm run typecheck 2>&1 | tail -5; git add -A',
      // Read-only steps may be whole pipelines, with the redirections the parser knows.
      'git status | head && git add -A',
      'git status 2>&1 && git add -A',
      'git status ; git add -A',
      'git status || git add -A',
      'git ls-files | xargs cat && git add -A',
      'git diff --stat | tail -3; git add -A && git commit -m x',
      'git diff --name-only | sort -u | head -5 ; git add -A',
      'git add -A && echo done >/dev/null 2>&1',
      'git add -A; ls apps | wc -l || true',
      // The first segment may still be a `cd` that stays where it is.
      `cd ${cwd} ; git add -A`,
      `cd ${cwd} && git status | head -3; git add -A; git log --oneline | head -1`,
      `cd . || git add -A`,
      // A routine step may be filtered by readers and carry the redirections the parser knows (PM-105).
      'npm install --prefer-offline --no-audit --no-fund 2>&1 | tail -3',
      'npm ci | tail -5',
      'git commit -m "x" 2>&1 | head -2',
      'git commit -m x 2>&1',
      'git commit -m x >/dev/null',
      'git add -A | cat',
      'git add -A | git status',
      'npm ci 2>&1 ; git add -A',
      'git add -A 2>&1; git status',
      'git commit -m x >/dev/null || git status',
      'npm ci 2>&1 | grep -c added | tail -1',
      'npm ci 2>&1 | head -n 5 2>&1 && git add -A',
      'git add -A && npm ci --no-audit 2>&1 | tail -3 && git commit -m x 2>&1 | head -2',
      `cd ${cwd} && npm ci 2>&1 | tail -3`,
    ])('allows %j', (command) => {
      expect(verdict(command)).toEqual(allowed);
    });

    it.each([
      // A pipe into a routine step, or out of one, is no routine step.
      'git status | git add -A',
      'git log | git commit -m x',
      'echo x | git commit -m y',
      'git add -A && git status | git commit -m x',
      'git add -A; git log -1 | git merge --ff-only main',
      'git add -A; git ls-files | xargs git add --',
      // Only readers may follow a routine step in its pipeline, none that writes or leaves the worktree.
      'npm install | tee log.txt',
      'npm install --prefer-offline --no-audit --no-fund 2>&1 | tee log.txt',
      'npm ci | tail -5 | tee log.txt',
      'npm ci | sort -o out',
      'npm ci | cat /etc/passwd',
      'npm ci | cat ../outside',
      'npm ci | tail -f log',
      'npm ci | rm -rf dist',
      'npm ci | sh',
      'npm ci | xargs rm',
      'npm ci | npm ci',
      'npm ci | git add -A',
      'git commit -m x | tee out',
      'git add -A | git commit -m x',
      'git add -A 2>&1 | tee out ; git status',
      // The step itself must be routine.
      'npm publish 2>&1 | tail -3',
      'npm install left-pad 2>&1 | tail -3',
      'git commit --amend -m x 2>&1 | head -2',
      'git add /etc 2>&1 | tail -3',
      'git status 2>&1 | tee out ; git status',
      // A routine step in a later stage of a pipeline.
      'cat README.md | npm ci',
      'git status 2>&1 | git add -A',
      // A redirection that is no known one is no command at all.
      'npm ci > log.txt',
      'npm ci 2>&1 | tail -3 > log.txt',
      // The first segment is the only `cd`, and it stays in place.
      'git status ; cd . ; git add -A',
      'git status || cd apps ; git add -A',
      'git add -A ; cd .. ; git status',
      `cd ${cwd} ; cd ${cwd} ; git add -A`,
      'cd . ; cd . ; git add -A',
      'cd /tmp ; git add -A',
      'cd apps ; git add -A',
      'cd .. || git add -A',
      'cd . 2>&1 ; git add -A',
      'cd . | cat ; git add -A',
      'git add -A ; git status | cd apps',
      'git add -A ; pushd apps',
      // A read-only pipeline that leaves the worktree, or writes.
      'git add -A; cat ../outside | head -1',
      'git add -A ; ls .. | wc -l',
      'git commit -m x && git ls-files /etc | head',
      'git add -A || ls /worktrees | wc -l',
      'git status | cat /etc/passwd ; git add -A',
      'git status | sort -o out ; git add -A',
      'git status | tee out ; git add -A',
      'git add -A; git ls-files | xargs cat /etc/passwd',
      'git add -A; git ls-files | xargs rm',
      'git add -A; find . -delete | head',
      'git add -A; cat /workspace/README.md | head',
      // Nothing runs in the background or is cut off.
      'git add -A & git status',
      'git add -A ;',
      'git add -A ||',
      '; git add -A',
    ])('leaves %j for a human', (command) => {
      expect(verdict(command)).toBeNull();
      expect(withRoots(command)).toBeNull();
    });

    it('leaves a chain of readers alone to the read-only rule, whatever joins them', () => {
      for (const command of [
        'git status ; git log -1',
        'git status | head || git log -1',
        'ls && cat README.md | head',
        'git log --oneline | head -1; git status --short',
      ]) {
        expect(verdict(command), command).toBeNull();
        expect(withRoots(command), command).toEqual(allowed);
      }
    });

    it('reads the read-only steps with the worktree as the only directory, pipelines included', () => {
      const roots = ['/workspace', cwd];
      expect(withRoots('git status | head ; git add -A', roots)).toEqual(allowed);
      expect(withRoots('git add -A || cat /workspace/README.md | head', roots)).toBeNull();
      expect(withRoots('git add -A ; ls /workspace | wc -l', roots)).toBeNull();
      expect(withRoots('git add -A ; git ls-files /workspace | xargs cat', roots)).toBeNull();
      // The same pipeline alone is for the read-only rule, which has both directories.
      expect(withRoots('cat /workspace/README.md | head', roots)).toEqual(allowed);
    });

    it('keeps a chain from publishing', () => {
      expect(verdict('git add -A ; git push')).toEqual(publishing);
      expect(verdict('git status | head ; git push || git add -A')).toEqual(publishing);
      // A repository on GitHub: a human decides about the push, not about the rest.
      const onGithub = (command: string) =>
        commandVerdict({ ...input, task: { repo: 'web' }, toolInput: { command } });
      expect(onGithub('git add -A ; git push')).toBeNull();
      expect(onGithub('git add -A ; git log -1 | head; git status')).toEqual(allowed);
    });
  });

  describe('git -C to the directory the command runs in', () => {
    const asReviewer = (command: string) =>
      commandVerdict({
        ...input,
        session: { cwd: '/workspace', role: 'code_review' },
        readableRoots: ['/workspace', cwd],
        toolInput: { command },
      });

    it.each([
      `git -C ${cwd} log --oneline -1`,
      `git -C ${cwd} status --short`,
      `git -C ${cwd}/ log -1`,
      `git -C '${cwd}' log -1`,
      `git -C "${cwd}" diff --stat | head -5`,
      'git -C . log --oneline -1',
      'git -C ./ status',
      `git -C ${cwd} ls-files | wc -l`,
      `git -C ${cwd} log -1 && git -C . status`,
      `git -C ${cwd} rev-parse HEAD 2>&1 | head -1`,
      `git -C ${cwd} branch --show-current`,
      // After a `cd` the command runs in its target.
      `cd ${cwd}/apps && git -C ${cwd}/apps log -1`,
      'cd apps && git -C . log -1',
      `cd ${cwd}/apps ; git -C . log -1`,
    ])('allows a reader to name its own directory: %j', (command) => {
      expect(withRoots(command)).toEqual(allowed);
    });

    it.each([
      // To another directory, inside the worktree or not.
      'git -C /elsewhere log',
      `git -C ${cwd}/apps log`,
      'git -C apps log',
      'git -C .. log',
      `git -C ${cwd}/.. log`,
      `git -C ${cwd}/apps/.. log`,
      'git -C / log',
      `git -C ${cwd}-other log`,
      // Twice, and with other options before the subcommand.
      `git -C ${cwd} -C /elsewhere log`,
      `git -C /elsewhere -C ${cwd} log`,
      `git -C ${cwd} -C ${cwd} log`,
      'git -C . -C . log',
      'git -c x=y log',
      'git -c core.pager=x log',
      `git -c x=y -C ${cwd} log`,
      `git -C ${cwd} -c x=y log`,
      'git --git-dir=/elsewhere/.git log',
      `git -C ${cwd} --git-dir=/elsewhere/.git log`,
      'git --work-tree=/elsewhere status',
      `git -C ${cwd} --work-tree=/elsewhere status`,
      `git -C ${cwd} --no-pager log`,
      // No directory, no subcommand, or a directory the text cannot tell.
      'git -C',
      'git -C .',
      `git -C ${cwd}`,
      'git -C "" log',
      "git -C '' log",
      'git -C $PWD log',
      'git -C ~ log',
      'git -C * log',
      'git -C .* log',
      'git -C .[a-z]* log',
      `git -C${cwd} log`,
      'git -C. log',
      // The rest is judged as if `-C` were absent.
      `git -C ${cwd} log --output=/tmp/x`,
      `git -C ${cwd} log -- /etc/passwd`,
      `git -C ${cwd} checkout main`,
      `git -C ${cwd} status && rm -rf x`,
      `git -C ${cwd} cat-file --batch`,
      `git -C ${cwd} grep -O vi foo`,
      // What `xargs` runs, and feeds it, is read as written.
      'git ls-files | xargs git -C . log --',
      `git ls-files | xargs -I X git -C ${cwd} log -1 -- X`,
      'git -C . ls-files | xargs cat',
      `git -C ${cwd} diff --name-only | xargs cat`,
    ])('leaves %j for a human', (command) => {
      expect(withRoots(command)).toBeNull();
    });

    it('takes the directory from the session: a reviewer runs in the workspace, not in the worktree', () => {
      expect(asReviewer('git -C /workspace log -1')).toEqual(allowed);
      expect(asReviewer('git -C . log -1')).toEqual(allowed);
      // The worktree is among its roots, but it is not where the command runs.
      expect(asReviewer(`git -C ${cwd} log -1`)).toBeNull();
      // Every separator so far is `&&`: the command runs where the `cd` led.
      expect(asReviewer(`cd ${cwd} && git -C ${cwd} log -1`)).toEqual(allowed);
      expect(asReviewer(`cd ${cwd} && git -C . log -1`)).toEqual(allowed);
      expect(asReviewer(`cd ${cwd} && git -C /workspace log -1`)).toBeNull();
      // After `;` or `||` it may run in either directory, and only `.` names both.
      expect(asReviewer(`cd ${cwd} ; git -C . log -1`)).toEqual(allowed);
      expect(asReviewer(`cd ${cwd} || git -C . log -1`)).toEqual(allowed);
      expect(asReviewer(`cd ${cwd} ; git -C ${cwd} log -1`)).toBeNull();
      expect(asReviewer(`cd ${cwd} ; git -C /workspace log -1`)).toBeNull();
    });

    it.each([
      `git -C ${cwd} add -A`,
      `git -C ${cwd} commit -m x`,
      `git -C ${cwd} commit -am "one\ntwo"`,
      `git -C ${cwd} merge --ff-only main`,
      `git -C ${cwd} add apps/web docs`,
      'git -C . commit -m x',
      'git -C ./ add -A',
      `git -C ${cwd}/ commit -m x`,
      `git -C '${cwd}' add -A`,
      `git -C "${cwd}" commit -m x`,
      'git -C . add -A && git -C . commit -m x',
      `cd ${cwd} && git -C ${cwd} add -A && git -C ${cwd} commit -m x`,
      `git -C ${cwd} status && git -C ${cwd} add -A && git -C ${cwd} commit -m x && git -C ${cwd} log --oneline -1`,
      `git -C ${cwd} add -A ; git commit -m x`,
    ])('allows the routine step with `-C` to the worktree: %j', (command) => {
      expect(verdict(command)).toEqual(allowed);
    });

    it.each([
      'git -C /other commit -m x',
      `git -C ${cwd}/apps commit -m x`,
      'git -C apps add -A',
      'git -C .. add -A',
      `git -C ${cwd} -C . commit -m x`,
      `git -C . -C ${cwd} add -A`,
      `git -C ${cwd} -C /elsewhere commit -m x`,
      `git -C /elsewhere -C ${cwd} commit -m x`,
      `git -C ${cwd} -c user.name=x commit -m x`,
      `git -c user.name=x -C ${cwd} commit -m x`,
      `git -C ${cwd} --git-dir=/other/.git commit -m x`,
      `git -C ${cwd} --work-tree=/other add -A`,
      `git -C ${cwd} --no-pager commit -m x`,
      // The rest is judged as if `-C` were absent.
      'git -C . commit',
      'git -C . commit --amend -m x',
      `git -C ${cwd} commit --no-verify -m x`,
      `git -C ${cwd} add ../outside`,
      `git -C ${cwd} merge main`,
      // No directory, no subcommand, or a directory the text cannot tell.
      'git -C .',
      'git -C',
      "git -C '' commit -m x",
      'git -C $PWD commit -m x',
      'git -C .* add -A',
      'git -C * add -A',
      `git -C ${cwd}/../AR-1-local commit -m x`,
      'git add -A && git -C /other commit -m x',
      'git status && git -C /other log && git add -A',
    ])('leaves the step %j for a human', (command) => {
      expect(verdict(command)).toBeNull();
    });
  });
});

describe('read-only commands for any AI session on a task (PM-69)', () => {
  it.each(['printf -v PATH ./bin; cat README.md', 'printf -vPATH ./bin && ls', 'cat ""~/.ssh/id_rsa'])(
    'leaves %s for a human: it could change what later commands run or read',
    (command) => {
      expect(commandVerdict({ ...input, readableRoots: [cwd], toolInput: { command } })).toBeNull();
    },
  );

  it('still allows printf with a format', () => {
    const command = "printf '%s\\n' a b";
    expect(commandVerdict({ ...input, readableRoots: [cwd], toolInput: { command } })).toEqual({
      behavior: 'allow',
    });
  });

  it('allows a grep whose double-quoted pattern escapes dots, as a developer wrote it in the first trial', () => {
    const command = `cd ${cwd}/apps/web/src && grep -rnE "task\\.(edit|save|move\\.|labels\\.a)" . | head -40`;
    expect(commandVerdict({ ...input, readableRoots: [cwd], toolInput: { command } })).toEqual({
      behavior: 'allow',
    });
  });

  const allowed = { behavior: 'allow' };
  const reviewerCwd = '/workspace';
  const roots = [reviewerCwd, cwd];
  const reviewer = { ...input, session: { cwd: reviewerCwd, role: 'code_review' }, readableRoots: roots };
  const read = (command: string, overrides: Partial<Parameters<typeof commandVerdict>[0]> = {}) =>
    commandVerdict({ ...reviewer, ...overrides, toolInput: { command } });

  it.each([
    // The chains a Claude reviewer asked a human about.
    `cd ${cwd} && git status --short && git log -1 --oneline && grep -rn "sections.history" apps/web/src | head -30`,
    'ls node_modules >/dev/null 2>&1 && echo has_modules; npm run typecheck 2>&1 | tail -5; npx vitest run --root apps/web src/features/settings',
    'git diff --name-only main | xargs grep -n foo',
    // Git.
    'git status',
    'git status --short --branch',
    'git diff',
    'git diff main...HEAD --stat',
    'git diff --name-only origin/main',
    'git diff --no-ext-diff HEAD~1 -- apps/web',
    'git log --oneline -n 20',
    'git log -1 --format=%H main',
    "git log --pretty=format:'%h %s' --since='2 days ago' -- docs",
    'git log -S"history" --all',
    'git show HEAD:apps/web/src/main.tsx',
    'git show --stat HEAD~1',
    'git rev-parse --show-toplevel',
    'git rev-parse HEAD^',
    'git merge-base main HEAD',
    'git ls-files | wc -l',
    'git ls-files apps/web/src',
    'git blame -L1,5 README.md',
    'git grep -n "history" -- apps/web',
    'git grep -ni history',
    'git grep --no-index foo apps',
    'git shortlog -sn',
    'git describe --always --dirty',
    'git diff-tree --no-commit-id --name-only -r HEAD',
    'git name-rev HEAD',
    'git cat-file -p HEAD',
    'git cat-file -t HEAD',
    'git cat-file -s HEAD:README.md',
    'git cat-file -e HEAD:README.md',
    'git branch',
    'git branch --show-current',
    'git branch -a',
    'git branch -r',
    'git branch -v',
    'git branch -vv',
    "git branch --list 'PM-*'",
    "git branch -l 'PM-*' 'feature/*'",
    'git branch --contains abc1234',
    "git branch -a --contains abc1234 'feature/*'",
    'git branch --contains=abc1234',
    'git branch --contains',
    // Search and file readers.
    'grep -rn foo apps/web/src',
    'grep -rn foo --include=*.ts apps',
    'grep -E "a|b" README.md',
    'rg -n foo apps/web/src',
    'rg --files -g "*.ts" apps',
    'cat README.md docs/ROADMAP.md',
    'cat -n apps/web/src/main.tsx | head -40',
    'head -20 README.md',
    'head -n 5 README.md | tail -n 2',
    'tail -n 20 README.md',
    'tail -5 README.md',
    'wc -l apps/web/src/*.ts',
    'ls',
    'ls -la apps/web',
    'ls apps/*/src',
    // Patterns that cannot start with a dot stay inside; options with a pattern are no paths.
    'cat *.ts',
    'ls src/*',
    'ls *',
    'ls *.ts *.md',
    'cat apps/*/package.json',
    'wc -l src/**/*.ts',
    'cat [a-c]*.md',
    'cat .gitignore',
    'ls .github/*',
    'git show HEAD:.*',
    'grep -rn foo --include=.*',
    'pwd',
    'echo hello',
    'echo "Has modules: yes" && echo done',
    "printf '%s\\n' a b",
    'git diff --name-only | cut -d/ -f1 | sort -u',
    'echo a-b | tr - _',
    'nl README.md',
    'file README.md',
    'stat README.md',
    'du -sh apps',
    'diff README.md docs/ROADMAP.md',
    'basename apps/web',
    'dirname apps/web',
    'realpath apps/web',
    'realpath .',
    'true',
    'sort README.md',
    'sort -u -k2,2 -t: -r README.md',
    'sort -nr',
    'uniq README.md',
    'uniq -c',
    'uniq -c -f 1 README.md',
    'sort README.md | uniq -c | sort -nr | head',
    "find apps -name '*.ts' -not -path '*/node_modules/*'",
    'find . -maxdepth 2 -type f -name "*.md"',
    'find apps/web -newer README.md -print0',
    // `xargs` is fed by a lister, through whole-line filters, and runs a reader.
    "find . -name '*.ts' | xargs wc -l",
    "git ls-files | grep '\\.ts$' | xargs grep -l bar | head",
    'git ls-files -z | xargs -0 -r wc -l',
    'git ls-files | xargs -n 5 -P 4 cat',
    'git ls-files | xargs -n1 -L1 head -1',
    "git ls-files | xargs -I '{}' git log -1 --format=%h -- '{}'",
    "git ls-files | xargs -I'{}' git log -1 --format=%h -- '{}'",
    "git ls-files | xargs -d '\\n' wc -l",
    'git ls-files -z | xargs -0 -r -n 2 -L 3 -P 4 -I X -d , ls',
    // A command whose options could write or run something gets the names after `--`.
    'git ls-files | xargs git log -1 --oneline --',
    'git ls-files | xargs git diff --stat --',
    'git diff --name-only | xargs git diff --stat HEAD~1 --',
    'git ls-files | xargs rg foo --',
    'git ls-files | xargs sort --',
    'git ls-files | xargs sort -u --',
    'git ls-files | xargs -n 1 diff -u README.md --',
    'git ls-files | xargs -I X git log -1 --format=%h -- X',
    'git ls-files | xargs -I X rg foo -- X',
    'git ls-files | xargs -I X sort -u -- X',
    'git ls-files | xargs -I X git show HEAD:X',
    'git ls-files | xargs -I X git show -s --format=%h HEAD -- X Y',
    'git ls-files | xargs -I Y -I X git log -1 -- X',
    // A placeholder that only stands where a name goes: an operand, never the program or an option.
    'git ls-files | xargs -I X head -1 X',
    'git ls-files | xargs -I X git show HEAD:X',
    'git ls-files | xargs -IX grep -n foo X',
    'git ls-files | xargs -I FILE wc -l FILE',
    "git ls-files | xargs -I '{}' cat '{}'",
    'git diff --name-only --diff-filter=M main...HEAD | xargs wc -l',
    'git diff --name-status HEAD~1 | xargs -n 1 echo',
    'git diff --name-only -z | xargs -0 cat',
    'git diff --cached --name-only | xargs head -1',
    'git diff --name-only HEAD~1 HEAD -- apps/web | xargs grep -n foo | head -20',
    'git ls-files apps/web | xargs wc -l | sort -n | tail -5',
    'git ls-files | xargs grep -n foo | cut -d: -f1 | sort -u',
    'git grep -l foo | xargs wc -l',
    'git grep -il foo -- apps | xargs head -1',
    'git grep -l -e foo -e bar | xargs cat',
    'git grep --name-only foo | xargs cat',
    'git grep -L foo -- docs | xargs wc -l',
    'grep -rl foo apps/web | xargs wc -l',
    "grep -rli --include='*.ts' foo . | xargs wc -l",
    'grep -l foo README.md docs/ROADMAP.md | xargs head -1',
    'grep -L foo *.md | xargs wc -l',
    'grep --files-with-matches foo README.md | xargs cat',
    'grep -lZ foo README.md | xargs -0 cat',
    'grep -rl -e foo -e bar . | xargs cat',
    'grep -rn -l foo . | xargs cat',
    'rg -l foo apps | xargs wc -l',
    "rg --files -g '*.ts' apps | xargs wc -l",
    'rg --files-with-matches foo | xargs cat',
    "rg -l -g '*.ts' foo | xargs head -1",
    "find apps -name '*.ts' 2>/dev/null | xargs grep -l foo | head",
    'find . -type f -print0 | xargs -0 wc -l',
    'ls | xargs wc -l',
    'ls apps | xargs -n 1 echo',
    'git diff --relative --name-only | xargs cat',
    'git diff --name-only --relative main | xargs cat',
    'git diff --find-renames --name-only | xargs cat',
    'git diff --name-only --find-renames=50% | xargs cat',
    'git diff -M --name-status | xargs cat',
    'git grep --no-index -l foo apps | xargs cat',
    'rg --files --glob "*.ts" | xargs wc -l',
    "rg -l --glob='*.ts' foo | xargs cat",
    'rg --files --type ts | xargs wc -l',
    'rg --files -t ts -T js | xargs wc -l',
    'rg --files --max-depth 2 | xargs wc -l',
    'rg -l -e foo -e bar | xargs cat',
    'rg --files --hidden --no-ignore | xargs wc -l',
    'rg -li foo | xargs cat',
    'git ls-files | sort -S1M | xargs cat',
    'git ls-files | sort -S 10% -u | xargs cat',
    'git ls-files | sort -k 2 -t : | xargs cat',
    'git ls-files | uniq -c -f 1 | xargs cat',
    'git ls-files | uniq -s 2 | xargs cat',
    'git ls-files | grep -- -x | xargs cat',
    'git ls-files | grep - | xargs cat',
    'git ls-files | head -n 5 | tail -n 2 | xargs cat',
    'git diff --name-only | sort -u | head -20 | xargs cat',
    'git diff --name-only | grep -v test | xargs cat',
    "git ls-files | grep -E 'a|b' | xargs cat",
    'git ls-files | grep -e foo -e bar | xargs cat',
    'git ls-files | grep -iv x | xargs cat',
    'git ls-files | grep -ea | xargs cat',
    'git ls-files | grep --invert-match test | xargs cat',
    'git ls-files | grep --ignore-case --extended-regexp "a|b" | xargs cat',
    'git ls-files | grep --regexp=a --regexp b | xargs cat',
    'git ls-files | grep --no-filename x | xargs cat',
    'git ls-files | uniq | tail -n 5 | xargs cat',
    'git ls-files | sort -t/ -k2,2 | xargs cat',
    'git ls-files | sort -u -r | xargs cat',
    'git ls-files | head -5 | xargs cat',
    'git ls-files | head -n5 | xargs cat',
    'git ls-files | tail -n +3 | xargs cat',
    'git ls-files | uniq -c | xargs cat',
    'cd apps && git ls-files | xargs wc -l',
    'git ls-files | xargs cat; git diff --name-only | xargs wc -l',
    'npm test',
    'npm run test -- --run',
    'npm run test -w apps/web',
    'npm run typecheck',
    'npm run typecheck --workspaces',
    'npx vitest run',
    'npx vitest run apps/server/test/session-policy.test.ts',
    'npx tsc --noEmit -p apps/web/tsconfig.json',
    'npx prettier --check apps/web/src README.md',
    // Structure: segments, pipes, redirections, changing directories.
    'git status; git log -1 | head -3 || echo none',
    'ls 2>/dev/null | head',
    'ls 1>/dev/null; ls 2>&1',
    'cd apps/web && ls src',
    // Every separator so far is `&&`: the `cd` has succeeded, so relative paths start from its target.
    'cd apps/web && ls ../server/src',
    'cd apps/web && cd ../server && git log -1',
    'cd apps/web && cat ../../README.md',
    'cd apps/web/src && cat ../../../README.md',
    `cd ${cwd}/apps/web && git status`,
    `cd ${cwd} && cd apps/web && cat package.json`,
    'cd /workspace/apps && ls',
    "cd 'apps/web' && ls",
  ])('allows %s', (command) => {
    expect(read(command)).toEqual(allowed);
  });

  it.each([
    // Writing, running other programs, following files.
    'find . -delete',
    'find . -exec rm {} \\;',
    "find . -exec rm '{}' ';'",
    "find . -execdir rm '{}' ';'",
    "find . -ok rm '{}' ';'",
    "find . -okdir rm '{}' ';'",
    'find . -fprint out.txt',
    'find . -fprint0 out.txt',
    'find . -fprintf out.txt %p',
    'find . -fls out.txt',
    'find . -name x -delete',
    'xargs rm',
    'git ls-files | xargs rm',
    "git ls-files | xargs -I '{}' mv '{}' /tmp",
    'git ls-files | xargs sh -c "x"',
    'git ls-files | xargs xargs ls',
    'git ls-files | xargs -0 xargs ls',
    // What `xargs` runs, and its options: only the ones that shape the batches.
    'git ls-files | xargs',
    'git ls-files | xargs -0',
    'git ls-files | xargs -0 -r',
    'git ls-files | xargs -a list.txt cat',
    'git ls-files | xargs -a cat ls',
    'git ls-files | xargs -0 -a ls ls',
    'git ls-files | xargs --null cat',
    'git ls-files | xargs -n cat',
    'git ls-files | xargs -n x cat',
    'git ls-files | xargs -n',
    'git ls-files | xargs -P cat',
    'git ls-files | xargs -L y cat',
    'git ls-files | xargs -I cat',
    'git ls-files | xargs -I -x cat',
    'git ls-files | xargs -d',
    'git ls-files | xargs -0r cat',
    'git ls-files | xargs -i cat',
    'git ls-files | xargs -p cat',
    'git ls-files | xargs -t cat',
    'git ls-files | xargs -- cat',
    'git ls-files | xargs -n1x cat',
    'git ls-files | xargs -[0] cat',
    // A name that starts with a dash is an option of what it is handed to: `sort --compress-program=./x`
    // and `rg --pre=./x` run a program. Such a command gets names only after `--`, the rest is not run by `xargs`.
    'git ls-files | xargs git log -1',
    'git ls-files | xargs git log -1 -- x',
    'git ls-files | xargs git diff --stat',
    'git ls-files | xargs rg foo',
    'git ls-files | xargs sort',
    'git ls-files | xargs sort -u',
    'git ls-files | xargs diff README.md',
    'git ls-files | xargs -I X git log -1 X',
    'git ls-files | xargs -I X git log -1 X --',
    'git ls-files | xargs -I Y -I X git log -1 X --',
    'git ls-files | xargs -I X rg foo X',
    'git ls-files | xargs -I X rg X -- foo',
    'git ls-files | xargs -I X sort X',
    'git ls-files | xargs -I X -- git log X',
    "git ls-files | xargs -I '{}' git log -1 --format=%h '{}'",
    'git ls-files | xargs find',
    'git ls-files | xargs find -name x',
    'git ls-files | xargs uniq',
    'git ls-files | xargs uniq --',
    'git ls-files | xargs file',
    'git ls-files | xargs file --',
    'git ls-files | xargs npm test',
    'git ls-files | xargs npm test --',
    'git ls-files | xargs npx vitest run',
    'git ls-files | xargs git grep -l foo',
    'git ls-files | xargs git cat-file -p',
    'git ls-files | xargs git status',
    // A placeholder that occurs in the program, an option or what says what git, npm or npx do:
    // `-I` would let the names decide what runs.
    'git ls-files | xargs -I cat cat',
    'find . -name x | xargs -I cat cat',
    'git ls-files | xargs -Icat cat',
    'git ls-files | xargs -I c cat',
    'git ls-files | xargs -I a cat a',
    'git ls-files | xargs -I status git status',
    'git ls-files | xargs -I s git status',
    'git ls-files | xargs -I log git log -1',
    'git ls-files | xargs -I u sort -u README.md',
    'git ls-files | xargs -I n tail -n 5 README.md',
    'git ls-files | xargs -I l wc -l README.md',
    'git ls-files | xargs -I test npm test',
    'git ls-files | xargs -I run npm run typecheck',
    'git ls-files | xargs -I typecheck npm run typecheck',
    'git ls-files | xargs -I vitest npx vitest run',
    'git ls-files | xargs -I run npx vitest run',
    'git ls-files | xargs -I X -I cat cat X',
    'git ls-files | xargs -IX -I status git status',
    "git ls-files | xargs -I '{}' git '{}'",
    "git ls-files | xargs -I '{}' '{}' README.md",
    "git ls-files | xargs -I '{}' grep -n --include='{}' foo .",
    "git ls-files | xargs -I '{}' grep '{}' README.md --{}",
    // `xargs` reads names only from a lister, through whole-line filters, and only once.
    "printf '\\x2fhome\\x2fx\\x2f.ssh\\x2fid_rsa' | xargs cat",
    'echo aUsersa | tr a / | xargs cat',
    'cat list.txt | xargs cat',
    "find . -printf '/etc/passwd' | xargs cat",
    'git log --format=/etc/x | xargs cat',
    "git diff --name-only | grep -o '/.*' | xargs cat",
    // The same with a blank in front of the path, which the rules for paths let through.
    "echo 'x /etc/passwd' | xargs cat",
    "printf 'x /etc/passwd' | xargs cat",
    "find . -printf 'x /etc/passwd' | xargs cat",
    "find . -printf 'x /etc/passwd\\n' | xargs cat",
    "git log --format='x /etc/passwd' | xargs cat",
    "git diff --name-only --format='x /etc/passwd' | xargs cat",
    "git diff --name-only --pretty='x /etc/passwd' | xargs cat",
    "git diff --name-only --src-prefix='x /etc/passwd' | xargs cat",
    "git diff --name-only --dst-prefix='x /etc/passwd' | xargs cat",
    "git diff --name-only --line-prefix='x /etc/passwd' | xargs cat",
    "git ls-files --format='x /etc/passwd' | xargs cat",
    "git ls-files --fo='x /etc/passwd' | xargs cat",
    "git ls-files --format 'x /etc/passwd' | xargs cat",
    "grep -rl --label='x /etc/passwd' foo . | xargs cat",
    "rg -l -r 'x /etc/passwd' foo | xargs cat",
    "rg --files --hyperlink-format 'x /etc/passwd{path}' | xargs cat",
    'xargs grep -n foo',
    'git ls-files; xargs cat',
    'git ls-files | xargs cat | xargs cat',
    'git ls-files | xargs -n 1 xargs cat',
    'git ls-files | xargs cat | head | xargs cat',
    'echo x | git ls-files | xargs cat',
    'git ls-files | cat | xargs cat',
    'git ls-files | tee | xargs cat',
    'cat README.md | xargs grep foo',
    'ls | cat | xargs wc -l',
    'echo README.md | xargs cat',
    "printf '%s\\n' README.md | xargs cat",
    'git show HEAD:list.txt | xargs cat',
    'git cat-file -p HEAD:list.txt | xargs cat',
    'git log --name-only | xargs cat',
    'git log --pretty=format: --name-only | xargs cat',
    'git show --name-only | xargs cat',
    'git status --short | xargs cat',
    'git branch | xargs git log',
    'git grep foo | xargs cat',
    'git grep -n foo | xargs cat',
    'grep foo README.md | xargs cat',
    'grep -rn foo . | xargs cat',
    'grep -c foo README.md | xargs cat',
    'rg foo | xargs cat',
    'rg -n foo | xargs cat',
    'find . -ls | xargs cat',
    "find . -printf '%p\\n' | xargs cat",
    "find . -fprintf out.txt '%p' | xargs cat",
    'find . -fls out.txt | xargs cat',
    'ls -l | xargs cat',
    'ls -a | xargs ls',
    'ls -R | xargs cat',
    'ls -1 | xargs cat',
    'ls -A | xargs cat',
    'ls --all | xargs cat',
    'wc -l README.md | xargs cat',
    'stat README.md | xargs cat',
    'realpath README.md | xargs cat',
    'pwd | xargs cat',
    // The listers with an option that prints more than names: a format, a prefix, a patch, lines.
    'git diff --name-only --format=x | xargs cat',
    'git diff --name-only --pretty=x | xargs cat',
    'git diff --name-only --src-prefix=/etc/ | xargs cat',
    'git diff --name-only --dst-prefix=/etc/ | xargs cat',
    'git diff --name-only --line-prefix=/etc/x | xargs cat',
    'git diff --name-only --line-prefix /etc/x | xargs cat',
    'git diff --name-only --output=out.txt | xargs cat',
    'git diff --name-only -p | xargs cat',
    'git diff --name-only --stat | xargs cat',
    'git diff --name-only -U0 | xargs cat',
    'git diff --name-only --no-index README.md docs/ROADMAP.md | xargs cat',
    'git diff --name-only -S foo | xargs cat',
    'git diff -S --name-only | xargs cat',
    'git diff --src-prefix --name-only | xargs cat',
    'git diff --diff-filter --name-only | xargs cat',
    'git diff --ext-diff --name-only | xargs cat',
    'git diff | xargs cat',
    'git diff --stat | xargs cat',
    'git diff --numstat | xargs cat',
    'git diff --name-only=x | xargs cat',
    'git diff-tree --name-only -r HEAD | xargs cat',
    'git ls-files --format=/etc/x | xargs cat',
    'git ls-files --fo=/etc/x | xargs cat',
    'git ls-files --form=/etc/x | xargs cat',
    'git ls-files --format /etc/x | xargs cat',
    'git grep -l --no-files-with-matches foo | xargs cat',
    'git grep -l --no-name-only foo | xargs cat',
    'git grep --no-files-with-matches -l foo | xargs cat',
    'git grep -e -l foo | xargs cat',
    'git grep -el foo | xargs cat',
    'git grep -A -l 3 foo | xargs cat',
    'git grep -O vi -l foo | xargs cat',
    'git grep -l -O vi foo | xargs cat',
    'git grep -c -l foo | xargs cat',
    'git grep -lp foo | xargs cat',
    'grep -rl --label=/etc/x foo . | xargs cat',
    'grep -rl --label /etc/x foo . | xargs cat',
    'grep -HZ --label=/etc/passwd foo README.md | xargs -0 cat',
    'grep -el file | xargs cat',
    'grep -e -l file | xargs cat',
    'grep --include -l foo file | xargs cat',
    'grep -m 1 -l foo file | xargs cat',
    'grep -A 1 -l foo file | xargs cat',
    'grep -c -l foo README.md | xargs cat',
    'grep -lc foo README.md | xargs cat',
    'grep -lo foo README.md | xargs cat',
    'grep -lb foo README.md | xargs cat',
    'grep -lT foo README.md | xargs cat',
    'grep -l --color=always foo README.md | xargs cat',
    'grep foo README.md | xargs cat',
    'rg --files --hyperlink-format=x | xargs cat',
    'rg --files --hyperlink-format vscode | xargs cat',
    'rg --files --path-separator x | xargs cat',
    'rg --files --color always | xargs cat',
    'rg --files --hidden=x | xargs cat',
    'rg --files --glob | xargs cat',
    'rg --files -g | xargs cat',
    // Listers that read outside the directories the session may read.
    'grep -rl foo /etc | xargs cat',
    'find /etc -name x | xargs cat',
    'find .. -name x | xargs cat',
    'git ls-files /etc | xargs cat',
    'git diff --name-only /etc/passwd | xargs cat',
    'git grep -l foo -- /etc | xargs cat',
    'ls /etc | xargs cat',
    'ls ../x | xargs cat',
    'rg -l foo /etc | xargs cat',
    'rg --files /etc | xargs cat',
    'ls .* | xargs cat',
    'git ls-files .* | xargs cat',
    'find .* | xargs cat',
    'grep -rl foo .* | xargs cat',
    'rg --files --path-separator=x | xargs cat',
    'rg --files --color=always | xargs cat',
    'rg -l --json foo | xargs cat',
    'rg -l --stats foo | xargs cat',
    'rg -l -r /etc/x foo | xargs cat',
    'rg -l --replace /etc/x foo | xargs cat',
    'rg -l --pre cat foo | xargs cat',
    'rg -L foo | xargs cat',
    'rg --files-with-match foo | xargs cat',
    // The filters between a lister and `xargs`: no cutting, no other files, nothing that adds text.
    "git ls-files | grep -o 'src' | xargs cat",
    'git ls-files | grep -ob src | xargs cat',
    'git ls-files | grep --only-matching src | xargs cat',
    'git ls-files | grep --recursive src | xargs cat',
    'git ls-files | grep --with-filename src | xargs cat',
    'git ls-files | grep --count src | xargs cat',
    'git ls-files | grep --null src | xargs cat',
    'git ls-files | grep --files-with-matches src | xargs cat',
    'git ls-files | grep --regexp=a b | xargs cat',
    'git ls-files | grep --regexp | xargs cat',
    "git ls-files | grep --label='x /etc/passwd' src | xargs cat",
    'git ls-files | grep -r src | xargs cat',
    'git ls-files | grep -R src | xargs cat',
    'git ls-files | grep src README.md | xargs cat',
    'git ls-files | grep -H src | xargs cat',
    'git ls-files | grep -n src | xargs cat',
    'git ls-files | grep -c src | xargs cat',
    'git ls-files | grep -Z src | xargs cat',
    'git ls-files | grep --label=/etc/x -H src | xargs cat',
    'git ls-files | grep -f README.md | xargs cat',
    'git ls-files | grep | xargs cat',
    'git ls-files | grep -e a b | xargs cat',
    'git ls-files | grep a b | xargs cat',
    'git ls-files | grep -m 1 a | xargs cat',
    'git ls-files | grep -A 1 a | xargs cat',
    'git ls-files | grep --color=always a | xargs cat',
    'git ls-files | cut -d/ -f2- | xargs cat',
    'git ls-files | cut -c3- | xargs cat',
    'git ls-files | tr a b | xargs cat',
    'git ls-files | sed s/a/b/ | xargs cat',
    'git ls-files | awk 1 | xargs cat',
    'git ls-files | head -c 5 | xargs cat',
    'git ls-files | head -c5 | xargs cat',
    'git ls-files | tail -c 10 | xargs cat',
    'git ls-files | tail -c +10 | xargs cat',
    'git ls-files | tail -f | xargs cat',
    'git ls-files | head README.md | xargs cat',
    'git ls-files | head -n 5 README.md | xargs cat',
    'git ls-files | tail README.md | xargs cat',
    'git ls-files | head -q | xargs cat',
    'git ls-files | head --lines=5 | xargs cat',
    'git ls-files | sort README.md | xargs cat',
    'git ls-files | sort -u README.md | xargs cat',
    'git ls-files | sort -o out | xargs cat',
    'git ls-files | sort -m | xargs cat',
    'git ls-files | sort -T /tmp | xargs cat',
    'git ls-files | sort -T x | xargs cat',
    'git ls-files | sort -k | xargs cat',
    'git ls-files | head -n | xargs cat',
    'git ls-files | grep -e | xargs cat',
    'git ls-files | uniq -o | xargs cat',
    'git ls-files | uniq - | xargs cat',
    'git ls-files | sort -S | xargs cat',
    'git ls-files | sort --output=out | xargs cat',
    'git ls-files | sort -c | xargs cat',
    'git ls-files | uniq - out | xargs cat',
    'git ls-files | uniq README.md | xargs cat',
    'git ls-files | uniq -i README.md out | xargs cat',
    'git ls-files | uniq --count | xargs cat',
    'git ls-files | wc -l | xargs cat',
    'git ls-files | nl | xargs cat',
    'git ls-files | basename | xargs cat',
    'git ls-files | file - | xargs cat',
    'git ls-files | diff - README.md | xargs cat',
    // Patterns that can match `.` and `..` (bash before 5.2) climb out of the directories.
    'grep -r foo .*',
    'cat .*/x',
    'ls .?',
    'cat src/.*',
    'cat .*/.*/x',
    'ls .*',
    'ls -a .*',
    'wc -l .*',
    'du -sh .*',
    'stat .*',
    'file .*',
    'diff .* README.md',
    'find .* -name x',
    'rg foo .*',
    'git grep foo -- .*',
    'git log -- .*',
    'ls ..*',
    'ls .[a-z]*',
    'ls .h*',
    'ls src/.?',
    'cat ./.*',
    'cat src/.*/x',
    'cat */.*',
    'cat .*.ts',
    'cat /workspace/.*',
    `cat ${cwd}/.*`,
    'git ls-files | xargs ls .*',
    "ls '.*'",
    'cd .* && ls',
    'cd apps/.* && ls',
    'sort -o out README.md',
    'sort -ro out README.md',
    'sort -oout README.md',
    'sort -uo out README.md',
    'sort --output=out README.md',
    'sort --output out README.md',
    'sort --out=out README.md',
    'sort --o=out README.md',
    'sort --compress-program=gzip README.md',
    'sort --compress-program gzip README.md',
    'sort --comp=gzip README.md',
    'sort -[o] out',
    'sort -? out',
    'git log --output=/tmp/x',
    'git log --output /tmp/x',
    'git log --output=out.txt',
    'git diff --output=out.txt',
    'git show --output=out.txt',
    'git diff-tree --output=out.txt HEAD',
    'git log --output-indicator-new=+',
    'git log -p --ext-diff',
    'git diff --ext-diff',
    'git show --ext-diff HEAD',
    'git grep -O vi foo',
    'git grep -Ovi foo',
    'git grep --open-files-in-pager=vi foo',
    'git grep --open-files-in-pager foo',
    'git grep --open foo',
    'git grep --op foo',
    'tail -f log',
    'tail -F log',
    'tail --follow log',
    'tail --follow=name log',
    'tail --foll log',
    'tail --f log',
    'tail -fn5 log',
    'tail -nf 5 log',
    'tail -n 5 -f log',
    'tail -[f] log',
    'uniq in out',
    'uniq -c in out',
    'uniq -- in out',
    'uniq - out',
    'rg --pre cat foo',
    'rg --pre=cat foo',
    'rg --pre-glob "*.gz" foo',
    'rg --hostname-bin=sh foo',
    'rg --pr cat foo',
    'file -C -m magic',
    'file --compile -m magic',
    'npx prettier --check --write .',
    'npx prettier --check -w .',
    'npx prettier --write .',
    'npx vitest run -u',
    'npx vitest run --update',
    'npx vitest',
    'npx vitest watch',
    'npx tsc',
    'npx tsc -p apps/web',
    'npx prettier --write src',
    'npx prettier',
    'npx --no-install vitest run',
    'npx -y vitest run',
    'npx cowsay hi',
    'npm install',
    'npm ci',
    'npm install left-pad',
    'npm run build',
    'npm run',
    'npm run dev',
    'npm publish',
    'npm exec vitest run',
    'npm -w apps/web run test',
    'npm --prefix apps/web test',
    'npm',
    // `git branch` that would create, delete or rename.
    'git branch foo',
    'git branch -v foo',
    'git branch -vv foo',
    'git branch --show-current extra',
    'git branch -d foo',
    'git branch -D foo',
    'git branch -m a b',
    'git branch -c a b',
    'git branch --set-upstream-to=origin/main',
    'git branch -u origin/main',
    'git branch --unset-upstream',
    'git branch -f foo HEAD',
    'git branch --merged',
    'git branch --sort=-committerdate',
    'git branch -av',
    'git branch --format=%(refname)',
    // Other `git` commands and global options.
    'git commit -m x',
    'git add -A',
    'git fetch',
    'git pull',
    'git checkout main',
    'git switch main',
    'git reset --hard',
    'git clean -fd',
    'git stash',
    'git rebase main',
    'git merge --ff-only main',
    'git config user.name x',
    'git config --get user.name',
    'git remote -v',
    'git tag',
    'git worktree list',
    'git cat-file blob HEAD:README.md',
    'git cat-file --batch',
    'git cat-file --batch-check',
    'git cat-file -p --textconv HEAD:x',
    'git cat-file --filters HEAD:x',
    'git cat-file',
    'git -C /other status',
    'git -c core.pager=x log',
    'git --git-dir=/other/.git log',
    'git --work-tree=/other status',
    'git --no-pager log',
    'git -P log',
    'git --exec-path',
    'git -- status',
    'git',
    'git help',
    'git st',
    'git ls-tree HEAD',
    // Paths outside the roots.
    'cat ~/.ssh/id_rsa',
    'cat /home/x/.codex/auth.json',
    'cat /etc/passwd',
    'grep -rn foo /etc',
    'grep -rn foo /',
    'grep -rn /etc/passwd README.md',
    'cat ../README.md',
    'cat ../../etc/passwd',
    'cat apps/../../etc/passwd',
    'cat */../../etc/passwd',
    'cat ./../x',
    'ls ..',
    'ls /',
    'ls /workspace/..',
    'ls /workspace2',
    'ls /worktrees',
    'ls /worktrees/AR/AR-2-local',
    'ls /worktrees/AR/AR-1-local-other',
    'ls /worktrees/AR/AR-1-local/../AR-2-local',
    'find / -name id_rsa',
    'find /etc -name passwd',
    'find . -newer /etc/passwd',
    'rg foo /home/x',
    'head -5 /etc/hosts',
    'wc -l /etc/hosts',
    'diff README.md /etc/hosts',
    'stat /etc/hosts',
    'du -sh /',
    'realpath /etc',
    'basename /etc/passwd',
    'echo /etc/passwd',
    'git diff --no-index /etc/passwd README.md',
    'git diff --no-index ../other README.md',
    'git grep --no-index foo /etc',
    'git log -- /etc/passwd',
    'git show HEAD:../../etc/passwd',
    'git blame --contents=/etc/passwd README.md',
    'git blame --contents /etc/passwd README.md',
    'git ls-files --exclude-from=/etc/passwd',
    'grep --file=/etc/passwd README.md',
    'grep --file /etc/passwd README.md',
    'grep -f /etc/passwd README.md',
    'grep -f/etc/passwd README.md',
    'grep --exclude-from=/etc/passwd -r foo .',
    'npx vitest run --root=/etc',
    'npx vitest run --root /etc',
    'npx vitest run --root=../other',
    'npx vitest run --outputFile=/tmp/out.json',
    'npx vitest run --reporter=json --outputFile=/tmp/out.json',
    'npx vitest run --root=~/x',
    'npm test --prefix=/etc',
    'npm run test --workspace=../other',
    'npx tsc --noEmit -p /etc/tsconfig.json',
    'npx prettier --check /etc',
    'cut -d/ -f1 /etc/passwd',
    'sort -T/tmp README.md',
    'sort -T /tmp README.md',
    'cat -- /etc/passwd',
    'cat --/etc/passwd',
    'cat -/etc/passwd',
    'ls --color=/etc',
    'ls -I/etc',
    // Changing directory somewhere else or somewhere unclear.
    'cd /etc && ls',
    'cd .. && ls',
    'cd ../.. && ls',
    'cd /workspace/.. && ls',
    'cd /worktrees/AR/AR-2-local && ls',
    'cd /worktrees/AR && ls',
    'cd ~ && ls',
    'cd && ls',
    'cd - && ls',
    'cd -P apps && ls',
    'cd -- apps && ls',
    'cd apps/* && ls',
    'cd apps/? && ls',
    'cd apps/[a-z] && ls',
    'cd apps web && ls',
    'cd "" && ls',
    "cd '' && ls",
    'cd apps 2>&1 && ls',
    'cd apps >/dev/null && ls',
    'cd apps | cat',
    'cd apps/../.. && ls',
    'cd apps && cd .. && cd .. && ls',
    // After `;` or `||` a segment may run because the `cd` failed, so paths must hold from every directory.
    'cd apps/web; cat ../../README.md',
    'cd apps/web || cat ../../README.md',
    'cd apps/web && cat x ; cat ../../README.md',
    'ls; cd apps/web && cat ../../README.md',
    'cd apps/web; cd ../server && git log -1',
    'cd apps/web/src && cd ../../../.. && ls',
    'cd apps/web && cat ../../../README.md',
    // Redirections and operators the parser does not know.
    'echo x > f',
    'echo x >> f',
    'echo x >f',
    'ls > /dev/null',
    'ls 2> err.txt',
    'ls >out.txt 2>&1',
    'cat < README.md',
    'cat <<< x',
    'ls &',
    'ls & ls',
    'ls |& cat',
    'ls &> out',
    'ls >&2',
    'ls 2>&1 >out',
    // Commands that are not readers, or are run through something else.
    'rm -rf dist',
    'rm README.md',
    'mv a b',
    'cp a b',
    'mkdir x',
    'touch x',
    'tee out',
    'sed s/a/b/ README.md',
    'awk 1 README.md',
    'curl https://example.com',
    'wget https://example.com',
    'sh -c ls',
    'bash -c "ls"',
    'env ls',
    'FOO=1 ls',
    'sudo ls',
    'command ls',
    'exec ls',
    'eval ls',
    'nohup ls',
    'time ls',
    'watch ls',
    'less README.md',
    'vim README.md',
    'open README.md',
    'python3 -c "print(1)"',
    'node -e "1"',
    'make',
    'chmod +x a',
    'ln -s /etc x',
    'kill 1',
    'yes',
    'cat; rm -rf x',
    'ls && rm -rf x',
    'ls || rm -rf x',
    'ls | rm',
    'rm | ls',
    'ls | sh',
    'git status && npm install left-pad',
    '/bin/cat README.md',
    './cat README.md',
    'ls; ./run.sh',
    // Shell syntax the parser refuses.
    'ls $(pwd)',
    'ls `pwd`',
    'ls $HOME',
    'ls ${HOME}',
    'echo "$HOME"',
    'ls {a,b}',
    '(ls)',
    '{ ls; }',
    'ls\nrm -rf x',
    'echo hi\n',
    'ls \\',
    'echo a\\ b',
    'ls #x',
    'ls; # rm',
    'ls =ls',
    'ls ~',
    'ls !',
    'ls <(ls)',
    'for f in a; do ls; done',
    'if true; then ls; fi',
    'ls;',
    ';ls',
    'ls &&',
    '&& ls',
    'ls ||',
    'ls |',
    '| ls',
    'ls ;; ls',
    '',
    ' ',
    // Options whose name is a pattern may expand to a forbidden option.
    'tail -[f] log',
    'git log --out* ',
    'git log -[p]',
    'ls -?',
    'grep -r -[e] foo',
  ])('leaves %j for a human', (command) => {
    expect(read(command)).toBeNull();
  });

  it('gives no verdict without readable roots, outside them or without a task', () => {
    const command = 'git status';
    expect(commandVerdict({ ...reviewer, readableRoots: undefined, toolInput: { command } })).toBeNull();
    expect(commandVerdict({ ...reviewer, readableRoots: [], toolInput: { command } })).toBeNull();
    expect(commandVerdict({ ...reviewer, readableRoots: ['/elsewhere'], toolInput: { command } })).toBeNull();
    expect(
      commandVerdict({ ...reviewer, readableRoots: ['relative/root'], toolInput: { command } }),
    ).toBeNull();
    expect(commandVerdict({ ...reviewer, task: null, toolInput: { command } })).toBeNull();
    expect(commandVerdict({ ...reviewer, toolName: 'Read', toolInput: { command } })).toBeNull();
    expect(
      commandVerdict({
        ...reviewer,
        session: { cwd: 'relative', role: 'code_review' },
        toolInput: { command },
      }),
    ).toBeNull();
    // Relative paths are a mistake of the caller, whatever directory the server happens to run in.
    const here = process.cwd();
    expect(
      commandVerdict({
        ...reviewer,
        readableRoots: ['.'],
        session: { cwd: here, role: 'code_review' },
        toolInput: { command },
      }),
    ).toBeNull();
    expect(
      commandVerdict({
        ...reviewer,
        readableRoots: [here],
        session: { cwd: 'relative', role: 'code_review' },
        toolInput: { command },
      }),
    ).toBeNull();
    expect(commandVerdict({ ...reviewer, toolInput: { command } })).toEqual(allowed);
  });

  it('applies to every AI role, in the workspace or in the worktree', () => {
    for (const role of ['code_review', 'architect', 'devops', 'developer', 'data_steward', 'qa']) {
      expect(read('git status', { session: { cwd: reviewerCwd, role } }), role).toEqual(allowed);
      expect(read('git diff | head', { session: { cwd, role } }), role).toEqual(allowed);
    }
  });

  it('allows a reader to work in the worktree of its own session too', () => {
    expect(
      commandVerdict({ ...input, readableRoots: [cwd], toolInput: { command: 'git log -1 && ls apps' } }),
    ).toEqual(allowed);
    // A chain that mixes reading and committing is the developer's routine rule: it needs no roots.
    expect(verdict('git status && git commit -m x')).toEqual(allowed);
    expect(
      commandVerdict({
        ...input,
        readableRoots: [cwd],
        toolInput: { command: 'git status && git commit -m x' },
      }),
    ).toEqual(allowed);
  });

  it('checks the segments after a `cd` from the directory it leads to, or from every directory it could', () => {
    // From the workspace, `cd` to the developer worktree, then relative paths start there.
    expect(read(`cd ${cwd} && cat apps/web/package.json && git diff --stat`)).toEqual(allowed);
    expect(read(`cd ${cwd}/apps && cat ../x`)).toEqual(allowed);
    // A path must stay inside a root from there.
    expect(read(`cd ${cwd} && cat ../AR-2-local/x`)).toBeNull();
    expect(read(`cd ${cwd} && cat ../../../x`)).toBeNull();
    // After `;` the `cd` may have failed, so the path must also hold from where the command started,
    // and from the directory it leads to.
    expect(read(`cd ${cwd}/apps ; cat ../x`)).toBeNull();
    expect(read(`cd ${cwd}/apps ; cat x`)).toEqual(allowed);
    expect(read(`cd ${cwd} || cat ../x`)).toBeNull();
    expect(read(`cd ${cwd} ; cat ../../worktrees/AR/AR-1-local/x`)).toBeNull();
    expect(read(`cd ${cwd} ; cat ../../workspace/x`)).toBeNull();
    // Many directories the command could be in cannot be followed.
    const many = (separator: string) => Array.from({ length: 40 }, (_, i) => `cd d${i}`).join(separator);
    expect(read(`${many(' ; ')} ; ls`)).toBeNull();
    expect(read(`${many(' && ')} && ls`)).toBeNull();
    expect(read('cd a ; cd b ; cd c ; ls')).toEqual(allowed);
    expect(read('cd a && cd b && cd c && ls')).toEqual(allowed);
  });

  it.each([
    'cat',
    'head',
    'tail',
    'wc',
    'grep foo',
    'ls',
    'stat',
    'du',
    'nl',
    'basename',
    'dirname',
    'realpath',
    'echo',
    'printf',
    'cut -d: -f1',
    'tr a b',
    'true',
    'pwd',
  ])('runs %s under xargs, whatever the names look like', (command) => {
    expect(read(`git ls-files | xargs ${command}`)).toEqual(allowed);
    expect(read(`git ls-files | xargs -0 -r -n 3 ${command}`)).toEqual(allowed);
  });

  it.each(['git log -1', 'git diff --stat', 'rg foo', 'sort -u', 'diff -u README.md'])(
    'runs %s under xargs only with the names after --',
    (command) => {
      expect(read(`git ls-files | xargs ${command}`)).toBeNull();
      expect(read(`git ls-files | xargs ${command} --`)).toEqual(allowed);
      expect(read(`git ls-files | xargs ${command} -- x`)).toBeNull();
      expect(read(`git ls-files | xargs -I X ${command} -- X`)).toEqual(allowed);
      expect(read(`git ls-files | xargs -I X ${command} X`)).toBeNull();
    },
  );

  it.each(['find . -name x', 'uniq', 'file', 'npm test', 'npm run typecheck', 'npx vitest run', 'xargs cat'])(
    'never runs %s under xargs',
    (command) => {
      expect(read(`git ls-files | xargs ${command}`)).toBeNull();
      expect(read(`git ls-files | xargs ${command} --`)).toBeNull();
      expect(read(`git ls-files | xargs -I X ${command} -- X`)).toBeNull();
    },
  );
});

describe('readable roots of a session', () => {
  const task = { key: 'AR-1', repo: 'local' };

  it('are its own directory and the worktree of the task', () => {
    expect(
      readableRootsFor({ config, cwd: '/workspace', projectKey: 'AR', task, worktreesRootDir: '/worktrees' }),
    ).toEqual(['/workspace', '/worktrees/AR/AR-1-local']);
    expect(
      readableRootsFor({ config, cwd, projectKey: 'AR', task, worktreesRootDir: '/worktrees/' }),
    ).toEqual([cwd, '/worktrees/AR/AR-1-local']);
  });

  it('are only the directory without a task, a repository or a worktrees root', () => {
    // `config` has two repositories, so a task that names none has no repository.
    for (const each of [
      { task: null, worktreesRootDir: '/worktrees' },
      { task: { key: 'AR-1', repo: null }, worktreesRootDir: '/worktrees' },
      { task, worktreesRootDir: undefined },
    ])
      expect(readableRootsFor({ config, cwd: '/workspace', projectKey: 'AR', ...each })).toEqual([
        '/workspace',
      ]);
  });

  it('never include a location outside the project folder of the worktrees root', () => {
    for (const repo of ['x/../../..', '../../..', '..', '.', '../x/..', 'x/..', 'x/../..']) {
      const roots = readableRootsFor({
        config,
        cwd: '/workspace',
        projectKey: 'AR',
        task: { key: 'AR-1', repo },
        worktreesRootDir: '/worktrees',
      });
      for (const root of roots.slice(1))
        expect(root.startsWith('/worktrees/AR/'), `${repo}: ${root}`).toBe(true);
    }
  });
});

// A task without a repository of its own works in the project's only repository (PM-68): the rules that
// decide by the task's repository read the effective one.
describe('the repository of a task that names none (PM-68)', () => {
  const allowed = { behavior: 'allow' };
  const publishing = {
    behavior: 'deny',
    message: 'The owner has not allowed publishing from this repository.',
  };
  /** A project with one repository, `only`, on GitHub unless `local`. */
  const oneRepo = (local: boolean, defaultBranch = 'main') => {
    const project = testTemplate.build({
      key: 'AR',
      name: 'Fictional project',
      workspacePath: '/workspace',
      language: 'en',
      owner: { handle: 'owner', displayName: 'Example Owner', email: 'owner@example.com' },
    });
    project.project.repos = [
      { name: 'only', path: 'only', defaultBranch, ...(local ? {} : { github: 'acme/only' }) },
    ];
    return project;
  };
  const withoutRepos = (local: boolean) => {
    const project = oneRepo(local);
    project.project.repos = [];
    return project;
  };
  const withTwoRepos = (local: boolean) => {
    const project = oneRepo(local);
    project.project.repos.push({ name: 'other', path: 'other', defaultBranch: 'main' });
    return project;
  };
  const task = { key: 'AR-1', repo: null };
  const worktree = '/worktrees/AR/AR-1-only';
  const run = (project: typeof config, command: string, overrides: Partial<typeof input> = {}) =>
    commandVerdict({
      ...input,
      config: project,
      session: { cwd: worktree, role: 'developer' },
      task,
      toolInput: { command },
      ...overrides,
    });

  it('denies publishing from a local-only only repository, and only from that', () => {
    expect(deniedToolsFor(oneRepo(true), task)).toEqual(LOCAL_ONLY_DENIED_TOOLS);
    expect(deniedToolsFor(oneRepo(false), task)).toEqual([]);
    expect(run(oneRepo(true), 'git push')).toEqual(publishing);
    expect(run(oneRepo(true), 'gh pr create --title "Example"')).toEqual(publishing);
    expect(run(oneRepo(false), 'git push')).toBeNull();
  });

  it('has nothing to deny when the project has no repository or several', () => {
    for (const project of [withoutRepos(true), withTwoRepos(true)]) {
      expect(deniedToolsFor(project, task)).toEqual([]);
      expect(run(project, 'git push')).toBeNull();
    }
    // The task's own repository still decides, whatever the project has.
    expect(deniedToolsFor(withTwoRepos(true), { repo: 'only' })).toEqual(LOCAL_ONLY_DENIED_TOOLS);
  });

  it('allows the developer routine steps in the worktree of the only repository, merging its default branch', () => {
    const project = oneRepo(true, 'develop');
    expect(run(project, 'git add -A && git commit -m "Example"')).toEqual(allowed);
    expect(run(project, 'git merge --ff-only origin/develop')).toEqual(allowed);
    expect(run(project, 'git merge --ff-only main')).toBeNull();
    // Not in the worktree, and not where the project has no repository to have a worktree of.
    expect(
      run(project, 'git commit -m "Example"', { session: { cwd: '/workspace', role: 'developer' } }),
    ).toBeNull();
    expect(run(withoutRepos(true), 'git commit -m "Example"')).toBeNull();
    expect(run(withTwoRepos(true), 'git commit -m "Example"')).toBeNull();
  });

  it('reads the worktree of the only repository, not of a repository the project does not have', () => {
    const roots = (project: typeof config, overrides: Partial<Parameters<typeof readableRootsFor>[0]> = {}) =>
      readableRootsFor({
        config: project,
        cwd: '/workspace',
        projectKey: 'AR',
        task,
        worktreesRootDir: '/worktrees',
        ...overrides,
      });
    expect(roots(oneRepo(false))).toEqual(['/workspace', worktree]);
    expect(roots(withoutRepos(false))).toEqual(['/workspace']);
    expect(roots(withTwoRepos(false))).toEqual(['/workspace']);
    expect(roots(withTwoRepos(false), { task: { key: 'AR-1', repo: 'other' } })).toEqual([
      '/workspace',
      '/worktrees/AR/AR-1-other',
    ]);
  });
});

describe('a command that rewrites a file in place is refused at once (PM-104)', () => {
  const guidance = {
    behavior: 'deny',
    message:
      'Edit files with your Edit or Write tool; in-place edits through the shell are refused without asking anyone.',
  };
  const roots = [cwd];
  const run = (command: string, overrides: Partial<Parameters<typeof commandVerdict>[0]> = {}) =>
    commandVerdict({ ...input, readableRoots: roots, ...overrides, toolInput: { command } });

  it.each([
    'sed -i s/a/b/ README.md',
    "sed -i 's/a/b/' README.md",
    "sed -i '' 's/a/b/' README.md",
    "sed -i.bak 's/a/b/' README.md",
    'sed --in-place s/a/b/ README.md',
    'sed --in-place=.bak s/a/b/ README.md',
    'sed -ni s/a/b/p README.md',
    'sed -Ei s/a/b/ README.md',
    'sed -e s/a/b/ -i README.md',
    'sed s/a/b/ -i README.md',
    'sed -i -e s/a/b/ -e s/c/d/ README.md',
    'sed -I s/a/b/ README.md',
    'perl -i s/a/b/ README.md',
    'perl -i.bak -pe s/a/b/ README.md',
    'perl -pi -e s/a/b/ README.md',
    "perl -pi -e 's/a/b/' README.md",
    "perl -p -i -e 's/a/b/' README.md",
    "perl -0777 -pi -e 's/a/b/g' README.md",
    "perl -lpi -e 's/a/b/' README.md",
    'perl -pie s/a/b/ README.md',
    "perl -e 'print 1' -i README.md",
    '/usr/bin/sed -i s/a/b/ README.md',
  ])('refuses %s with guidance, without a question', (command) => {
    expect(run(command)).toEqual(guidance);
  });

  it.each([
    `cd ${cwd} && sed -i s/a/b/ README.md`,
    `cd ${cwd}/apps && sed -i s/a/b/ README.md && git status`,
    "git status && perl -pi -e 's/a/b/' README.md",
    'git status; sed -i s/a/b/ README.md',
    'ls || sed -i s/a/b/ README.md',
    'git ls-files | xargs sed -i s/a/b/',
    'git ls-files | xargs -n 1 sed -i s/a/b/',
    "find . -name '*.md' -exec sed -i s/a/b/ ';'",
    'env FOO=1 sed -i s/a/b/ README.md',
    'FOO=1 sed -i s/a/b/ README.md',
    'sudo -u nobody sed -i s/a/b/ README.md',
    'nohup sed -i s/a/b/ README.md',
    'bash -c "sed -i s/a/b/ README.md"',
    "sh -c 'cd apps && perl -pi -e s/a/b/ README.md'",
    'sed -i s/a/b/ README.md 2>&1',
    'sed -i s/a/b/ README.md >/dev/null',
  ])('refuses it inside a chain, a pipeline or a wrapper: %s', (command) => {
    expect(run(command)).toEqual(guidance);
  });

  it('refuses it for every kind of session, on a task or not', () => {
    const command = 'sed -i s/a/b/ README.md';
    expect(run(command, { session: { cwd: '/workspace', role: 'code_review' } })).toEqual(guidance);
    expect(run(command, { task: null })).toEqual(guidance);
    expect(run(command, { readableRoots: undefined })).toEqual(guidance);
    expect(run(command, { worktreesRootDir: undefined })).toEqual(guidance);
  });

  it.each([
    // sed that only reads, or does not edit in place: no verdict, as before.
    'sed -n 1,5p README.md',
    "sed -n '1,5p' README.md",
    'sed s/a/b/ README.md',
    "sed -e 's/i/x/' README.md",
    'sed -e -i README.md',
    'sed -f script.sed README.md',
    'sed -- s/a/b/ -i',
    'sed -s -n p README.md',
    "sed -l 5 's/a/b/' README.md",
    'sed --version',
    // Mentions of the program or the flag that are not the program.
    'grep sed -i README.md',
    'grep -i sed README.md',
    'echo sed -i s/a/b/ README.md',
    'cat sed-i.txt',
    'ls -i',
    'git diff -i',
    // perl that does not edit in place.
    "perl -pe 's/a/b/' README.md",
    "perl -ne 'print if /i/' README.md",
    'perl script.pl -i README.md',
    'perl -MList::Util=sum -e print README.md',
    "perl -e 'print 1'",
    // Quoted text and unparseable commands keep their old treatment.
    'echo "sed -i"',
    'sed -i s/a/b/ $(ls)',
    'sed -i s/a/b/ README.md &',
  ])('does not refuse %j as an in-place edit', (command) => {
    expect(run(command)?.behavior).not.toBe('deny');
  });

  it('keeps the readers running without a question', () => {
    for (const command of ['git status', 'cat README.md', 'grep -rn foo .', 'git log -1 | head -1'])
      expect(run(command)).toEqual({ behavior: 'allow' });
  });

  it('still lets the developer routine run next to refused commands', () => {
    expect(run('git add -A && git commit -m "Edit sed -i docs"')).toEqual({ behavior: 'allow' });
  });
});
