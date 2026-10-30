import path from 'node:path';
import type { AgentProvider, HeavyChecks } from '@projectman/shared';
import { BROWSERS_PATH_VARIABLE, SESSION_DIR_VARIABLE } from '../../contracts';
import type { AgentSandbox } from '../../contracts';
import { isWithin } from '../../kernel';
import {
  GIT_SETTINGS_VARIABLE,
  HEAVY_LOCK_DIR_VARIABLE,
  PREFER_OFFLINE_VARIABLE,
  PTY_SKIP_VARIABLE,
} from '../sessions';
import { SHELL_REDIRECTIONS } from './shell-words';
import {
  NPM_CHECKS,
  NPX_CHECKS,
  NPX_REFUSED_OPTIONS,
  READ_ONLY_GIT,
  READ_ONLY_PROGRAMS,
} from './read-only-commands';
import {
  ADD_FLAGS,
  CHECKOUT_FLAGS,
  COMMIT_FLAGS,
  FORMAT_WRITE_FLAGS,
  INSTALL_FLAGS,
  MERGE_FLAGS,
  RESTORE_FLAGS,
} from './worktree-commands';

/**
 * What the server lets an AI member run without asking a human, worded for the member's system
 * prompt ("Commands that run without asking"). The lists come from the rule files themselves
 * (`read-only-commands.ts`, `worktree-commands.ts`, `shell-words.ts`), so they cannot drift; the
 * sentences about how to write a command describe what the strict parser accepts, and a test
 * (`test/unattended-commands.test.ts`) runs the examples below through `commandVerdict`.
 */

interface UnattendedCommandsInput {
  /** The member's role works in the task's own worktree: it may use the routine steps. */
  worktree: boolean;
  /** The task has a repository, so its worktree exists and may be read. */
  hasRepo: boolean;
  /** The task repository's default branch (what `git merge --ff-only` may name). */
  defaultBranch?: string;
  /** The repository is local-only: publishing is refused. */
  localOnly: boolean;
  /**
   * Command prefixes the member's provider pre-approves on its own (Claude Code's allow list, with
   * any arguments), as `allowedToolsFor` lists them.
   */
  preApproved?: readonly string[];
  /**
   * The member runs in Codex: its sandbox runs commands on its own, and only what the sandbox does
   * not allow (the network or a write outside the working directory) is an escalation that waits
   * for a human.
   */
  codex?: boolean;
  /** Omit command examples from the restriction index, keeping all restrictions. */
  brief?: boolean;
}

/**
 * The command prefixes of a `Bash(...)` allow-list: `Bash(npm run build:*)` is `npm run build`. A
 * pattern without `:*` names one exact command (`Bash(npm ci)`), not a prefix, and is left out.
 */
export function preApprovedPrefixes(allowedTools: readonly string[]): string[] {
  return allowedTools.flatMap((tool) => {
    const match = /^Bash\((.+?):\*\)$/.exec(tool);
    return match ? [match[1]!] : [];
  });
}

function code(value: string): string {
  return `\`${value}\``;
}

const flagList = (flags: ReadonlySet<string>) => [...flags].map(code).join(', ');

/** The project's checks the server allows, as commands. */
export const PROJECT_CHECK_COMMANDS: readonly string[] = [
  ...NPM_CHECKS.map((words) => `npm ${words.join(' ')}`),
  ...NPX_CHECKS.map((words) => `npx ${words.join(' ')}`),
];

/**
 * The line about a member's own session folder (PM-268, PM-339), for its system prompt. Claude
 * looks at an image with the file tool, Codex with `view_image`; both attach with `attach_file`.
 */
export function describeSessionFolder(sessionFolder: string, provider: AgentProvider): string {
  const putThere =
    provider === 'codex'
      ? `put images and other files to attach there; ${code('attach_file')} takes their absolute path, and an image there opens with ${code('view_image')} (the shell does not show images). Make screenshots with the ${code('take_screenshots')} tool, not by running the shots script in the shell: the browser does not start in your sandbox, so the server runs the scenario (written as in ${code('docs/SCREENSHOTS.md')}) in its own and the images land in ${code('shots/')} of this folder; if the tool answers ${code('running')}, wait for the end with ${code('get_screenshot_run')}.`
      : provider === 'gemini'
        ? `write the files to attach there with your file tools (not in plan mode); ${code('attach_file')} takes their absolute path, and a file there opens with ${code('read_file')} (${code('view_file')} on older CLI versions). There is no screenshot tool for you.`
        : `put screenshots and other files to attach there; ${code('attach_file')} takes their absolute path.`;
  return `- Your session folder: ${code(sessionFolder)} (${code(`$${SESSION_DIR_VARIABLE}`)}): ${putThere} Only you write it; the other members' session folders next to it (below ${code(path.dirname(sessionFolder))}) you read without asking, for example a screenshot a teammate names. A folder is deleted when its session's process stops (a stop, a restart), so attach what should stay before you end your turn. A resumed session gets a new folder: folder paths from earlier in this conversation no longer exist, while the files attached to cards stay (${code('list_attachments')}, ${code('read_attachment')}).`;
}

