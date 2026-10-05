import { describe, expect, it } from 'vitest';
import type { AgentSandbox } from '../src/contracts';
import { testTemplate } from './helpers/test-template';
import {
  allowedToolsFor,
  commandVerdict,
  describeSandbox,
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
    'npx prettier --write src/a.ts',
    'npx prettier -w .',
    'npm run format',
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
    'npx prettier --write src/a.ts >/dev/null 2>&1; npm run typecheck 2>&1 | head -20',
    'npm run format 2>&1 | tail -3',
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
    // A routine step allows only a first `cd` to the working directory itself.
    'cd apps/server && npx vitest run && git add -A',
    `cd ${worktree} && git add -A && cd apps && git commit -m "x"`,
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

  it('describes formatting only as a routine step in a repository worktree', () => {
    const text = section().join('\n');
    expect(text).toContain('`npx prettier` with `--write`, `-w`');
    expect(text).toContain('`npm run format` without extra arguments');
    expect(text).toContain('These are not read-only checks');
    expect(text).toContain('Paths outside the worktree wait for a human');
    for (const input of [{ worktree: false }, { hasRepo: false }]) {
      expect(section(input).join('\n')).not.toContain('Formatting is a routine step');
    }
    for (const command of ['npx prettier --write src/a.ts', 'npm run format']) {
      expect(allowed('code_review', command)).toBe(false);
    }
  });

  it('says a routine chain may start with a cd to the working directory only', () => {
    const text = section().join('\n');
    expect(text).toContain('`cd apps/server && npx vitest run && git add -A` waits for a human');
    expect(allowed('developer', `cd ${worktree} && npx vitest run && git add -A`)).toBe(true);
    expect(allowed('developer', 'cd apps/server && npx vitest run && git add -A')).toBe(false);
    expect(section({ worktree: false }).join('\n')).not.toContain('git add -A');
  });

  it.each(['developer', 'code_review'] as const)(
    'describes directory-changing chains with the actual verdicts for %s',
    (role) => {
      const text = section({ worktree: role === 'developer' }).join('\n');
      expect(text).toContain('join its parts with `&&`, not `;` or `||`');
      expect(text).toContain('checks later relative paths from every possible directory');
      const first = 'cd apps/server && npx vitest run test/member-instructions.test.ts 2>&1 | tail -15';
      const second = 'cd ../web && npx vitest run src/features/team 2>&1 | tail -15';
      const ambiguous = `${first}; ${second}`;
      const certain = `${first} && ${second}`;
      expect(text).toContain(`\`${ambiguous}\` waits for a human`);
      expect(text).toContain(`\`${certain}\` runs without asking`);
      expect(verdictFor(role, ambiguous)).toBeNull();
      expect(verdictFor(role, `${first} || ${second}`)).toBeNull();
      expect(verdictFor(role, certain)?.behavior).toBe('allow');
    },
  );

  it("words the introduction for a Codex member's sandbox", () => {
    const claude = section().join('\n');
    expect(claude).toContain('Every other shell command waits in a human inbox');
    expect(claude).toContain('- Never without asking: ');
    const codex = section({ codex: true }).join('\n');
    expect(codex).not.toContain('Every other shell command');
    expect(codex).toContain('Your sandbox runs commands on its own');
    expect(codex).toContain('an escalation waits in a human inbox');
    // Shared git metadata is not granted as a writable root (PM-131).
    expect(codex).toContain(
      '(the network or a write outside your working directory, including shared git metadata)',
    );
    expect(codex).not.toContain('such as the shared .git');
    expect(codex).not.toContain('shared .git is read-only');
    expect(codex).toContain('- Never without asking, as an escalation: ');
    // The rules themselves are the same for both.
    expect(codex).toContain('`git commit -m "message"`');
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

/** The sandbox section of the system prompt names the session folder and the browsers (PM-268). */
describe('describeSandbox: the session folder and the browsers', () => {
  const sessionDir = '/fictional/tmp/projectman-sessions/abc/ses_one';
  const browsers = '/fictional/app/browsers';
  const cache = '/fictional/app/member-caches/AR/dev-1/npm-cache';
  const base = {
    allowWrite: [],
    denyWrite: ['/fictional/work'],
    allowedDomains: ['registry.npmjs.org'],
    allowLocalBinding: true,
  };
  const text = (sandbox: AgentSandbox) =>
    describeSandbox({ sandbox, cwd: '/fictional/work', localOnly: false }).join('\n');

  it('tells a reader it writes its folder too, where it is, that it goes away and where the browsers are', () => {
    const out = text({
      ...base,
      env: { PROJECTMAN_SESSION_DIR: sessionDir, PLAYWRIGHT_BROWSERS_PATH: browsers },
    });
    expect(out).toContain('only the temp directory (`$TMPDIR`) and your session folder');
    expect(out).toContain(`Your session folder: \`${sessionDir}\` (\`$PROJECTMAN_SESSION_DIR\`)`);
    expect(out).toContain('`attach_file` takes their absolute path');
    expect(out).toContain("deleted when its session's process stops");
    expect(out).toContain(`Playwright's are in \`${browsers}\` (\`PLAYWRIGHT_BROWSERS_PATH\`), read-only`);
    expect(out).toContain('npm run browsers -- install');
  });

  it('says the other members’ folders are read, and that a resumed session gets a new one (PM-333)', () => {
    const out = text({ ...base, env: { PROJECTMAN_SESSION_DIR: sessionDir } });
    const line = out.split('\n').find((l) => l.startsWith('- Your session folder'))!;
    expect(line).toContain('Only you write it');
    expect(line).toContain(
      "the other members' session folders next to it (below `/fictional/tmp/projectman-sessions/abc`)",
    );
    expect(line).toContain('you read without asking');
    expect(line).toContain('A resumed session gets a new folder');
    expect(line).toContain('no longer exist');
    expect(line).toContain('`read_attachment`');
    expect(line).not.toContain('yours alone');
  });

  it('keeps the two out of the line about the member’s own npm cache', () => {
    const out = text({
      ...base,
      allowWrite: [sessionDir],
      env: {
        npm_config_cache: cache,
        PROJECTMAN_SESSION_DIR: sessionDir,
        PLAYWRIGHT_BROWSERS_PATH: browsers,
      },
    });
    const line = out.split('\n').find((l) => l.startsWith('- Your own npm cache'))!;
    expect(line).toContain('`npm_config_cache`');
    expect(line).not.toContain('PROJECTMAN_SESSION_DIR');
    expect(line).not.toContain('PLAYWRIGHT_BROWSERS_PATH');
  });

  it('says nothing about either without them', () => {
    const out = text({ ...base, env: { npm_config_cache: cache } });
    expect(out).not.toContain('session folder');
    expect(out).not.toContain('Playwright');
  });
});
