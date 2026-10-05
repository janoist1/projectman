import { lstatSync, readlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { placementReadsOnly, type DeniedSessionOperation } from '@projectman/shared';
import type { SessionPolicy } from '../contracts';

/**
 * The runner's own tool-call decision for a CLI that has no permission hook of its own (the
 * Antigravity CLI, PM-319): every call arrives through the pre-tool hook as a normalized call, and
 * this pure function answers allow, deny or ask (the inbox) from the provider-neutral session
 * policy (PM-127). The rows of the table below are checked in order; the first match decides.
 */

export type ToolCategory = 'read' | 'edit' | 'command' | 'web' | 'browser' | 'team_mcp' | 'mcp' | 'unknown';

export interface NormalizedToolCall {
  category: ToolCategory;
  /** Absolute paths the call reads (read) or changes (edit), already resolved with resolveToolPath. */
  paths: string[];
  /** The shell command line (command). */
  command?: string;
  /**
   * True when the CLI runs this command in its own sandbox that keeps writes inside
   * policy.filesystem.writableRoots and keeps the denied paths unreadable (command).
   */
  sandboxed?: boolean;
  /** Full MCP tool name, e.g. "mcp__team__send_message" (team_mcp, mcp). */
  mcpTool?: string;
  /** Target host (web, browser). */
  host?: string;
}

export type ToolDenyReason =
  'denied_path' | 'denied_operation' | 'denied_host' | 'plan_mode' | 'read_only_placement' | 'not_granted';

export type ToolDecision =
  { decision: 'allow' } | { decision: 'ask' } | { decision: 'deny'; reason: ToolDenyReason };

export interface ToolDecisionOptions {
  /** Temporary agy exception (PM-326, owner T4); remove with PM-361 sandbox support. */
  shellRulesOutsideSandbox?: boolean;
  /** The user's home directory, for `~` and `$HOME`; defaults to the process user's. */
  home?: string;
  /**
   * Whether the filesystem treats `~/.SSH` and `~/.ssh` as one place (macOS, Windows); the denied
   * paths are then compared without regard to case. Defaults to the platform's.
   */
  caseInsensitive?: boolean;
}

const CASE_INSENSITIVE_FILESYSTEM = process.platform === 'darwin' || process.platform === 'win32';

const ALLOW: ToolDecision = { decision: 'allow' };
export const TOOL_DENY_MESSAGES: Record<ToolDenyReason, string> = {
  denied_path: 'This call accesses a path the session is forbidden to access.',
  denied_operation: 'This operation is forbidden by the session policy.',
  denied_host: 'This host is forbidden by the session policy.',
  plan_mode: 'This operation is unavailable in plan mode.',
  read_only_placement: 'This session placement permits reading only.',
  not_granted: 'The session policy does not grant this operation.',
};
const ASK: ToolDecision = { decision: 'ask' };
const deny = (reason: ToolDenyReason): ToolDecision => ({ decision: 'deny', reason });

const TEAM_PREFIX = 'mcp__team__';
const SYMLINK_LIMIT = 40;

// ---------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------

/** The real path of an absolute, normalized path; a missing tail is kept as written. */
function physicalPath(absolute: string, depth = 0): string {
  let current = '/';
  const parts = absolute.split('/').filter((part) => part !== '' && part !== '.');
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    // The kernel steps up from where it really is, after it followed the symlinks before the "..".
    if (part === '..') {
      current = dirname(current);
      continue;
    }
    const next = join(current, part);
    let link: string | null = null;
    try {
      const stat = lstatSync(next);
      if (stat.isSymbolicLink()) link = readlinkSync(next);
    } catch {
      // Missing (or unreadable): nothing below it exists; the rest stays as written.
      return join(current, ...parts.slice(i));
    }
    if (link === null) {
      current = next;
    } else if (depth >= SYMLINK_LIMIT) {
      return join(next, ...parts.slice(i + 1));
    } else {
      // A dangling symlink still points somewhere a write would create.
      current = physicalPath(isAbsolute(link) ? link : `${current}/${link}`, depth + 1);
    }
  }
  return current;
}

function expandHome(raw: string, home: string): string {
  if (raw === '~') return home;
  if (raw.startsWith('~/')) return join(home, raw.slice(2));
  return raw;
}

/**
 * Resolves a tool path against the session's cwd the way the kernel opens it: absolute, "~"
 * expanded, symlinks followed component by component, so a ".." after a symlink steps up from
 * the symlink's target; the part that does not exist yet is kept as written ("..", "." taken out).
 */
