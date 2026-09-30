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

  it('runs the roles that change files in the task worktree, with edits accepted', () => {
    const worktreeRoles = BUILT_IN_ROLE_IDS.filter((role) => usesWorktree(role, team));
    expect(worktreeRoles.sort()).toEqual(
      ['content', 'designer', 'developer', 'docs', 'maintainer', 'translator'].sort(),
    );
    for (const role of AI_BUILT_IN_ROLE_IDS) {
      expect(aiRoleDefaults(role).permissionMode === 'acceptEdits', role).toBe(worktreeRoles.includes(role));
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
    'npm ci; echo done',
    'npm ci | cat',
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
    // Options before the subcommand.
    'git -C /other commit -m x',
    'git -C . commit -m x',
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
    // Anywhere but the first segment, or joined with anything but &&.
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
    'git add . ; git commit -m x',
    'git add . || git commit -m x',
    'git add . | cat',
    'git commit -m x | cat',
    'git commit -m x 2>&1',
    'git commit -m x >/dev/null',
    'git commit -m x && git status',
    'git status && git commit -m x',
    'cd . && git status',
    'cd .',
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
    'git commit -m "one\ntwo"',
    'git commit -m "$HOME"',
    'git commit -m "a\\nb"',
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

  it('also holds for a review role when it is given the git steps in the read-only rule', () => {
    const roots = ['/workspace', cwd];
    const reviewer = { ...input, session: { cwd: '/workspace', role: 'code_review' }, readableRoots: roots };
    for (const command of [
      'git commit -m x',
      'git add -A',
      'git merge --ff-only main',
      'npm ci',
      `cd ${cwd} && git commit -m x`,
    ])
      expect(commandVerdict({ ...reviewer, toolInput: { command } }), command).toBeNull();
  });
});

describe('read-only commands for any AI session on a task (PM-69)', () => {
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
    'xargs grep -n foo',
    'git ls-files -z | xargs -0 -r wc -l',
    'git ls-files | xargs -n 5 -P 4 cat',
    'git ls-files | xargs -n1 -L1 head -1',
    "git ls-files | xargs -I '{}' git log -1 --format=%h '{}'",
    "git ls-files | xargs -I'{}' git log -1 --format=%h '{}'",
    "git ls-files | xargs -d '\\n' wc -l",
    'xargs -0 -r -n 2 -L 3 -P 4 -I X -d , ls',
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
    'xargs sh -c "x"',
    'xargs xargs ls',
    'xargs -0 xargs ls',
    'xargs',
    'xargs -0',
    'xargs -a list.txt cat',
    'xargs --null cat',
    'xargs -n cat',
    'xargs -n x cat',
    'xargs -P cat',
    'xargs -I cat',
    'xargs -I -x cat',
    'xargs -d',
    'xargs -0r cat',
    'xargs -i cat',
    'xargs -p cat',
    'xargs -t cat',
    'xargs -- cat',
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
    'git -C . status',
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
    'sed -i s/a/b/ README.md',
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
    // Reading is not the routine git rule: a mixed chain of reading and committing still asks.
    expect(
      commandVerdict({
        ...input,
        readableRoots: [cwd],
        toolInput: { command: 'git status && git commit -m x' },
      }),
    ).toBeNull();
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
});

describe('readable roots of a session', () => {
  const task = { key: 'AR-1', repo: 'local' };

  it('are its own directory and the worktree of the task', () => {
    expect(
      readableRootsFor({ cwd: '/workspace', projectKey: 'AR', task, worktreesRootDir: '/worktrees' }),
    ).toEqual(['/workspace', '/worktrees/AR/AR-1-local']);
    expect(readableRootsFor({ cwd, projectKey: 'AR', task, worktreesRootDir: '/worktrees/' })).toEqual([
      cwd,
      '/worktrees/AR/AR-1-local',
    ]);
  });

  it('are only the directory without a task, a repository or a worktrees root', () => {
    for (const each of [
      { task: null, worktreesRootDir: '/worktrees' },
      { task: { key: 'AR-1', repo: null }, worktreesRootDir: '/worktrees' },
      { task, worktreesRootDir: undefined },
    ])
      expect(readableRootsFor({ cwd: '/workspace', projectKey: 'AR', ...each })).toEqual(['/workspace']);
  });

  it('never include a location outside the project folder of the worktrees root', () => {
    for (const repo of ['x/../../..', '../../..', '..', '.', '../x/..', 'x/..', 'x/../..']) {
      const roots = readableRootsFor({
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
