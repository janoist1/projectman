import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEVELOPMENT_SHELL_TOOLS, REVIEW_SHELL_TOOLS } from '@projectman/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionPolicy } from '../contracts';
import {
  decideToolCall,
  resolveToolPath,
  toolPathForms,
  type NormalizedToolCall,
  type ToolDecision,
} from './tool-decision';

type Mode = SessionPolicy['permissions']['claude'];
const MODES: Mode[] = ['default', 'acceptEdits', 'plan', 'auto'];

// The paths are fixed at load: the describe bodies build their policies before any hook runs.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'tool-decision-')));
const home = join(root, 'home');
const work = join(root, 'work');
const extra = join(root, 'extra');
const attachments = join(root, 'attachments');
const outside = join(root, 'outside');

beforeAll(() => {
  for (const dir of [
    join(home, '.ssh'),
    join(home, '.config', 'foo'),
    join(home, '.config', 'gh'),
    join(home, '.projectman'),
    join(work, '.git'),
    join(work, 'src'),
    extra,
    attachments,
    outside,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(home, '.ssh', 'id_ed25519'), 'secret');
  writeFileSync(join(home, 'credentials.json'), '{}');
  symlinkSync(join(home, '.ssh'), join(work, 'ssh-link'));
  symlinkSync(join(home, '.ssh', 'new-key'), join(work, 'dangling'));
  symlinkSync(outside, join(work, 'outside-link'));
  writeFileSync(join(home, '.config', 'gh', 'hosts.yml'), 'token');
  writeFileSync(join(home, '.projectman', 'db.sqlite'), 'db');
  // A ".." behind these steps up from the target, not from the link.
  symlinkSync(join(home, '.config', 'foo'), join(work, 'lnk'));
  symlinkSync(extra, join(work, 'up'));
  mkdirSync(join(work, 'deep', 'dir'), { recursive: true });
  symlinkSync(join(work, 'deep', 'dir'), join(work, 'lnk-in'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function policyFor(mode: Mode, patch: Partial<SessionPolicy> = {}): SessionPolicy {
  return {
    version: 1,
    enforcement: 'legacy',
    access: 'task_worktree',
    placement: { kind: 'task_worktree', path: work },
    tools: {
      team: { all: true, names: [] },
      files: [],
      shell: [
        { command: 'git status', arguments: 'prefix' },
        { command: 'npm test', arguments: 'prefix' },
        { command: 'npm install', arguments: 'exact' },
      ],
    },
    filesystem: {
      readableRoots: [work, extra],
      writableRoots: [work],
      protectedPaths: [join(work, '.git')],
      readOnlyPaths: [attachments],
      deniedPaths: [
        join(home, '.ssh'),
        join(home, 'credentials.json'),
        join(home, '.config', 'gh'),
        join(home, '.projectman', 'db.sqlite*'),
      ],
    },
    deniedOperations: ['git_push', 'pull_request_create', 'pull_request_merge'],
    network: {
      allowedDomains: ['registry.npmjs.org', '*.github.com'],
      allowLocalBinding: false,
      deniedHosts: ['localhost', '127.0.0.1'],
    },
    outsideSandbox: 'ask',
    permissions: {
      claude: mode,
      sandbox: mode === 'plan' ? 'read-only' : 'workspace-write',
      approval: mode === 'plan' ? 'never' : 'on-request',
    },
    ...patch,
  };
}

const reader = (mode: Mode): SessionPolicy =>
  policyFor(mode, {
    access: 'review_copy',
    placement: {
      kind: 'review_copy',
      path: work,
      gitDir: join(root, 'git'),
      sourceCommit: 'abc',
      roundId: 'r1',
    },
  });

const decide = (policy: SessionPolicy, call: NormalizedToolCall, caseInsensitive = false): ToolDecision =>
  decideToolCall(policy, call, { home, caseInsensitive });
const command = (line: string, sandboxed?: boolean): NormalizedToolCall => ({
  category: 'command',
  paths: [],
  command: line,
  ...(sandboxed === undefined ? {} : { sandboxed }),
});
const read = (...paths: string[]): NormalizedToolCall => ({ category: 'read', paths });
const edit = (...paths: string[]): NormalizedToolCall => ({ category: 'edit', paths });
const web = (host: string, category: 'web' | 'browser' = 'web'): NormalizedToolCall => ({
  category,
  paths: [],
  host,
});
const denied = (reason: string): ToolDecision => ({ decision: 'deny', reason }) as ToolDecision;
const ALLOW: ToolDecision = { decision: 'allow' };
const ASK: ToolDecision = { decision: 'ask' };

describe('resolveToolPath', () => {
  it('makes a relative path absolute and takes ".." out', () => {
    expect(resolveToolPath(work, 'src/../src/a.ts', home)).toBe(join(work, 'src', 'a.ts'));
    expect(resolveToolPath(work, '../extra/x', home)).toBe(join(root, 'extra', 'x'));
  });

  it('expands "~" to the home directory', () => {
    expect(resolveToolPath(work, '~', home)).toBe(home);
    expect(resolveToolPath(work, '~/.ssh/id_ed25519', home)).toBe(join(home, '.ssh', 'id_ed25519'));
  });

  it('follows a symlink in the working tree to where it really points', () => {
    expect(resolveToolPath(work, 'ssh-link/id_ed25519', home)).toBe(join(home, '.ssh', 'id_ed25519'));
    // The tail does not exist yet: the deepest existing ancestor is still resolved.
    expect(resolveToolPath(work, 'ssh-link/not/yet/there', home)).toBe(
      join(home, '.ssh', 'not', 'yet', 'there'),
    );
  });

  it('follows a dangling symlink to the file a write would create', () => {
    expect(resolveToolPath(work, 'dangling', home)).toBe(join(home, '.ssh', 'new-key'));
  });

  it('keeps a path that does not exist at all as written', () => {
    expect(resolveToolPath(work, 'nothing/here.txt', home)).toBe(join(work, 'nothing', 'here.txt'));
  });

  it('steps up from where a symlink points when a ".." follows it, as the kernel does', () => {
    // work/lnk -> home/.config/foo, so work/lnk/../gh is home/.config/gh, not work/gh.
    expect(resolveToolPath(work, 'lnk/../gh/hosts.yml', home)).toBe(join(home, '.config', 'gh', 'hosts.yml'));
    // `join` would take the ".." out as text before the call.
    expect(resolveToolPath(work, `${work}/lnk/../gh`, home)).toBe(join(home, '.config', 'gh'));
  });
});

describe('toolPathForms', () => {
  it('gives the one place a path without a ".." behind a symlink means', () => {
    expect(toolPathForms(work, 'src/a.ts', home)).toEqual([join(work, 'src', 'a.ts')]);
    expect(toolPathForms(work, 'ssh-link/id_ed25519', home)).toEqual([join(home, '.ssh', 'id_ed25519')]);
  });

  it('gives both places when the CLI may take the ".." out as text first', () => {
    expect(toolPathForms(work, 'lnk/../gh/hosts.yml', home)).toEqual([
      join(home, '.config', 'gh', 'hosts.yml'),
      join(work, 'gh', 'hosts.yml'),
    ]);
  });
});

describe('row 1: denied paths, in every mode', () => {
  for (const mode of MODES) {
    describe(mode, () => {
      const policy = policyFor(mode);
      it.each([
        ['read', read(join(home, '.ssh', 'id_ed25519'))],
        ['edit', edit(join(home, '.ssh', 'authorized_keys'))],
        ['read of the denied file itself', read(join(home, 'credentials.json'))],
        ['read through "~"', read('~/.ssh/id_ed25519')],
        ['read through "..""', read(join(work, '..', 'home', '.ssh', 'id_ed25519'))],
        ['read through a symlink in the working tree', read(join(work, 'ssh-link', 'id_ed25519'))],
        ['edit through a dangling symlink', edit(join(work, 'dangling'))],
        ['a command naming the path', command(`cat ${join(home, '.ssh', 'id_ed25519')}`, true)],
        ['a command naming it with "~"', command('cat ~/.ssh/id_ed25519', true)],
        ['a command naming it with $HOME', command('cat $HOME/.ssh/id_ed25519', true)],
        ['a command reading it by redirection', command(`wc -c < ${join(home, '.ssh', 'id_ed25519')}`, true)],
        ['a command with it in an option value', command(`tar --file=${join(home, '.ssh')} x`, true)],
        ['a command with it in a quoted script', command(`bash -c 'cat ~/.ssh/id_ed25519'`, true)],
        ['a command through a symlink', command('cat ssh-link/id_ed25519', true)],
        ['a command through ".."', command('cat ../home/.ssh/id_ed25519', true)],
        ['a command that is allowed by a shell rule', command('git status ~/.ssh/id_ed25519')],
        ['read behind a symlink and a ".."', read('lnk/../gh/hosts.yml')],
        ['read behind a symlink and a ".." (absolute)', read(`${work}/lnk/../gh/hosts.yml`)],
        ['edit behind a symlink and a ".."', edit('lnk/../gh/hosts.yml')],
        ['a command behind a symlink and a ".."', command('cat lnk/../gh/hosts.yml', true)],
        ['a command behind a symlink and a ".." (shell rule)', command('git status lnk/../gh/hosts.yml')],
        ['read of the first pattern match', read(join(home, '.projectman', 'db.sqlite'))],
        [
          'read of a name the pattern ends with a star for (-wal)',
          read(join(home, '.projectman', 'db.sqlite-wal')),
        ],
        [
          'read of a name the pattern ends with a star for (-shm)',
          read(join(home, '.projectman', 'db.sqlite-shm')),
        ],
        ['edit of a pattern match', edit(join(home, '.projectman', 'db.sqlite-wal'))],
        ['a command opening the database', command('sqlite3 ~/.projectman/db.sqlite', true)],
        [
          'a command opening the database (absolute)',
          command(`sqlite3 ${join(home, '.projectman', 'db.sqlite-wal')}`, true),
        ],
        ['a command opening the database ($HOME)', command('cp $HOME/.projectman/db.sqlite-shm x', true)],
        [
          'a command opening the database (quoted script)',
          command(`sh -c "sqlite3 ~/.projectman/db.sqlite"`, true),
        ],
        ['a command after a cd to the home', command('cd ~ && cat .ssh/id_ed25519', true)],
        ['a command after a cd to a relative directory', command('cd ../home && cat .ssh/id_ed25519', true)],
        ['a command after a pushd', command('pushd ~; cat .ssh/id_ed25519', true)],
        ['a command after a bare cd', command('cd; cat .ssh/id_ed25519', true)],
        [
          'the MCP team tool path',
          { category: 'team_mcp', paths: [join(home, '.ssh', 'x')], mcpTool: 'mcp__team__get_task' },
        ],
      ] as Array<[string, NormalizedToolCall]>)('denies %s', (_name, call) => {
        expect(decide(policy, call)).toEqual(denied('denied_path'));
      });

      it('denies it in a reading placement too', () => {
        expect(decide(reader(mode), read(join(home, '.ssh', 'id_ed25519')))).toEqual(denied('denied_path'));
      });

      it('does not deny a sibling that only shares the name prefix', () => {
        expect(decide(policy, read(join(home, '.ssh-other', 'x')))).toEqual(ASK);
        expect(decide(policy, command(`cat ${join(home, '.ssh-other')}`, true))).not.toEqual(
          denied('denied_path'),
        );
        expect(decide(policy, read(join(home, '.projectman', 'other.sqlite')))).toEqual(ASK);
        expect(decide(policy, command('sqlite3 ~/.projectman/other.sqlite', true))).not.toEqual(
          denied('denied_path'),
        );
      });

      it('does not deny a command that stays in the working tree after a cd', () => {
        expect(decide(policy, command('cd src && cat a.ts', true))).not.toEqual(denied('denied_path'));
      });

      it('denies on the physical or the textual place of a ".." behind a symlink, allows on both', () => {
        // work/up -> extra: work/up/../x is root/x for the kernel and work/x as text.
        expect(decide(policy, read('up/../x'))).toEqual(ASK);
        expect(decide(policy, edit('up/../x'))).toEqual(mode === 'plan' ? denied('plan_mode') : ASK);
        // work/lnk-in -> work/deep/dir: both places are inside the working tree.
        expect(decide(policy, read('lnk-in/../x'))).toEqual(ALLOW);
      });

      it('compares the denied paths with regard to case where the filesystem does not', () => {
        const upper = read(join(home, '.SSH', 'id_ed25519'));
        expect(decide(policy, upper, true)).toEqual(denied('denied_path'));
        expect(decide(policy, read('~/.Config/GH/hosts.yml'), true)).toEqual(denied('denied_path'));
        expect(decide(policy, command('cat ~/.SSH/id_ed25519', true), true)).toEqual(denied('denied_path'));
        expect(decide(policy, command('cat ~/.PROJECTMAN/DB.SQLITE', true), true)).toEqual(
          denied('denied_path'),
        );
        expect(decide(policy, upper, false)).toEqual(ASK);
      });
    });
  }
});

describe('row 2: denied operations', () => {
  const disguised = [
    'git push',
    'git push origin main',
    'cd x && git push',
    'cd x || git push',
    'true; git push',
    'echo a | git push',
    'git -C x push',
    'git -c user.name=a -C x push',
    'git --git-dir=x/.git push',
    'git --git-dir x/.git --no-pager push',
    "git -c 'alias.p=push' p",
    'git --config-env=alias.p=PUSH_ALIAS p',
    'git --config-env alias.p=PUSH_ALIAS p',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.p GIT_CONFIG_VALUE_0=push git p',
    "env GIT_CONFIG_PARAMETERS='alias.p=push' git p",
    'bash -c "git push"',
    "bash -c 'git push'",
    "sh -c 'cd x && git push'",
    "bash -lc 'git push'",
    'zsh -c \'bash -c "git push"\'',
    'echo $(git push)',
    'echo "$(git push)"',
    'echo `git push`',
    'diff <(git push) x',
    '(git push)',
    'env A=1 git push',
    'env -i A=1 git push',
    'command git push',
    'exec git push',
    'sudo git push',
    'xargs git push',
    'find . -exec git push {} \\;',
    '/usr/bin/git push',
    '"git" push',
    '\\git push',
    "eval 'git push'",
    'eval git push',
    'git pu""sh',
    'echo hi\ngit push',
    // The words the line does not spell: a variable or a substitution where the subcommand belongs.
    'GIT=git; $GIT push',
    'git $x',
    "git $'\\x70ush'",
    'git p$(echo ush)',
    'git $(echo push) origin',
    // A shell that takes its script from the input.
    "echo 'git push' | sh",
    "echo 'git push' | bash -",
    "echo 'git push' | bash -s",
    "sh <<< 'git push'",
    'bash < script.sh',
    'cat x | env A=1 sh',
    // Other ways to push.
    'git subtree push --prefix x origin main',
    'git -C x subtree push x y',
    'git send-pack x',
  ];
  const publishing = [
    'gh api -X POST repos/o/r/pulls',
    'gh api -XPOST repos/o/r/pulls',
    'gh api --method POST repos/o/r/pulls',
    'gh api --method=post repos/o/r/pulls',
    'gh api repos/o/r/pulls -f title=x',
    'gh api repos/o/r/pulls --input body.json',
    'gh api -X PUT repos/o/r/pulls/1/merge',
    "gh api graphql -f query='mutation { createPullRequest(input: {}) { clientMutationId } }'",
    "gh api graphql -f query='mutation { mergePullRequest(input: {}) { clientMutationId } }'",
    'gh api -X POST $URL',
    'gh $x create',
    'gh pr $x',
    '$GH pr create',
    'gh pr create --title x',
    'gh pr merge 12',
    'gh -R owner/repo pr create',
    'gh --repo owner/repo pr merge 1',
    'gh pr -R owner/repo create',
    "bash -c 'gh pr create'",
    'cd x && env GH_TOKEN=1 gh pr merge 3',
  ];

  for (const mode of MODES) {
    describe(mode, () => {
      const policy = policyFor(mode);
      it.each([...disguised, ...publishing])('denies %j', (line) => {
        expect(decide(policy, command(line, true))).toEqual(denied('denied_operation'));
        expect(decide(policy, command(line, false))).toEqual(denied('denied_operation'));
      });

      it.each([
        'git status',
        'git commit -m "do not git push yet"',
        "git log --grep='git push'",
        'echo gh pr',
        'gh pr view 3',
        'gh pr list',
        'git pull',
        'git -C x status',
        'npm run push',
        'git subtree add --prefix x y z',
        'git status $x',
        'git commit -m "$message"',
        "bash -c 'git status'",
        'bash script.sh',
        'echo bash',
        'ls sh',
        'gh api repos/o/r/pulls',
        'gh api -X GET repos/o/r/pulls -f state=open',
        'gh api repos/o/r/pulls/1',
        'gh api -X POST repos/o/r/issues -f title=x',
      ])('does not take %j for a denied operation', (line) => {
        expect(decide(policy, command(line, true))).not.toEqual(denied('denied_operation'));
      });
    });
  }

  it('denies only what the policy denies', () => {
    const policy = policyFor('default', { deniedOperations: ['pull_request_merge'] });
    expect(decide(policy, command('git push', true))).not.toEqual(denied('denied_operation'));
    expect(decide(policy, command('gh pr create', true))).not.toEqual(denied('denied_operation'));
    expect(decide(policy, command('cd x && gh pr merge 1', true))).toEqual(denied('denied_operation'));
  });

  it('does not trust a line nested deeper than it follows', () => {
    let line = 'git status';
    for (let i = 0; i < 12; i += 1) line = `bash -c '${line.replace(/'/g, `'\\''`)}'`;
    expect(decide(policyFor('auto'), command(line, true))).toEqual(denied('denied_operation'));
  });
});

describe('row 3: denied hosts', () => {
  for (const mode of MODES) {
    describe(mode, () => {
      const policy = policyFor(mode);
      it.each([
        'localhost',
        'LOCALHOST',
        'localhost:4800',
        '127.0.0.1',
        '127.0.0.1:4800',
        '[::1]:4800',
        '0.0.0.0',
        'app.localhost',
        '127.1.2.3',
        '127.1',
        '127.0.1',
        '2130706433',
        '0x7f000001',
        '0x7f.0.0.1',
        '0177.0.0.1',
        '0',
        '[::ffff:127.0.0.1]',
        '[::ffff:7f00:1]',
        '[0:0:0:0:0:0:0:1]',
        '[0::1]',
        '[::]:4800',
      ])('denies the web tool and the browser for %s', (host) => {
        expect(decide(policy, web(host))).toEqual(denied('denied_host'));
        expect(decide(policy, web(host, 'browser'))).toEqual(denied('denied_host'));
      });

      it('denies a host even when the allowed domains name it', () => {
        const both = policyFor(mode, {
          network: { allowedDomains: ['localhost'], allowLocalBinding: true, deniedHosts: ['localhost'] },
        });
        expect(decide(both, web('localhost'))).toEqual(denied('denied_host'));
      });

      it('does not mistake a host that only ends like a denied one', () => {
        expect(decide(policy, web('notlocalhost.example.com'))).toEqual(ASK);
      });

      it.each(['128.0.0.1', '1.2.3.4', '10.0.0.1', '[::ffff:8.8.8.8]', '[::2]', '4294967296', '1.2.3.4.5'])(
        'does not mistake %s for the machine itself',
        (host) => {
          expect(decide(policy, web(host))).toEqual(ASK);
        },
      );
    });
  }
});

describe('row 4: read', () => {
  for (const mode of MODES) {
    describe(mode, () => {
      for (const [name, policy] of [
        ['a working placement', policyFor(mode)],
        ['a reading placement', reader(mode)],
      ] as const) {
        it(`allows paths under the readable, writable and read-only roots (${name})`, () => {
          expect(decide(policy, read(join(work, 'src', 'a.ts')))).toEqual(ALLOW);
          expect(decide(policy, read(join(extra, 'a.ts'), join(work, 'b.ts')))).toEqual(ALLOW);
          expect(decide(policy, read(join(attachments, 'a.pdf')))).toEqual(ALLOW);
          expect(decide(policy, read('src/a.ts'))).toEqual(ALLOW);
          expect(decide(policy, read('../extra/a.ts'))).toEqual(ALLOW);
        });

        it(`asks when any path is outside them (${name})`, () => {
          expect(decide(policy, read(join(outside, 'a.txt')))).toEqual(ASK);
          expect(decide(policy, read(join(work, 'a.ts'), join(outside, 'a.txt')))).toEqual(ASK);
          expect(decide(policy, read(join(work, '..', 'outside', 'a.txt')))).toEqual(ASK);
          expect(decide(policy, read(join(work, 'outside-link', 'a.txt')))).toEqual(ASK);
          expect(decide(policy, read('/etc/hosts'))).toEqual(ASK);
        });
      }

      it('asks for a read that names no path', () => {
        expect(decide(policyFor(mode), read())).toEqual(ASK);
      });

      it('does not read a root that is only a name prefix of the path', () => {
        expect(decide(policyFor(mode), read(`${work}-copy/a.ts`))).toEqual(ASK);
      });
    });
  }

  it('reads a path inside a root that is itself a symlink', () => {
    const link = join(root, 'extra-link');
    symlinkSync(extra, link);
    const policy = policyFor('default', {
      filesystem: { readableRoots: [link], writableRoots: [], protectedPaths: [] },
    });
    expect(decide(policy, read(join(extra, 'a.ts')))).toEqual(ALLOW);
    expect(decide(policy, read(join(link, 'a.ts')))).toEqual(ALLOW);
  });
});

describe('the macOS firmlink prefix', () => {
  const data = '/System/Volumes/Data';
  it('reads a root through the prefix', () => {
    expect(decide(policyFor('default'), read(`${data}${work}/src/a.ts`))).toEqual(ALLOW);
  });

  it('denies a denied path through the prefix', () => {
    expect(decide(policyFor('default'), read(`${data}${home}/.ssh/id_ed25519`))).toEqual(
      denied('denied_path'),
    );
    expect(decide(policyFor('acceptEdits'), edit(`${data}${home}/.config/gh/hosts.yml`))).toEqual(
      denied('denied_path'),
    );
  });

  it('keeps a protected path protected through the prefix', () => {
    expect(decide(policyFor('acceptEdits'), edit(`${data}${work}/.git/config`))).toEqual(ASK);
  });
});

describe('row 5: team tools', () => {
  const tool = (name: string): NormalizedToolCall => ({ category: 'team_mcp', paths: [], mcpTool: name });
  for (const mode of MODES) {
    describe(mode, () => {
      it('allows every team tool when the policy grants all', () => {
        expect(decide(policyFor(mode), tool('mcp__team__send_message'))).toEqual(ALLOW);
        expect(decide(reader(mode), tool('mcp__team__get_task'))).toEqual(ALLOW);
      });

      const named = policyFor(mode, {
        tools: { team: { all: false, names: ['get_task', 'send_message'] }, files: [], shell: [] },
      });
      it('allows only the named tools otherwise', () => {
        expect(decide(named, tool('mcp__team__get_task'))).toEqual(ALLOW);
        expect(decide(named, tool('mcp__team__send_message'))).toEqual(ALLOW);
        expect(decide(named, tool('mcp__team__update_task'))).toEqual(denied('not_granted'));
        expect(decide(named, tool('mcp__team__get_task_extra'))).toEqual(denied('not_granted'));
      });

      it('does not grant a tool of another server by its name', () => {
        expect(decide(named, tool('mcp__other__get_task'))).toEqual(denied('not_granted'));
        expect(decide(named, { category: 'team_mcp', paths: [] })).toEqual(denied('not_granted'));
      });
    });
  }
});

describe('row 6: edit', () => {
  const inWork = edit(join(work, 'src', 'a.ts'));
  it.each([
    ['default', ASK],
    ['acceptEdits', ALLOW],
    ['plan', denied('plan_mode')],
    ['auto', ALLOW],
  ] as Array<[Mode, ToolDecision]>)('in %s mode inside the writable roots', (mode, expected) => {
    expect(decide(policyFor(mode), inWork)).toEqual(expected);
    expect(decide(policyFor(mode), edit('src/a.ts'))).toEqual(expected);
    expect(decide(policyFor(mode), edit(join(work, 'new', 'deep', 'a.ts')))).toEqual(expected);
  });

  for (const mode of MODES) {
    describe(mode, () => {
      const policy = policyFor(mode);
      const expectedHere = (here: ToolDecision) => (mode === 'plan' ? denied('plan_mode') : here);

      it('asks for a path outside the writable roots', () => {
        expect(decide(policy, edit(join(outside, 'a.txt')))).toEqual(expectedHere(ASK));
        expect(decide(policy, edit(join(extra, 'a.txt')))).toEqual(expectedHere(ASK));
        expect(decide(policy, edit(join(work, '..', 'outside', 'a.txt')))).toEqual(expectedHere(ASK));
        expect(decide(policy, edit(join(work, 'outside-link', 'a.txt')))).toEqual(expectedHere(ASK));
        expect(decide(policy, edit(join(work, 'a.ts'), join(outside, 'a.txt')))).toEqual(expectedHere(ASK));
      });

      it('asks for a protected path, even inside the writable roots', () => {
        expect(decide(policy, edit(join(work, '.git', 'config')))).toEqual(expectedHere(ASK));
        expect(decide(policy, edit(join(work, 'a.ts'), join(work, '.git', 'hooks', 'x')))).toEqual(
          expectedHere(ASK),
        );
      });

      it('denies a path under the read-only paths', () => {
        const expected = mode === 'plan' ? denied('plan_mode') : denied('read_only_placement');
        expect(decide(policy, edit(join(attachments, 'a.pdf')))).toEqual(expected);
        expect(decide(policy, edit(join(work, 'a.ts'), join(attachments, 'a.pdf')))).toEqual(expected);
      });

      it('denies every edit in a reading placement, whatever the path', () => {
        const expected = mode === 'plan' ? denied('plan_mode') : denied('read_only_placement');
        expect(decide(reader(mode), inWork)).toEqual(expected);
        expect(decide(reader(mode), edit(join(outside, 'a.txt')))).toEqual(expected);
        expect(decide(policyFor(mode, { access: 'read_only' }), inWork)).toEqual(expected);
      });

      it('asks for an edit that names no path', () => {
        expect(decide(policy, edit())).toEqual(expectedHere(ASK));
      });

      it('compares protected and read-only paths without case on a case-insensitive filesystem', () => {
        expect(decide(policy, edit(join(work, '.GIT', 'config')), true)).toEqual(expectedHere(ASK));
        expect(decide(policy, edit(join(root, 'ATTACHMENTS', 'a.pdf')), true)).toEqual(
          mode === 'plan' ? denied('plan_mode') : denied('read_only_placement'),
        );
      });

      it('keeps the case when the filesystem tells names apart by case', () => {
        expect(decide(policy, edit(join(work, '.GIT', 'config')), false)).toEqual(
          mode === 'acceptEdits' || mode === 'auto' ? ALLOW : expectedHere(ASK),
        );
      });
    });
  }

  it('treats a review copy with the strict test opt-in as a working placement', () => {
    const policy = policyFor('acceptEdits', {
      access: 'review_copy',
      enforcement: 'strict',
      reviewCopyMode: 'test',
      placement: {
        kind: 'review_copy',
        path: work,
        gitDir: join(root, 'git'),
        sourceCommit: 'abc',
        roundId: 'r1',
      },
    });
    expect(decide(policy, edit(join(work, 'a.ts')))).toEqual(ALLOW);
  });

  it('treats bypassPermissions as default', () => {
    expect(decide(policyFor('bypassPermissions'), inWork)).toEqual(ASK);
  });
});

describe('row 7: command', () => {
  describe('the shell rules', () => {
    for (const mode of MODES) {
      describe(mode, () => {
        const policy = policyFor(mode);
        it('allows a sandboxed simple command that matches a prefix rule, with or without arguments', () => {
          expect(decide(policy, command('git status', true))).toEqual(ALLOW);
          expect(decide(policy, command('git status -sb', true))).toEqual(ALLOW);
          expect(decide(policy, command('  npm   test   -- --run ', true))).toEqual(ALLOW);
          expect(decide(policy, command('git status "src/a b.ts"', true))).toEqual(ALLOW);
        });

        it('lets a rule-matching command outside the sandbox fall through like any other', () => {
          for (const line of ['git status', 'git status -sb', 'npm test -- --run', 'npm install']) {
            for (const sandboxed of [false, undefined]) {
              expect(decide(policy, command(line, sandboxed))).toEqual(
                decide(policy, command('make build', sandboxed)),
              );
            }
          }
        });

        it('denies a rule-matching command outside the sandbox when outside the sandbox is denied', () => {
          if (mode === 'plan') return;
          const strict = policyFor(mode, { outsideSandbox: 'deny' });
          for (const line of ['git status', 'npm test', 'git status --output=x', 'npm install']) {
            for (const sandboxed of [false, undefined]) {
              expect(decide(strict, command(line, sandboxed))).toEqual(denied('not_granted'));
            }
            expect(decide(strict, command(line, true))).toEqual(ALLOW);
          }
        });

        it('allows an exact rule only without arguments', () => {
          expect(decide(policy, command('npm install', true))).toEqual(ALLOW);
          if (mode !== 'auto')
            expect(decide(policy, command('npm install left-pad', true))).not.toEqual(ALLOW);
          expect(decide(policy, command('npm install left-pad', false))).not.toEqual(ALLOW);
        });

        it('does not match a rule at a word boundary it is not on', () => {
          expect(decide(policy, command('git statusx', false))).not.toEqual(ALLOW);
          expect(decide(policy, command('git status-all', false))).not.toEqual(ALLOW);
          expect(decide(policy, command('npm tests', false))).not.toEqual(ALLOW);
        });

        it.each([
          'git status && rm -rf x',
          'git status; rm -rf x',
          'git status || rm -rf x',
          'git status | sh',
          'git status & rm x',
          'git status > out.txt',
          'git status < in.txt',
          'git status $(rm x)',
          'git status `rm x`',
          'git status $HOME',
          'git status\nrm x',
          'git status (x)',
          'git status {a,b}',
          'git status \\; rm',
          'npm test && npm publish',
        ])('does not match a rule with %j', (line) => {
          expect(decide(policy, command(line, false))).not.toEqual(ALLOW);
          if (mode !== 'auto') expect(decide(policy, command(line, true))).not.toEqual(ALLOW);
        });

        it('lets the policy denied-operation row win over a rule', () => {
          const withPush = policyFor(mode, {
            tools: {
              team: { all: true, names: [] },
              files: [],
              shell: [{ command: 'git', arguments: 'prefix' }],
            },
          });
          expect(decide(withPush, command('git push'))).toEqual(denied('denied_operation'));
          expect(decide(withPush, command('git log', true))).toEqual(ALLOW);
        });
      });
    }

    it('allows a sandboxed matching rule in plan mode too, and denies it outside the sandbox', () => {
      expect(decide(policyFor('plan'), command('git status', true))).toEqual(ALLOW);
      expect(decide(policyFor('plan'), command('git status', false))).toEqual(denied('plan_mode'));
    });
  });

  describe('the other commands', () => {
    it('plan mode denies', () => {
      expect(decide(policyFor('plan'), command('make build', true))).toEqual(denied('plan_mode'));
      expect(decide(policyFor('plan'), command('make build', false))).toEqual(denied('plan_mode'));
      expect(decide(policyFor('plan'), command('make build'))).toEqual(denied('plan_mode'));
    });

    it('auto mode allows a sandboxed command', () => {
      expect(decide(policyFor('auto'), command('make build', true))).toEqual(ALLOW);
      expect(decide(policyFor('auto'), command('make build && make test', true))).toEqual(ALLOW);
    });

    it.each(['default', 'acceptEdits'] as Mode[])('%s mode asks about a sandboxed command', (mode) => {
      expect(decide(policyFor(mode), command('make build', true))).toEqual(ASK);
    });

    it.each(['default', 'acceptEdits', 'auto'] as Mode[])(
      '%s mode asks about an unsandboxed command when outside the sandbox may ask',
      (mode) => {
        expect(decide(policyFor(mode), command('make build', false))).toEqual(ASK);
        expect(decide(policyFor(mode), command('make build'))).toEqual(ASK);
      },
    );

    it.each(MODES.filter((mode) => mode !== 'plan'))(
      '%s mode denies an unsandboxed command when outside the sandbox is denied',
      (mode) => {
        const strict = policyFor(mode, { outsideSandbox: 'deny' });
        expect(decide(strict, command('make build', false))).toEqual(denied('not_granted'));
        expect(decide(strict, command('make build'))).toEqual(denied('not_granted'));
      },
    );

    it('still lets a sandboxed command ask or run when outside the sandbox is denied', () => {
      expect(decide(policyFor('default', { outsideSandbox: 'deny' }), command('make', true))).toEqual(ASK);
      expect(decide(policyFor('auto', { outsideSandbox: 'deny' }), command('make', true))).toEqual(ALLOW);
    });

    it('treats a command with no line like an unknown one', () => {
      expect(decide(policyFor('default'), { category: 'command', paths: [] })).toEqual(ASK);
    });

    it('treats bypassPermissions as default', () => {
      expect(decide(policyFor('bypassPermissions'), command('make', true))).toEqual(ASK);
    });
  });
});

describe('row 8: web and browser', () => {
  for (const mode of MODES) {
    describe(mode, () => {
      const policy = policyFor(mode);
      it.each(['web', 'browser'] as const)('allows an allowed domain (%s)', (category) => {
        expect(decide(policy, web('registry.npmjs.org', category))).toEqual(ALLOW);
        expect(decide(policy, web('Registry.NPMJS.org:443', category))).toEqual(ALLOW);
        expect(decide(policy, web('api.github.com', category))).toEqual(ALLOW);
      });

      it.each(['web', 'browser'] as const)('asks about any other host (%s)', (category) => {
        expect(decide(policy, web('example.com', category))).toEqual(ASK);
        expect(decide(policy, web('evilregistry.npmjs.org.example.com', category))).toEqual(ASK);
        expect(decide(policy, web('github.com', category))).toEqual(ASK);
        expect(decide(policy, { category, paths: [] })).toEqual(ASK);
      });
    });
  }
});

describe('row 9: other MCP tools and unknown calls', () => {
  for (const mode of MODES) {
    it(`asks in ${mode} mode`, () => {
      expect(decide(policyFor(mode), { category: 'mcp', paths: [], mcpTool: 'mcp__other__do' })).toEqual(ASK);
      expect(decide(policyFor(mode), { category: 'unknown', paths: [] })).toEqual(ASK);
      expect(decide(reader(mode), { category: 'unknown', paths: [] })).toEqual(ASK);
    });
  }
});

describe('a shell rule and what the shell expands by itself', () => {
  // The rules a real role gets, not the small set of the other tests.
  const withRealRules = (mode: Mode): SessionPolicy =>
    policyFor(mode, {
      tools: {
        team: { all: true, names: [] },
        files: ['read', 'grep', 'glob'],
        shell: [...DEVELOPMENT_SHELL_TOOLS, ...REVIEW_SHELL_TOOLS],
      },
    });

  for (const mode of MODES) {
    describe(mode, () => {
      const policy = withRealRules(mode);

      it.each([
        ['a "?" pattern', 'git diff --no-index ~/.ss?/id /dev/null'],
        ['a bracket pattern', 'git diff --no-index ~/.ss[h]/id /dev/null'],
        ['a star pattern', 'git diff --no-index ~/.s*/id /dev/null'],
        ['a star pattern for a file', 'git show ~/cred*.json'],
        ['a pattern in the database name', 'git diff --no-index ~/.projectman/db.sq?ite /dev/null'],
        ["another user's home spelling", 'git diff --no-index ~home/.ssh/id /dev/null'],
        ['a pattern after a cd', 'git status && cd ~ ; git diff --no-index .s?h/id /dev/null'],
      ])('denies %s that reaches a denied path, whatever the rule says', (_name, line) => {
        for (const sandboxed of [true, false, undefined]) {
          expect(decide(policy, command(line, sandboxed))).toEqual(denied('denied_path'));
        }
      });

      it.each([
        'git diff --no-index ~/.ss?/id /dev/null',
        'git diff ~/notes.txt',
        'git diff ~other/notes.txt',
        'git diff --output=~/x',
        'git diff *.ts',
        'git diff src/?.ts',
        'git diff src/[ab].ts',
        'git status ~',
        'npm test -- ~/x',
        'git add *',
      ])('does not match a rule with the unquoted expansion in %j', (line) => {
        for (const sandboxed of [false, undefined]) {
          expect(decide(policy, command(line, sandboxed))).not.toEqual(ALLOW);
        }
      });

      it.each([
        'git diff HEAD~1',
        'git diff HEAD~1 -- src/a.ts',
        "git diff -- 'src/*.ts'",
        'git log --grep="a?b"',
        "git log --grep='[fix]'",
        'git log -n 3 --format="%h ~ %s"',
        'git status',
        'npm test -- --run',
      ])('keeps %j a plain command a rule can allow', (line) => {
        expect(decide(policy, command(line, true))).toEqual(ALLOW);
      });

      it('does not take a pattern that cannot reach a denied path for a denied one', () => {
        expect(decide(policy, command('git diff --no-index ~/*.txt /dev/null', false))).not.toEqual(
          denied('denied_path'),
        );
        expect(decide(policy, command('git diff src/*.ts', false))).not.toEqual(denied('denied_path'));
      });
    });
  }
});