export function resolveToolPath(cwd: string, raw: string, home: string): string {
  const expanded = expandHome(raw, home);
  return physicalPath(isAbsolute(expanded) ? expanded : `${cwd}/${expanded}`);
}

/**
 * Every place a raw path may mean: where the kernel opens it (`resolveToolPath`), and where it
 * lands when the CLI took the ".." out as text before it opened anything. They differ only for a
 * ".." behind a symlink. Put all of them in `NormalizedToolCall.paths`: a deny follows when any is
 * denied, an allow needs every one inside the roots.
 */
export function toolPathForms(cwd: string, raw: string, home: string): string[] {
  const expanded = expandHome(raw, home);
  const textual = physicalPath(isAbsolute(expanded) ? normalize(expanded) : resolve(cwd, expanded));
  return [...new Set([resolveToolPath(cwd, raw, home), textual])];
}

const hasGlob = (root: string): boolean => /[*?]/.test(root);

/** `*` and `?` of a path pattern as a regular expression, the whole path or a directory above it. */
function globPattern(pattern: string, caseInsensitive: boolean): RegExp {
  const source = pattern
    .replace(/\/+$/, '')
    .split(/([*?])/)
    .map((piece) => (piece === '*' ? '[^/]*' : piece === '?' ? '[^/]' : escapeRegExp(piece)))
    .join('');
  return new RegExp(`^${source}(?:/|$)`, caseInsensitive ? 'i' : '');
}

/** macOS shows the same file under `/System/Volumes/Data/Users/…` and `/Users/…`. */
function withoutFirmlink(path: string): string {
  return path.replace(/^\/System\/Volumes\/Data(?=\/|$)/, '') || '/';
}

function isUnder(rawPath: string, rawRoot: string, caseInsensitive = false): boolean {
  const path = withoutFirmlink(rawPath);
  const root = withoutFirmlink(rawRoot);
  if (hasGlob(root)) return globPattern(root, caseInsensitive).test(path);
  const base = root.length > 1 ? root.replace(/\/+$/, '') : root;
  const [left, right] = caseInsensitive ? [path.toLowerCase(), base.toLowerCase()] : [path, base];
  return left === right || left.startsWith(right === '/' ? '/' : `${right}/`);
}

/** A root as the policy names it and as the filesystem resolves it (a symlinked root). */
function rootForms(cwd: string, roots: readonly string[], home: string): string[] {
  const forms = new Set<string>();
  for (const root of roots) {
    const expanded = expandHome(root, home);
    forms.add(isAbsolute(expanded) ? normalize(expanded) : resolve(cwd, expanded));
    forms.add(resolveToolPath(cwd, root, home));
  }
  return [...forms];
}

const underAny = (path: string, roots: readonly string[], caseInsensitive = false): boolean =>
  roots.some((root) => isUnder(path, root, caseInsensitive));

/** The session folders a session reads without asking (PM-333): the root of this instance's, else its own. */
const sessionFolderRoots = (policy: SessionPolicy): string[] => {
  const { sessionFolder, sessionFoldersRoot } = policy.filesystem;
  return [...(sessionFoldersRoot ? [sessionFoldersRoot] : []), ...(sessionFolder ? [sessionFolder] : [])];
};

// ---------------------------------------------------------------------------------------------
// Shell command lines
// ---------------------------------------------------------------------------------------------

const MAX_NESTING = 8;

interface ShellUnit {
  words: string[];
  depth: number;
}

interface ParsedCommand {
  units: ShellUnit[];
  /** Files named by a redirection (`> file`, `< file`). */
  redirects: string[];
  /** Nesting went deeper than the scan follows: the line is not trusted. */
  overflow: boolean;
  /** A shell that reads its script from the input (`… | sh`, `sh <<< '…'`): not seen by the scan. */
  stdinShell: boolean;
}

/** The index of the parenthesis that closes the one before `start`, quotes and nesting aware. */
function matchParen(line: string, start: number): number {
  let level = 1;
  for (let i = start; i < line.length; i += 1) {
    const c = line.charAt(i);
    if (c === '\\') i += 1;
    else if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) return line.length;
      i = end;
    } else if (c === '"') {
      i += 1;
      while (i < line.length && line.charAt(i) !== '"') i += line.charAt(i) === '\\' ? 2 : 1;
    } else if (c === '(') level += 1;
    else if (c === ')') {
      level -= 1;
      if (level === 0) return i;
    }
  }
  return line.length;
}

