import { SHELL_REDIRECTIONS } from './shell-words';
import {
  NPM_CHECKS,
  NPX_CHECKS,
  NPX_REFUSED_OPTIONS,
  READ_ONLY_GIT,
  READ_ONLY_PROGRAMS,
} from './read-only-commands';
import { ADD_FLAGS, COMMIT_FLAGS, FORMAT_WRITE_FLAGS, INSTALL_FLAGS, MERGE_FLAGS } from './worktree-commands';

/**
 * What the server lets an AI member run without asking a human, worded for the member's system
 * prompt ("Commands that run without asking"). The lists come from the rule files themselves
 * (`read-only-commands.ts`, `worktree-commands.ts`, `shell-words.ts`), so they cannot drift; the
 * sentences about how to write a command describe what the strict parser accepts, and a test
 * (`test/unattended-commands.test.ts`) runs the examples below through `commandVerdict`.
 */

export interface UnattendedCommandsInput {
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
    } with ${flagList(MERGE_FLAGS)} if you like`;
    lines.push(
      `- Your routine steps in your own worktree: ${code('npm ci')} or ${code('npm install')} (only with ${flagList(INSTALL_FLAGS)}), ${code('git add')} (${flagList(ADD_FLAGS)} or paths inside the worktree), ${code('git commit -m "message"')} (also ${flagList(COMMIT_FLAGS)}; a message of several lines inside the quotes is fine, so is a second ${code('-m')}; no ${code('--amend')}, ${code('--no-verify')} or ${code('-F')}), ${merge}. Each is one command. It may be followed by ${code('2>&1')} and a pipe into readers that only filter its output (${code('npm install --prefer-offline --no-audit --no-fund 2>&1 | tail -3')}), but a ${code('tee')} or any other writer after the pipe waits for a human. Readers may stand between them in a chain. A chain with a routine step may start with ${code('cd')} to the working directory itself and has no other ${code('cd')}: ${code('cd apps/server && npx vitest run && git add -A')} waits for a human.`,
    );
  }
  lines.push(
    `- Chaining: ${code('&&')}, ${code('||')} and ${code(';')} between commands, ${code('|')} between the stages of a pipeline, all on one line (a newline between commands is refused). Redirections: only ${SHELL_REDIRECTIONS.map(code).join(', ')}.`,
    `- Quotes: put a pattern or a message in single quotes, which are literal: ${code("grep -n 'task\\.(edit|save)' src")}. Double quotes work too, but a ${code('$')} or a backtick inside them refuses the command, and a backslash there escapes only ${code('$')}, a backtick, ${code('"')} and ${code('\\')}. A text with an apostrophe goes in double quotes.`,
    `- Paths: relative or absolute, but inside the directories above; no ${code('~')}, no ${code('..')} behind a directory name. ${code('cd')} only into such a directory; ${code('git -C <dir>')} only when the directory is the one you are in. When a chain changes directory, join its parts with ${code('&&')}, not ${code(';')} or ${code('||')}: otherwise the server checks later relative paths from every possible directory, since an earlier ${code('cd')} may have failed or been skipped. For example, ${code('cd apps/server && npx vitest run test/member-instructions.test.ts 2>&1 | tail -15; cd ../web && npx vitest run src/features/team 2>&1 | tail -15')} waits for a human; ${code('cd apps/server && npx vitest run test/member-instructions.test.ts 2>&1 | tail -15 && cd ../web && npx vitest run src/features/team 2>&1 | tail -15')} runs without asking.`,
    `- ${codex ? 'Never without asking, as an escalation' : 'Never without asking'}: interpreters and shells (${code('python')}, ${code('node')}, ${code('perl')}, ${code('sed')}, ${code('bash -c')}), shell variables and substitution (${code('$VAR')}, ${code('$(...)')}, backticks), ${code('{a,b}')} braces, ${code('~')}, ${code('!')}, a single ${code('&')}, here-documents and any redirection into a file (${code('>')}, ${code('>>')}, ${code('<')}). Change files with your file-editing tools, not through the shell.`,
  );
  lines.push(
    `- Refused without asking anyone: a command that rewrites a file in place (${code('sed -i')}, ${code('sed --in-place')}, ${code('perl -i')}, ${code('perl -pi -e ...')}), alone or in a chain. It is answered at once with a pointer to your ${code('Edit')} and ${code('Write')} tools, which need no permission: use them.`,
  );
  if (localOnly) {
    lines.push(
      `- Refused outright: ${code('git push')}, ${code('gh pr create')} and ${code('gh pr merge')}, because the repository is local-only.`,
    );
  }
  return lines;
}