/**
 * The line about the session folder of a Codex or NanoGPT member whose sandbox does not write
 * (PM-522): only the server puts files there, for example what `read_message_attachment` cannot show.
 */
export function describeReadOnlySessionFolder(sessionFolder: string): string {
  return `- Your session folder: ${code(sessionFolder)} (${code(`$${SESSION_DIR_VARIABLE}`)}): the server puts files there for you, for example what ${code('read_message_attachment')} cannot show in its result (a PDF, a binary file, a long text, an image your tool results do not carry); the tool answers with the file's path. Read it with shell commands, and open an image with ${code('view_image')} (the shell does not show images). Your sandbox does not write it, and you make no screenshots. The other members' session folders next to it (below ${code(path.dirname(sessionFolder))}) are readable too. A folder is deleted when its session's process stops (a stop, a restart), and a resumed session gets a new folder: a path from earlier in this conversation no longer exists, so call ${code('read_message_attachment')} again.`;
}

/** The line about a Codex member's own temporary directory (PM-339). */
export function describeSessionTmpDir(tmpDir: string): string {
  return `- Temporary files: ${code('$TMPDIR')} (${code(tmpDir)}) is your own, deleted with the session; send caches and scratch files there. The shared ${code('/tmp')} is not writable.`;
}

/**
 * The boundary of a Claude member whose shell runs in Claude Code's own sandbox (PM-167), worded
 * for its system prompt in place of the command forms above: in the sandbox no command waits for
 * a human, and what it refuses stays refused. The lines of the section, without its heading.
 */
