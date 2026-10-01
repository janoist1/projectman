import { describe, expect, it } from 'vitest';
import { testTemplate } from './helpers/test-template';
import {
  allowedToolsFor,
  commandVerdict,
  describeUnattendedCommands,
  preApprovedPrefixes,
  PROJECT_CHECK_COMMANDS,
  readableRootsFor,
} from '../src/domain';
import { READ_ONLY_GIT, READ_ONLY_PROGRAMS } from '../src/domain/read-only-commands';

/**
 * The "Commands that run without asking" section of the system prompt is generated from the
 * server's command rules. These tests hold the two together: what the section lists and
 * recommends is allowed by `commandVerdict`, what it says never to write is not.
 */

const config = testTemplate.build({
  key: 'AR',
  name: 'Fictional project',
  workspacePath: '/workspace',
  language: 'en',
  owner: { handle: 'owner', displayName: 'Example Owner', email: 'owner@example.com' },
});
config.project.repos.push({ name: 'local', path: 'local', defaultBranch: 'main' });
const task = { key: 'AR-1', repo: 'local' };
const worktree = '/worktrees/AR/AR-1-local';

/** The verdict for a command in a developer's worktree or a reviewer's workspace. */
function verdictFor(role: 'developer' | 'code_review', command: string) {
  const cwd = role === 'developer' ? worktree : '/workspace';
  return commandVerdict({
    config,
    session: { cwd, role },
    task,
    toolName: 'Bash',
    toolInput: { command },
    worktreesRootDir: '/worktrees',
    readableRoots: readableRootsFor({
      config,
      cwd,
      projectKey: 'AR',
      task,
      worktreesRootDir: '/worktrees',
    }),
  });
}
const allowed = (role: 'developer' | 'code_review', command: string) =>
  verdictFor(role, command)?.behavior === 'allow';

const section = (input: Partial<Parameters<typeof describeUnattendedCommands>[0]> = {}) =>
  describeUnattendedCommands({
    worktree: true,
    hasRepo: true,
    defaultBranch: 'main',
    localOnly: false,
    ...input,
  });

describe('commands that run without asking: the rules the section lists', () => {
  it.each(READ_ONLY_PROGRAMS)('allows the listed reader %s', (program) => {
    expect(allowed('developer', `${program} notes.txt`)).toBe(true);
    expect(allowed('code_review', `${program} notes.txt`)).toBe(true);
  });

  it.each([...READ_ONLY_GIT].filter((name) => name !== 'cat-file'))('allows git %s', (subcommand) => {
    expect(allowed('developer', `git ${subcommand}`)).toBe(true);
  });

  it.each(PROJECT_CHECK_COMMANDS)('allows the project check %s', (check) => {
    expect(allowed('developer', check)).toBe(true);
    expect(allowed('code_review', check)).toBe(true);
  });

  it.each([
    'npm ci',
    'npm install --prefer-offline --no-audit --no-fund',
    'git add -A',
    'git add -u',
    'git add src/a.ts docs',
    'git commit -m "Add the feature"',
    'git commit -q -m "Add the feature"',
    'git commit -m "Subject" -m "A second paragraph"',
    'git commit -m "Subject\n\nBody line one\nBody line two"',
    "git commit -m 'Subject with a `backtick`'",
    'git merge --ff-only main',
    'git merge --ff-only -q main',
    'git status && git add -A && git commit -m "Done" && git log -1',
    `git -C ${worktree} status`,
    `cd ${worktree} && git add -A && git commit -m "Done"`,
  ])('allows the developer routine: %s', (command) => {
    expect(allowed('developer', command)).toBe(true);
  });

  it.each([
    "grep -n 'task\\.(edit|save)' apps/web/src",
    'grep -rn "task\\.(edit|save)" apps/web/src',
    "git log --oneline -5 | grep -n 'Add'",
    'git ls-files | xargs grep -n foo',
    'npm run typecheck 2>&1 | head -20',
    'npm test 2>/dev/null; git status',
    'find . -name "*.ts" | wc -l',
  ])('allows the forms the section recommends: %s', (command) => {
    expect(allowed('developer', command)).toBe(true);
  });

  it.each([
    'python3 -c "print(1)"',
    'python edit.py',
    'node script.js',
    "sed -i 's/a/b/' file",
    'perl -pi -e s/a/b/ file',
    'bash -c "ls"',
    'echo $HOME',
    'echo "$B"',
    'cat $(ls)',
    'echo `ls`',
    'ls {a,b}',
    'cat ~/notes',
    'cat > file.txt',
    'echo x >> file.txt',
    'cat < file.txt',
    "cat <<'EOF'\ntext\nEOF",
    'git status\ngit diff',
    'sleep 5 &',
    'echo !',
    'git commit --amend -m "x"',
    'git commit -m "x" --no-verify',
    'git commit',
    'git commit -F message.txt',
    'git add /etc/passwd',
    'git -C /elsewhere status',
    'git -c core.pager=x log',
    'git merge --ff-only feature',
    'git push',
    'npm install left-pad',
    'cat ../outside',
  ])('does not allow what the section forbids: %s', (command) => {
    expect(verdictFor('developer', command)?.behavior).not.toBe('allow');
  });

  it('keeps the routine steps to the roles that work in a worktree', () => {
    expect(allowed('code_review', 'git add -A && git commit -m "x"')).toBe(false);
    expect(allowed('code_review', 'git merge --ff-only main')).toBe(false);
  });
});