/** The index of the backtick that closes the one before `start`. */
function matchBacktick(line: string, start: number): number {
  for (let i = start; i < line.length; i += 1) {
    const c = line.charAt(i);
    if (c === '\\') i += 1;
    else if (c === '`') return i;
  }
  return line.length;
}

/** Stands in a word for what a substitution (`$( )`, backticks) will put there. */
const DYNAMIC = '\u0000';
/** A word whose value the line does not say: a variable, a substitution or an empty word. */
const isDynamic = (word: string): boolean => word === '' || word.includes('$') || word.includes(DYNAMIC);

/**
 * Splits a shell line into simple commands (words with the quotes and escapes taken off), and
 * adds the commands inside `$( )`, backticks and `<( )` as commands of their own; `sh -c`, `eval`
 * and a shell that reads its script from the input are followed afterwards (`expandNested`).
 *
 * It leans to deny, not to allow: a word that is a variable or a substitution where a git or gh
 * subcommand belongs counts as the denied one. What it cannot follow, and leaves to the CLI's own
 * sandbox: a pattern that names an ancestor of a denied path (`ls ~/*`) or goes through a symlink,
 * a script file (`bash run.sh`), another interpreter (`python -c`, `node -e`), a variable
 * assigned in one place and run in another when the line never spells the denied words, and
 * `git` aliases or `gh` extensions set outside the line. A pull request made by `gh api graphql
 * --input file` or by `curl` against the pulls endpoint is also beyond a line scan: the sandbox's
 * network deny is what stops it.
 */
function parseShell(line: string, state: ParsedCommand, depth: number): void {
  if (depth > MAX_NESTING) {
    state.overflow = true;
    return;
  }
  let words: string[] = [];
  let word = '';
  let inWord = false;
  let redirectTarget = false;

  const endWord = (): void => {
    if (inWord) {
      if (redirectTarget) state.redirects.push(word);
      else words.push(word);
      redirectTarget = false;
    }
    word = '';
    inWord = false;
  };
  const endCommand = (): void => {
    endWord();
    redirectTarget = false;
    if (words.length > 0) state.units.push({ words, depth });
    words = [];
  };
  const substitution = (inner: string): void => {
    parseShell(inner, state, depth + 1);
    word += DYNAMIC;
    inWord = true;
  };

  for (let i = 0; i < line.length; i += 1) {
    const c = line.charAt(i);
    const next = line.charAt(i + 1);
    if (c === '\\') {
      if (next !== '\n') {
        word += next;
        inWord = true;
      }
      i += 1;
    } else if (c === "'") {
      const end = line.indexOf("'", i + 1);
      const stop = end < 0 ? line.length : end;
      word += line.slice(i + 1, stop);
      inWord = true;
      i = stop;
    } else if (c === '"') {
      inWord = true;
      i += 1;
      while (i < line.length && line.charAt(i) !== '"') {
        const d = line.charAt(i);
        if (d === '\\') {
          word += line.charAt(i + 1);
          i += 2;
        } else if (d === '$' && line.charAt(i + 1) === '(') {
          const end = matchParen(line, i + 2);
          substitution(line.slice(i + 2, end));
          i = end + 1;
        } else if (d === '`') {
          const end = matchBacktick(line, i + 1);
          substitution(line.slice(i + 1, end));
          i = end + 1;
        } else {
          word += d;
          i += 1;
        }
      }
    } else if ((c === '$' || c === '<' || c === '>') && next === '(') {
      const end = matchParen(line, i + 2);
      substitution(line.slice(i + 2, end));
      i = end;
    } else if (c === '`') {
      const end = matchBacktick(line, i + 1);
      substitution(line.slice(i + 1, end));
      i = end;
    } else if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
    } else if (c === ';' || c === '&' || c === '|' || c === '\n' || c === '(' || c === ')') {
      endCommand();
    } else if (c === '<' || c === '>') {
      endWord();
      while (/[<>&|]/.test(line.charAt(i + 1))) i += 1;
      redirectTarget = true;
    } else {
      word += c;
      inWord = true;
    }
  }
  endCommand();
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
const GIT_VALUE_OPTIONS = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
  '--config-env',
  '--attr-source',
]);
const GH_VALUE_OPTIONS = new Set(['-R', '--repo', '--hostname', '-H']);