export function describeSandbox(input: {
  heavyChecks?: HeavyChecks;
  sandbox: AgentSandbox;
  /** The session's working directory. */
  cwd: string;
  /** The repository is local-only: publishing is refused. */
  localOnly: boolean;
  /** Full operational details for the on-demand sandbox guide. */
  details?: boolean;
}): string[] {
  const { sandbox, cwd, localOnly } = input;
  if (!input.details) {
    return [
      "Claude Code's sandbox allows commands without special forms or approval; refusals are final, never retry around them.",
      (sandbox.denyWrite ?? []).includes(cwd)
        ? 'The working directory is read-only; send caches/output to `$TMPDIR` or the session folder; load Vite/Vitest with `--configLoader runner`.'
        : 'Write only within session policy/sandbox roots and commit on your task branch; shared git refs and configuration stay closed.',
      ...(sandbox.env?.[SESSION_DIR_VARIABLE]
        ? [
            `Session folder: ${code(sandbox.env[SESSION_DIR_VARIABLE]!)} (${code(`$${SESSION_DIR_VARIABLE}`)}); put screenshots and files to attach here; attach_file takes absolute paths; attach before session stop deletes the folder.`,
          ]
        : []),
      'Keep cache, development-data and test environment variables set; credentials and live data stay closed.',
      ...(localOnly ? ['Local-only repository: no `git push`, `gh pr create` or `gh pr merge`.'] : []),
      `Read get_guide with topic \`sandbox\` for roots, network, gh exceptions, here-documents, browsers${sandbox.env?.[HEAVY_LOCK_DIR_VARIABLE] && input.heavyChecks ? ' and heavy queue' : ''}; ask_human for other required actions.`,
    ];
  }
  // A reader's working directory is `denyWrite`; a developer protects git metadata in shared
  // repositories and independent clones, along with any additional protected paths.
  const readOnly = (sandbox.denyWrite ?? []).includes(cwd);
  const extra = (sandbox.denyWrite ?? []).filter((dir) => dir !== cwd);
  const denyRead = sandbox.denyRead ?? [];
  const ownDirectories = Object.entries(sandbox.env ?? {}).filter(
    ([name]) =>
      name !== PTY_SKIP_VARIABLE &&
      name !== GIT_SETTINGS_VARIABLE &&
      name !== SESSION_DIR_VARIABLE &&
      name !== BROWSERS_PATH_VARIABLE &&
      name !== HEAVY_LOCK_DIR_VARIABLE &&
      name !== PREFER_OFFLINE_VARIABLE,
  );
  const heavyQueue = sandbox.env?.[HEAVY_LOCK_DIR_VARIABLE];
  const gitSettings = sandbox.env?.[GIT_SETTINGS_VARIABLE];
  const sessionFolder = sandbox.env?.[SESSION_DIR_VARIABLE];
  const browsers = sandbox.env?.[BROWSERS_PATH_VARIABLE];
  const skipsPtyTests = sandbox.env?.[PTY_SKIP_VARIABLE] === '1';
  // The directories closed as a whole (the user's home, the app home), not the paths inside them.
  const closed = denyRead.filter((dir) => !denyRead.some((other) => other !== dir && isWithin(other, dir)));
  const lines = [
    "Your shell commands run in Claude Code's own sandbox, in your own permission mode: what the sandbox allows runs without asking, and no particular form of command is needed.",
    readOnly
      ? `- Writing: only the temp directory (${code('$TMPDIR')})${sessionFolder ? ` and your session folder` : ''}. Your working directory ${code(cwd)}${extra.length > 0 ? ` and ${extra.map(code).join(', ')}` : ''} are read-only, for the shell (the sandbox) and for the file tools (deny rules). Read, query git, run the tests and the type checks there, but change nothing. Send caches and output files to ${code('$TMPDIR')}; a Vite or Vitest configuration loads with ${code('--configLoader runner')} (the project's ${code('npm test')} may already pass it).`
      : `- Writing: your working directory ${code(cwd)} with its git metadata (not its hooks or configuration), the temp directory (${code('$TMPDIR')})${sandbox.allowWrite.length > 0 ? ` and ${sandbox.allowWrite.map(code).join(', ')}` : ''}.${
          extra.length > 0
            ? ` Never write these protected paths (including the default branch, the integrating checkout, replacement refs, server-managed snapshot refs, grafts, git configuration, hooks, object alternates and worktree links): ${extra
                .filter((file) => !file.endsWith('.lock'))
                .map(code)
                .join(', ')} (and their lock files); commit on your own branch.`
            : ''
        }`,
    sandbox.allowRead?.length
      ? `- Reading: nothing below ${closed.map(code).join(' and ')} except ${sandbox.allowRead.map(code).join(', ')}; everything outside them (the system, the installed tools). Other worktrees, the app's data and the credentials stay closed: do not look for them.`
      : `- Reading: everything${denyRead.length ? `, except the credentials and the live instance's data: ${denyRead.map(code).join(', ')}` : ''}.`,
    ...(ownDirectories.length > 0
      ? [
          `- Your own npm cache and development data: ${ownDirectories
            .map(([name, value]) => `${code(name)} is ${code(value)}`)
            .join(
              ', ',
            )}. Leave them set: npm, ${code('npx')} and ${code('npm run dev')} use them, and the user's ${code('~/.npm')} and ${code('~/.projectman-dev')} are not writable.`,
        ]
      : []),
    // PM-268: the member's own folder for what it attaches, and the shared browsers.
    ...(sessionFolder ? [describeSessionFolder(sessionFolder, 'claude')] : []),
    ...(browsers
      ? [
          `- Browsers: Playwright's are in ${code(browsers)} (${code(BROWSERS_PATH_VARIABLE)}), read-only; a human installs them (${code('npm run browsers -- install')}).`,
        ]
      : []),
    // PM-216: git's settings and the one message that stays after a commit.
    ...(gitSettings
      ? [
          `- Git: its system settings come from ${code(gitSettings)} (${code('GIT_CONFIG_SYSTEM')}; no automatic gc). After a commit git may print ${code("Unable to create '…/packed-refs.lock'")}: the commit exists, the shared ${code('packed-refs')} is closed to you on purpose; ignore the message, and do not look for a way around it.`,
        ]
      : []),
    // PM-194: the sandbox cannot open a pseudo-terminal, so the PTY tests are left out of this run.
    ...(skipsPtyTests && input.heavyChecks?.ptySkipped?.length
      ? [
          `- Tests leave out files that need a pseudo-terminal (${input.heavyChecks.ptySkipped.map(code).join(', ')}), because ${code(`${PTY_SKIP_VARIABLE}=1`)} is set here and the sandbox cannot open one; report the skipped files to the reviewer, and do not unset the variable.`,
        ]
      : []),
    // PM-332: one heavy run at a time on the machine.
    ...(heavyQueue && input.heavyChecks
      ? [
          `- Machine queue: ${input.heavyChecks.commands.map(code).join(', ')} wait their turn in the machine's heavy-run queue, one at a time across members and the server's full test, so start them in the background; targeted runs inside one workspace do not queue.`,
        ]
      : []),
    ...(sandbox.deniedEnvVars?.length
      ? [`- Environment: ${sandbox.deniedEnvVars.map(code).join(', ')} are unset for your commands.`]
      : []),
    // PM-355: with the member's outbound network on, every host but the denied ones.
    `- Network: ${
      sandbox.allowedDomains.includes('*')
        ? `any outbound host${sandbox.deniedDomains?.length ? ` except ${sandbox.deniedDomains.map(code).join(', ')}` : ''}`
        : `only ${sandbox.allowedDomains.length > 0 ? sandbox.allowedDomains.map(code).join(', ') : 'nothing'}`
    }${sandbox.allowLocalBinding ? '; tests may listen on local ports' : ''}.`,
    // Claude Code 2.1.284 asks for a command with a here-document whenever it cannot analyse the
    // command, sandbox or not (PM-153: an empty here-document at 12:44 on PM-142).
    `- One exception that still waits for a human: a here-document (${code('<<')}). Write files with your file-editing tools and pass text as a quoted argument (${code("git commit -m '…'")}).`,
  ];
  if (sandbox.excludedCommands?.length) {
    lines.push(
      `- ${sandbox.excludedCommands.map(code).join(' and ')} with their arguments run outside the sandbox (they need the GitHub CLI's login), allowed by your permission rules, but only as a command of their own: ${code(`${sandbox.excludedCommands[0]} 12`)}. In a chain, a pipe, a substitution or with a redirection into a file they run inside the sandbox, where the login is out of reach.`,
    );
  }
  if (localOnly) {
    lines.push(
      `- Refused outright: ${code('git push')}, ${code('gh pr create')} and ${code('gh pr merge')}, because the repository is local-only.`,
    );
  }
  lines.push(
    '- A refusal by the sandbox or by a rule is final: do not retry it in another form or look for a way around it. A test or a check that does not run here goes on the card as a note, not into a question. Anything else you really need, ask a human with ask_human and say why.',
  );
  return lines;
}