describe('commands that run without asking: the section', () => {
  it('lists the readers, the checks and the form rules', () => {
    const text = section().join('\n');
    for (const program of READ_ONLY_PROGRAMS) expect(text).toContain(`\`${program}\``);
    // `branch` is named apart: it reads only when it lists.
    for (const subcommand of READ_ONLY_GIT)
      expect(text).toContain(`\`${subcommand}\``.replace('`branch`', '`git branch`'));
    for (const check of PROJECT_CHECK_COMMANDS) expect(text).toContain(`\`${check}\``);
    expect(text).toContain('`2>&1`');
    expect(text).toContain('`python`');
    expect(text).toContain('`$VAR`');
    expect(text).toContain("your working directory (the task's worktree)");
  });

  it('tells that an in-place edit is refused at once, as the server does', () => {
    const text = section().join('\n');
    expect(text).toContain('Refused without asking anyone');
    for (const example of ['sed -i', 'sed --in-place', 'perl -i', 'perl -pi -e ...'])
      expect(text).toContain(`\`${example}\``);
    for (const command of ['sed -i s/a/b/ file', 'sed --in-place s/a/b/ file', 'perl -pi -e s/a/b/ file']) {
      expect(verdictFor('developer', command)?.behavior).toBe('deny');
      expect(verdictFor('code_review', command)?.behavior).toBe('deny');
    }
    expect(section({ worktree: false }).join('\n')).toContain('Refused without asking anyone');
  });

  it('names the routine steps and the default branch for a role in a worktree only', () => {
    expect(section().join('\n')).toContain('`git merge --ff-only main`');
    expect(section().join('\n')).toContain('`git commit -m "message"`');
    const reviewer = section({ worktree: false }).join('\n');
    expect(reviewer).not.toContain('git commit');
    expect(reviewer).toContain("your working directory and the task's own worktree");
    const noRepo = section({ worktree: true, hasRepo: false }).join('\n');
    expect(noRepo).not.toContain('git commit');
    expect(noRepo).toContain('in your working directory.');
  });

  it('says publishing is refused for a local-only repository only', () => {
    expect(section({ localOnly: true }).join('\n')).toContain('Refused outright: `git push`');
    expect(section().join('\n')).not.toContain('Refused outright');
  });

  it("adds the provider's own pre-approvals beyond the checks", () => {
    const claude = preApprovedPrefixes(allowedToolsFor('developer', config));
    expect(claude).toContain('npm run build');
    const text = section({ preApproved: claude }).join('\n');
    expect(text).toContain('Claude Code also pre-approves');
    expect(text).toContain('`npm run build`');
    // The git steps are already listed, and the checks are not repeated.
    expect(text).not.toContain('`git status`, `git diff`');
    expect(section({ preApproved: [] }).join('\n')).not.toContain('Claude Code also');
  });

  it('reads allow-list patterns as command prefixes', () => {
    expect(
      preApprovedPrefixes([
        'mcp__team__*',
        'Read',
        'Bash(npm ci)',
        'Bash(npm run build:*)',
        'Bash(git diff:*)',
      ]),
    ).toEqual(['npm run build', 'git diff']);
  });
});