const SHELL_VALUE_OPTIONS = new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file']);
const WRAPPERS = new Set([
  'env',
  'command',
  'exec',
  'sudo',
  'doas',
  'nohup',
  'nice',
  'time',
  'xargs',
  'builtin',
  'setsid',
  'stdbuf',
]);

/** Whether every word before `index` only prepares the command at `index` (a wrapper, its options). */
function atCommandPosition(words: string[], index: number): boolean {
  return words
    .slice(0, index)
    .every(
      (word) =>
        WRAPPERS.has(basename(word)) ||
        word.startsWith('-') ||
        /^[A-Za-z_]\w*=/.test(word) ||
        /^\d+$/.test(word),
    );
}

/**
 * Follows `sh -c '…'` and `eval …` into the script they run, as commands of their own, and notes
 * a shell that takes its script from the input instead: the scan cannot see that script.
 */
function expandNested(state: ParsedCommand): void {
  for (let index = 0; index < state.units.length; index += 1) {
    const { words, depth } = state.units[index]!;
    for (let i = 0; i < words.length; i += 1) {
      const name = basename(words[i]!);
      if (name === 'eval') {
        parseShell(words.slice(i + 1).join(' '), state, depth + 1);
      } else if (SHELLS.has(name)) {
        let readsInput = true;
        for (let j = i + 1; j < words.length; j += 1) {
          const arg = words[j]!;
          if (arg === '-') break;
          if (!arg.startsWith('-')) {
            readsInput = false;
            break;
          }
          if (SHELL_VALUE_OPTIONS.has(arg)) {
            j += 1;
          } else if (!arg.startsWith('--') && arg.includes('c')) {
            parseShell(words[j + 1] ?? '', state, depth + 1);
            readsInput = false;
            break;
          }
        }
        if (readsInput && atCommandPosition(words, i)) state.stdinShell = true;
      }
    }
  }
}

const GIT_PUSH_SUBCOMMANDS = new Set(['push', 'send-pack']);

/** Whether `args` (after `git`) push: the subcommand after the global options, or an alias for it. */
function gitPushes(args: string[], aliasedByEnvironment = false): boolean {
  // An alias set on the command line or in the environment may stand for `push`; its value
  // can come from a variable, so any such alias counts.
  let aliasedPush = aliasedByEnvironment;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (!arg.startsWith('-')) {
      if (isDynamic(arg) || GIT_PUSH_SUBCOMMANDS.has(arg)) return true;
      if (arg === 'subtree') {
        const action = args.slice(i + 1).find((word) => !word.startsWith('-'));
        if (action !== undefined && (action === 'push' || isDynamic(action))) return true;
      }
      return aliasedPush;
    }
    if (arg === '-c' && /^alias\.[^=]*=.*\bpush\b/.test(args[i + 1] ?? '')) aliasedPush = true;
    if (arg === '--config-env' && /^alias\./.test(args[i + 1] ?? '')) aliasedPush = true;
    if (/^--config-env=alias\./.test(arg)) aliasedPush = true;
    if (GIT_VALUE_OPTIONS.has(arg)) i += 1;
  }
  return aliasedPush;
}

/** The first two words of a gh command (`pr create`), with the options left out. */
function ghSubcommands(args: string[]): string[] {
  const found: string[] = [];
  for (let i = 0; i < args.length && found.length < 2; i += 1) {
    const arg = args[i]!;
    if (!arg.startsWith('-')) found.push(arg);
    else if (GH_VALUE_OPTIONS.has(arg)) i += 1;
  }
  return found;
}

/** What `gh api …` does to pull requests: a write to the pulls endpoint, or the GraphQL mutation. */
function ghApiOperations(args: string[]): DeniedSessionOperation[] {
  let method: string | undefined;
  let fields = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '-X' || arg === '--method') method = args[i + 1];
    else if (arg.startsWith('--method=')) method = arg.slice('--method='.length);
    else if (/^-X./.test(arg)) method = arg.slice(2);
    else if (/^(-[fF]|--(raw-)?field|--input)/.test(arg)) fields = true;
  }
  // A field makes the request a POST unless the method is named.
  const writes = method === undefined ? fields : /^(post|put|patch)$/i.test(method) || isDynamic(method);
  const found = new Set<DeniedSessionOperation>();
  for (const arg of args) {
    if (/createPullRequest/.test(arg)) found.add('pull_request_create');
    if (/mergePullRequest|enablePullRequestAutoMerge/.test(arg)) found.add('pull_request_merge');
    if (writes && /(^|\/)pulls(\/|\?|$)/.test(arg)) {
      found.add(/\/merge(\?|$)/.test(arg) ? 'pull_request_merge' : 'pull_request_create');
    }
    if (writes && isDynamic(arg)) {
      found.add('pull_request_create');
      found.add('pull_request_merge');
    }
  }
  return [...found];
}