/** The lines of the section, without its heading; the caller joins them. */
export function describeUnattendedCommands(input: UnattendedCommandsInput): string[] {
  const { worktree, hasRepo, defaultBranch, localOnly, codex } = input;
  const where =
    worktree && hasRepo
      ? "your working directory (the task's worktree)"
      : hasRepo
        ? "your working directory and the task's own worktree"
        : 'your working directory';
  const gitReaders = [...READ_ONLY_GIT].filter((name) => name !== 'branch');
  // Only the prefixes that are not already a check above: the provider's extra pre-approvals.
  const extras = [...new Set(input.preApproved ?? [])].filter(
    (prefix) => !prefix.startsWith('git ') && !PROJECT_CHECK_COMMANDS.includes(prefix),
  );

  const lines = [
    codex
      ? 'Your sandbox runs commands on its own as far as it allows them. What it does not allow (the network or a write outside your working directory, including shared git metadata) is an escalation, and an escalation waits in a human inbox until someone approves it, unless it is one of the forms below; the owner is often away, so a blocked session can lose hours. So write those commands in the forms below. The server judges the command text only, not what it would do.'
      : 'Every other shell command waits in a human inbox until someone approves it, and the owner is often away: a blocked session can lose hours. So write your commands in the forms below. The server judges the command text only, not what it would do.',
    `- Reading: read-only commands run without asking in ${where}. They are ${code('git')} with ${gitReaders.map(code).join(', ')} (and ${code('git branch')} only to list); ${READ_ONLY_PROGRAMS.map(code).join(', ')} (${code('find')} without ${code('-exec')} or ${code('-delete')}, ${code('sort')} without ${code('-o')}, ${code('tail')} without ${code('-f')}, ${code('xargs')} only after a lister such as ${code('git ls-files')}); no ${code('git -c')}, no ${code('--output')}.`,
    `- Project checks: ${PROJECT_CHECK_COMMANDS.map(code).join(', ')}, without ${NPX_REFUSED_OPTIONS.map(code).join(', ')}.${
      extras.length > 0
        ? ` Claude Code also pre-approves ${extras.map(code).join(', ')} with any arguments.`
        : ''
    }`,
  ];
  if (worktree && hasRepo) {
    lines.push(
      `- Formatting is a routine step in your own worktree: ${code('npx prettier')} with ${flagList(FORMAT_WRITE_FLAGS)} and one or more paths inside the worktree (no other options), or ${code('npm run format')} without extra arguments. These are not read-only checks. They may run in a chain, as the first stage of a pipe into readers, and with ${code('>/dev/null 2>&1')}: ${code('npx prettier --write src/a.ts >/dev/null 2>&1; npm run typecheck 2>&1 | head -20')}. Paths outside the worktree wait for a human.`,
    );
    // The rule takes the default branch, its remote branch or a commit id, and no other ref.
    const merge = `${code(`git merge --ff-only ${defaultBranch ?? '<commit id>'}`)}${
      defaultBranch ? ' (or a commit id)' : ''
    } (${flagList(MERGE_FLAGS)})`;
    lines.push(
      `- Routine steps in your worktree: ${code('npm ci')} or ${code('npm install')} (only ${flagList(INSTALL_FLAGS)}), ${code('git add')} (${flagList(ADD_FLAGS)} or worktree paths), ${code('git commit -m "message"')} (${flagList(COMMIT_FLAGS)}; multiline/repeated ${code('-m')} allowed; no ${code('--amend')}, ${code('--no-verify')} or ${code('-F')}), ${code('git checkout -- <path>')} or ${code('git checkout HEAD -- <path>')} (${flagList(CHECKOUT_FLAGS)}), ${code('git restore <path>')} (${flagList(RESTORE_FLAGS)} and ${code('--source=HEAD')}), ${merge}. Checkout/restore: named worktree paths only; no root (${code('.')}), patterns or ${code(':')} pathspecs. Other sources, ${code('git checkout <branch>')} and ${code('git switch')} need a decision. Pipes allow readers only (${code('tee')} waits); ${code('2>&1')} is allowed. Chains allow readers and only an initial ${code('cd')} to the working directory: ${code('cd backend && npx vitest run && git add -A')} waits for a human.`,
    );
  }
  lines.push(
    `- Chaining: ${code('&&')}, ${code('||')} and ${code(';')} between commands, ${code('|')} between the stages of a pipeline, all on one line (a newline between commands is refused). Redirections: only ${SHELL_REDIRECTIONS.map(code).join(', ')}.`,
    `- Quotes: put a pattern or a message in single quotes, which are literal: ${code("grep -n 'task\\.(edit|save)' src")}. Double quotes work too, but a ${code('$')} or a backtick inside them refuses the command, and a backslash there escapes only ${code('$')}, a backtick, ${code('"')} and ${code('\\')}. A text with an apostrophe goes in double quotes.`,
    `- Paths: relative or absolute, but inside the directories above; no ${code('~')}, no ${code('..')} behind a directory name. ${code('cd')} only into such a directory; ${code('git -C <dir>')} only when the directory is the one you are in. When a chain changes directory, join its parts with ${code('&&')}, not ${code(';')} or ${code('||')}: otherwise the server checks later relative paths from every possible directory, since an earlier ${code('cd')} may have failed or been skipped. For example, ${code('cd backend && npx vitest run test/example.test.ts 2>&1 | tail -15; cd ../frontend && npx vitest run src/example.test.ts 2>&1 | tail -15')} waits for a human; ${code('cd backend && npx vitest run test/example.test.ts 2>&1 | tail -15 && cd ../frontend && npx vitest run src/example.test.ts 2>&1 | tail -15')} runs without asking.`,
    `- ${codex ? 'Never without asking, as an escalation' : 'Never without asking'}: interpreters/shells${input.brief ? '' : ` (${['python', 'node', 'perl', 'sed', 'bash -c'].map(code).join(', ')})`}, variables/substitution${input.brief ? '' : ` (${code('$VAR')}, ${code('$(...)')}, backticks)`}, ${['{a,b}', '~', '!', '&'].map(code).join(', ')}, here-documents, file redirection; use file tools.`,
  );
  lines.push(
    `- Refused without asking anyone: in-place shell edits (${(input.brief ? ['sed -i', 'perl -i'] : ['sed -i', 'sed --in-place', 'perl -i', 'perl -pi -e ...']).map(code).join(', ')}).`,
  );
  if (localOnly) {
    lines.push(
      `- Refused outright: ${code('git push')}, ${code('gh pr create')} and ${code('gh pr merge')}, because the repository is local-only.`,
    );
  }
  return lines;
}