function unitOperations(words: string[]): Set<DeniedSessionOperation> {
  const found = new Set<DeniedSessionOperation>();
  // Every word may start the command a wrapper runs (`env A=1 git push`, `xargs git push`).
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]!;
    const name = basename(word);
    const rest = words.slice(i + 1);
    if (name === 'git') {
      const environmentAlias = words
        .slice(0, i)
        .some((before) => /^GIT_CONFIG_(KEY_\d+|PARAMETERS)=.*alias\./.test(before));
      if (gitPushes(rest, environmentAlias)) found.add('git_push');
    } else if (name === 'gh') {
      const [group, action] = ghSubcommands(rest);
      if (group === 'api') {
        for (const operation of ghApiOperations(rest)) found.add(operation);
      } else if (group === 'pr' || (group !== undefined && isDynamic(group))) {
        const unknown = action !== undefined && isDynamic(action);
        if (action === 'create' || unknown) found.add('pull_request_create');
        if (action === 'merge' || unknown) found.add('pull_request_merge');
      }
    } else if (isDynamic(word)) {
      // A variable in the command's place (`$GIT push`) may be git or gh.
      if (rest.includes('push')) found.add('git_push');
      if (rest.includes('pr') && rest.includes('create')) found.add('pull_request_create');
      if (rest.includes('pr') && rest.includes('merge')) found.add('pull_request_merge');
    }
  }
  return found;
}

function parseCommand(line: string): ParsedCommand {
  const state: ParsedCommand = { units: [], redirects: [], overflow: false, stdinShell: false };
  parseShell(line, state, 0);
  expandNested(state);
  return state;
}

/** Whether the line runs something the policy denies (publishing operations), disguised or not. */
function runsDeniedOperation(policy: SessionPolicy, parsed: ParsedCommand): boolean {
  if (policy.deniedOperations.length === 0) return false;
  if (parsed.overflow || parsed.stdinShell) return true;
  return parsed.units.some(({ words }) =>
    [...unitOperations(words)].some((operation) => policy.deniedOperations.includes(operation)),
  );
}

/** Characters that make a line more than one plain command. */
const SHELL_METACHARACTERS = /[;&|<>$`(){}\\\n\r]/;

/**
 * Whether the shell would turn a word of the line into other words or paths: a pattern (`*`, `?`,
 * `[`) or a tilde at the start of a word (`~`, `~user`, after `=` or `:` too), unquoted. A rule
 * names the command as written, so such a line is not the command the rule names (`git diff
 * ~/.ss?/id`); a tilde inside a word (`HEAD~1`) is only a character.
 */
function expandsByItself(line: string): boolean {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line.charAt(i);
    if (quote !== null) {
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === '*' || c === '?' || c === '[') {
      return true;
    } else if (c === '~' && (i === 0 || /[\s=:]/.test(line.charAt(i - 1)))) {
      return true;
    }
  }
  return false;
}

function matchesShellRule(policy: SessionPolicy, line: string): boolean {
  if (SHELL_METACHARACTERS.test(line) || expandsByItself(line)) return false;
  const command = line.trim().replace(/\s+/g, ' ');
  return policy.tools.shell.some((rule) =>
    rule.arguments === 'exact'
      ? command === rule.command
      : command === rule.command || command.startsWith(`${rule.command} `),
  );
}

// ---------------------------------------------------------------------------------------------
// Denied paths in a command line
// ---------------------------------------------------------------------------------------------

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The spellings of a denied path a line may carry: absolute, `~/…` and `$HOME/…`. */
function deniedSpellings(denied: string, home: string): string[] {
  const spellings = [denied];
  if (isUnder(denied, home) && denied !== home) {
    const rest = denied.slice(home.length);
    spellings.push(`~${rest}`, `$HOME${rest}`, `\${HOME}${rest}`);
  }
  return spellings;
}

/** A spelling as a regular expression: `*` and `?` of a pattern stand for the characters of a name. */
function spellingPattern(spelling: string, caseInsensitive: boolean): RegExp {
  const name = '[\\w.@+-]';
  const source = spelling
    .split(/([*?])/)
    .map((piece) => (piece === '*' ? `${name}*` : piece === '?' ? name : escapeRegExp(piece)))
    .join('');
  return new RegExp(`${source}(?!${name})`, caseInsensitive ? 'i' : '');
}

const MAX_BASES = 16;

/** The path words of a command: the word itself and the parts an option or a list joins. */
function pathCandidates(word: string, home: string): string[] {
  return [...new Set([word, ...word.split(/[=:,]/)])]
    .filter((part) => part !== '')
    .map((part) =>
      part
        .replace(/^\$\{?HOME\}?(?=\/|$)/, home)
        // `~name` is another user's home: a sibling of ours, where homes live (`/Users`, `/home`).
        .replace(/^~(?=[^/+-])([^/]*)/, (_all, name: string) => join(dirname(home), name))
        .replace(/^~\+(?=\/|$)/, '.'),
    );
}

const GLOB_CHARACTERS = /[*?[]/;

/** A name pattern (`*`, `?`, `[a-z]`) as a regular expression over one path component. */
function componentPattern(pattern: string, caseInsensitive: boolean): RegExp | null {
  const source = pattern
    .split(/(\[[^\]]*\]|[*?])/)
    .map((piece) => {
      if (piece === '*') return '[^/]*';
      if (piece === '?') return '[^/]';
      if (piece.startsWith('[') && piece.endsWith(']') && piece.length > 2) {
        return piece.replace(/^\[!/, '[^').replace(/\\/g, '\\\\');
      }
      return escapeRegExp(piece);
    })
    .join('');
  try {
    return new RegExp(`^${source}$`, caseInsensitive ? 'i' : '');
  } catch {
    return null;
  }
}

/** Whether one component of a pattern word may be the component of a denied path. */
function componentMayMatch(word: string, denied: string, caseInsensitive: boolean): boolean {
  const wordIsPattern = GLOB_CHARACTERS.test(word);
  if (!wordIsPattern && !hasGlob(denied)) {
    return caseInsensitive ? word.toLowerCase() === denied.toLowerCase() : word === denied;
  }
  if (wordIsPattern && hasGlob(denied)) return true;
  if (wordIsPattern) return componentPattern(word, caseInsensitive)?.test(denied) ?? true;
  return componentPattern(denied, caseInsensitive)?.test(word) ?? true;
}

/**
 * Whether a word with a pattern in it (`~/.ss?/id`, `~/.s*`) may name a denied path or something
 * below it: every component of the denied path matches the word's component at its place.
 */
function patternMayReach(word: string, denied: string, caseInsensitive: boolean): boolean {
  const wordParts = word.split('/').filter((part) => part !== '');
  const deniedParts = denied.split('/').filter((part) => part !== '');
  return (
    wordParts.length >= deniedParts.length &&
    deniedParts.every((part, i) => componentMayMatch(wordParts[i]!, part, caseInsensitive))
  );
}

const isPathLike = (candidate: string): boolean =>
  candidate.includes('/') || candidate.startsWith('~') || candidate.startsWith('.');

function commandTouchesDenied(
  cwd: string,
  home: string,
  denied: string[],
  line: string,
  parsed: ParsedCommand,
  caseInsensitive: boolean,
): boolean {
  // The line's own text first: it also holds paths inside a quoted script the parse does not open.
  for (const root of denied) {
    for (const spelling of deniedSpellings(root, home)) {
      if (spellingPattern(spelling, caseInsensitive).test(line)) return true;
    }
  }
  // A `cd` moves the relative words after it; where the line really stands is not known, so a
  // relative word is read from the working directory and from every directory a `cd` named.
  const bases = [cwd];
  const touches = (word: string): boolean =>
    pathCandidates(word, home).some((candidate) =>
      bases.some((base) => {
        if (GLOB_CHARACTERS.test(candidate)) {
          // The shell has not expanded the pattern yet: could it name a denied path?
          const expanded = expandHome(candidate, home);
          const lexical = isAbsolute(expanded) ? normalize(expanded) : resolve(base, expanded);
          return denied.some((root) => patternMayReach(lexical, root, caseInsensitive));
        }
        return (
          isPathLike(candidate) ? toolPathForms(base, candidate, home) : [resolve(base, candidate)]
        ).some((path) => underAny(path, denied, caseInsensitive));
      }),
    );
  for (const { words } of parsed.units) {
    if (words.some(touches)) return true;
    if (basename(words[0]!) === 'cd' || basename(words[0]!) === 'pushd') {
      const target = words.slice(1).find((word) => !word.startsWith('-')) ?? '~';
      for (const base of [...bases]) {
        for (const candidate of pathCandidates(target, home).slice(0, 1)) {
          for (const form of toolPathForms(base, candidate, home)) {
            if (!bases.includes(form) && bases.length < MAX_BASES) bases.push(form);
          }
        }
      }
    }
  }
  return parsed.redirects.some(touches);
}

// ---------------------------------------------------------------------------------------------
// Hosts
// ---------------------------------------------------------------------------------------------

function normalizeHost(host: string): string {
  const text = host.trim().toLowerCase();
  const bracketed = /^\[([^\]]*)\](?::\d+)?$/.exec(text);
  // A port follows a name or an IPv4 address after its only colon; an IPv6 address has several.
  const bare = bracketed ? (bracketed[1] ?? '') : text.replace(/^([^:]*):\d+$/, '$1');
  return bare.replace(/\.$/, '');
}

// One part of an IPv4 address in the forms a resolver accepts: decimal, 0x hex or leading-0 octal.
function ipv4Part(part: string): number | undefined {
  if (/^0x[0-9a-f]+$/.test(part)) return Number.parseInt(part.slice(2), 16);
  if (/^0[0-7]+$/.test(part)) return Number.parseInt(part, 8);
  if (/^\d+$/.test(part)) return Number.parseInt(part, 10);
  return undefined;
}

// `127.1`, `2130706433`, `0x7f.1` and `0177.0.0.1` all reach 127.0.0.1: the last part fills the
// bytes the address leaves out.
function ipv4Value(host: string): number | undefined {
  const parts = host.split('.');
  if (parts.length > 4) return undefined;
  const numbers = parts.map(ipv4Part);
  if (numbers.some((n) => n === undefined)) return undefined;
  const values = numbers as number[];
  const last = values[values.length - 1] ?? 0;
  const head = values.slice(0, -1);
  if (head.some((n) => n > 255) || last >= 256 ** (4 - head.length)) return undefined;
  return head.reduce((sum, n, i) => sum + n * 256 ** (3 - i), 0) + last;
}

function isLoopbackHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::' || /^(?:0{1,4}(?::0{1,4})*)?::(?:0{1,4}:)*0{0,3}[01]$/.test(host)) return true;
  if (/^(?:0{1,4}:){7}0{0,3}[01]$/.test(host)) return true;
  // An IPv4 address inside IPv6: `::ffff:127.0.0.1` or `::ffff:7f00:1`.
  const mapped = /^(?:(?:0{1,4}:)+:?|::)ffff:(.+)$/.exec(host);
  if (mapped !== null) {
    const rest = mapped[1] ?? '';
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
    if (hex !== null) {
      const value = Number.parseInt(hex[1] ?? '0', 16) * 65536 + Number.parseInt(hex[2] ?? '0', 16);
      return value === 0 || value >>> 24 === 127;
    }
    return isLoopbackHost(rest);
  }
  const value = ipv4Value(host);
  return value !== undefined && (value === 0 || value >>> 24 === 127);
}

function hostIsDenied(policy: SessionPolicy, rawHost: string | undefined): boolean {
  if (rawHost === undefined) return false;
  const host = normalizeHost(rawHost);
  return (policy.network.deniedHosts ?? []).some((entry) => {
    const denied = normalizeHost(entry);
    if (host === denied || host.endsWith(`.${denied}`)) return true;
    // Every spelling of the machine itself is denied with the one the policy names.
    return isLoopbackHost(denied) && isLoopbackHost(host);
  });
}

function hostIsAllowed(policy: SessionPolicy, rawHost: string | undefined): boolean {
  if (rawHost === undefined) return false;
  const host = normalizeHost(rawHost);
  return policy.network.allowedDomains.some((entry) => {
    const allowed = normalizeHost(entry);
    return allowed.startsWith('*.') ? host.endsWith(allowed.slice(1)) : host === allowed;
  });
}

// ---------------------------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------------------------

export function decideToolCall(
  policy: SessionPolicy,
  call: NormalizedToolCall,
  options: ToolDecisionOptions = {},
): ToolDecision {
  const home = options.home ?? homedir();
  const cwd = policy.placement.path;
  const mode = policy.permissions.claude;
  const caseInsensitive = options.caseInsensitive ?? CASE_INSENSITIVE_FILESYSTEM;
  // Each path in every place it may mean (see `toolPathForms`): a deny needs one, an allow all.
  const paths = call.paths.flatMap((path) => toolPathForms(cwd, path, home));

  // 1. A denied path, in every mode.
  const denied = rootForms(cwd, policy.filesystem.deniedPaths ?? [], home);
  if (paths.some((path) => underAny(path, denied, caseInsensitive))) return deny('denied_path');
  const parsed = call.category === 'command' ? parseCommand(call.command ?? '') : null;
  if (
    parsed &&
    denied.length > 0 &&
    commandTouchesDenied(cwd, home, denied, call.command ?? '', parsed, caseInsensitive)
  ) {
    return deny('denied_path');
  }

  // 2. A denied operation, however the command line hides it.
  if (parsed && runsDeniedOperation(policy, parsed)) return deny('denied_operation');

  // 3. A denied host.
  if ((call.category === 'web' || call.category === 'browser') && hostIsDenied(policy, call.host)) {
    return deny('denied_host');
  }

  switch (call.category) {
    case 'read': {
      // 4. Reading inside the session's own roots is free; anything else is asked.
      const readable = rootForms(
        cwd,
        [
          ...policy.filesystem.readableRoots,
          ...policy.filesystem.writableRoots,
          ...(policy.filesystem.readOnlyPaths ?? []),
          // Every member's session folder of this instance (PM-333), the session's own included.
          ...sessionFolderRoots(policy),
        ],
        home,
      );
      return paths.length > 0 && paths.every((path) => underAny(path, readable)) ? ALLOW : ASK;
    }
    case 'team_mcp': {
      // 5. The team tools the role is granted.
      const name = (call.mcpTool ?? '').startsWith(TEAM_PREFIX)
        ? (call.mcpTool ?? '').slice(TEAM_PREFIX.length)
        : null;
      if (name === null) return deny('not_granted');
      const granted =
        policy.tools.team.all ||
        policy.tools.team.names.some((entry) => entry === name || entry === call.mcpTool);
      return granted ? ALLOW : deny('not_granted');
    }
    case 'edit': {
      // 6. Changing files.
      if (mode === 'plan') return deny('plan_mode');
      // The session's own folder (PM-268): written without asking, a reader's too, in any mode but plan.
      const ownFolder = rootForms(
        cwd,
        policy.filesystem.sessionFolder ? [policy.filesystem.sessionFolder] : [],
        home,
      );
      if (paths.length > 0 && paths.every((path) => underAny(path, ownFolder, caseInsensitive))) return ALLOW;
      const readOnly = rootForms(cwd, policy.filesystem.readOnlyPaths ?? [], home);
      const reading = placementReadsOnly(policy.access, {
        mode: policy.reviewCopyMode,
        enforcement: policy.enforcement,
      });
      if (reading || paths.some((path) => underAny(path, readOnly, caseInsensitive))) {
        return deny('read_only_placement');
      }
      const writable = rootForms(cwd, policy.filesystem.writableRoots, home);
      const protectedRoots = rootForms(cwd, policy.filesystem.protectedPaths, home);
      const free =
        paths.length > 0 &&
        paths.every((path) => underAny(path, writable) && !underAny(path, protectedRoots, caseInsensitive));
      return free && (mode === 'acceptEdits' || mode === 'auto') ? ALLOW : ASK;
    }
    case 'command': {
      // 7. Shell commands.
      // A rule only vouches for a command the sandbox contains: outside it, the rule's own
      // options (`--output=`, `--write`) can still reach anything, so the command falls through.
      if (
        (call.sandboxed === true || options.shellRulesOutsideSandbox === true) &&
        matchesShellRule(policy, call.command ?? '')
      )
        return ALLOW;
      if (mode === 'plan') return deny('plan_mode');
      if (mode === 'auto' && call.sandboxed === true) return ALLOW;
      if (call.sandboxed !== true && policy.outsideSandbox === 'deny') return deny('not_granted');
      return ASK;
    }
    case 'web':
    case 'browser':
      // 8. Hosts the policy allows.
      return hostIsAllowed(policy, call.host) ? ALLOW : ASK;
    default:
      // 9. Other MCP tools, and whatever is not known.
      return ASK;
  }
}
