import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
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
  /** The user's home directory, for `~` and `$HOME`; defaults to the process user's. */
  home?: string;
}

const ALLOW: ToolDecision = { decision: 'allow' };
const ASK: ToolDecision = { decision: 'ask' };
const deny = (reason: ToolDenyReason): ToolDecision => ({ decision: 'deny', reason });

const TEAM_PREFIX = 'mcp__team__';
const SYMLINK_LIMIT = 40;

// ---------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------

/** The real path of an absolute, normalized path; a missing tail is kept as written. */
function realPathOf(path: string, depth = 0): string {
  const tail: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(realpathSync(current), ...tail.reverse());
    } catch {
      // Missing (or unreadable): a dangling symlink still points somewhere a write would create.
      try {
        if (depth < SYMLINK_LIMIT && lstatSync(current).isSymbolicLink()) {
          const target = resolve(dirname(current), readlinkSync(current));
          return join(realPathOf(target, depth + 1), ...tail.reverse());
        }
      } catch {
        // Not there at all: look at its parent.
      }
      const parent = dirname(current);
      if (parent === current) return join(current, ...tail.reverse());
      tail.push(basename(current));
      current = parent;
    }
  }
}

function expandHome(raw: string, home: string): string {
  if (raw === '~') return home;
  if (raw.startsWith('~/')) return join(home, raw.slice(2));
  return raw;
}

/**
 * Resolves a tool path against the session's cwd: absolute, normalized ("..", "~"), with the
 * realpath of its deepest existing ancestor (symlinks).
 */
export function resolveToolPath(cwd: string, raw: string, home: string): string {
  const expanded = expandHome(raw, home);
  const absolute = isAbsolute(expanded) ? normalize(expanded) : resolve(cwd, expanded);
  return realPathOf(absolute);
}

function isUnder(path: string, root: string): boolean {
  const base = root.length > 1 ? root.replace(/\/+$/, '') : root;
  return path === base || path.startsWith(base === '/' ? '/' : `${base}/`);
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

const underAny = (path: string, roots: readonly string[]): boolean =>
  roots.some((root) => isUnder(path, root));

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

/**
 * Splits a shell line into simple commands (words with the quotes and escapes taken off), and
 * adds the commands inside `$( )`, backticks and `<( )` as commands of their own. It over-reads
 * rather than under-reads: a line it cannot follow is never taken for harmless.
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

/** Follows `sh -c '…'` and `eval …` into the script they run, as commands of their own. */
function expandNested(state: ParsedCommand): void {
  for (let index = 0; index < state.units.length; index += 1) {
    const { words, depth } = state.units[index]!;
    for (let i = 0; i < words.length; i += 1) {
      const name = basename(words[i]!);
      if (name === 'eval') {
        parseShell(words.slice(i + 1).join(' '), state, depth + 1);
      } else if (SHELLS.has(name)) {
        for (let j = i + 1; j < words.length; j += 1) {
          const arg = words[j]!;
          if (!arg.startsWith('-')) break;
          if (!arg.startsWith('--') && arg.includes('c')) {
            parseShell(words[j + 1] ?? '', state, depth + 1);
            break;
          }
        }
      }
    }
  }
}

/** Which git subcommand `args` (after `git`) run, with the global options left out. */
function gitSubcommand(args: string[]): { subcommand: string | null; aliasedPush: boolean } {
  let aliasedPush = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (!arg.startsWith('-')) return { subcommand: arg, aliasedPush };
    if (arg === '-c' && /^alias\.[^=]*=.*\bpush\b/.test(args[i + 1] ?? '')) aliasedPush = true;
    if (GIT_VALUE_OPTIONS.has(arg)) i += 1;
  }
  return { subcommand: null, aliasedPush };
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

function unitOperations(words: string[]): Set<DeniedSessionOperation> {
  const found = new Set<DeniedSessionOperation>();
  // Every word may start the command a wrapper runs (`env A=1 git push`, `xargs git push`).
  for (let i = 0; i < words.length; i += 1) {
    const name = basename(words[i]!);
    const rest = words.slice(i + 1);
    if (name === 'git') {
      const { subcommand, aliasedPush } = gitSubcommand(rest);
      if (subcommand === 'push' || aliasedPush) found.add('git_push');
    } else if (name === 'gh') {
      const [group, action] = ghSubcommands(rest);
      if (group === 'pr' && action === 'create') found.add('pull_request_create');
      if (group === 'pr' && action === 'merge') found.add('pull_request_merge');
    }
  }
  return found;
}

function parseCommand(line: string): ParsedCommand {
  const state: ParsedCommand = { units: [], redirects: [], overflow: false };
  parseShell(line, state, 0);
  expandNested(state);
  return state;
}

/** Whether the line runs something the policy denies (publishing operations), disguised or not. */
function runsDeniedOperation(policy: SessionPolicy, parsed: ParsedCommand): boolean {
  if (policy.deniedOperations.length === 0) return false;
  if (parsed.overflow) return true;
  return parsed.units.some(({ words }) =>
    [...unitOperations(words)].some((operation) => policy.deniedOperations.includes(operation)),
  );
}

/** Characters that make a line more than one plain command. */
const SHELL_METACHARACTERS = /[;&|<>$`(){}\\\n\r]/;

function matchesShellRule(policy: SessionPolicy, line: string): boolean {
  if (SHELL_METACHARACTERS.test(line)) return false;
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

function commandTouchesDenied(
  policy: SessionPolicy,
  cwd: string,
  home: string,
  denied: string[],
  line: string,
  parsed: ParsedCommand,
): boolean {
  // The line's own text first: it also holds paths inside a quoted script the parse does not open.
  for (const root of denied) {
    for (const spelling of deniedSpellings(root, home)) {
      if (new RegExp(`${escapeRegExp(spelling)}(?![\\w.@+-])`).test(line)) return true;
    }
  }
  const words = [...parsed.units.flatMap((unit) => unit.words), ...parsed.redirects];
  for (const word of words) {
    for (const part of new Set([word, ...word.split(/[=:,]/)])) {
      if (part === '') continue;
      const candidate = part.replace(/^\$\{?HOME\}?(?=\/|$)/, home);
      const pathLike = candidate.includes('/') || candidate.startsWith('~') || candidate.startsWith('.');
      const path = pathLike ? resolveToolPath(cwd, candidate, home) : resolve(cwd, candidate);
      if (underAny(path, denied)) return true;
    }
  }
  return false;
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

function isLoopbackHost(host: string): boolean {
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    host === '::' ||
    host === '0.0.0.0' ||
    /^127(\.\d{1,3}){3}$/.test(host)
  );
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
  const paths = call.paths.map((path) => resolveToolPath(cwd, path, home));

  // 1. A denied path, in every mode.
  const denied = rootForms(cwd, policy.filesystem.deniedPaths ?? [], home);
  if (paths.some((path) => underAny(path, denied))) return deny('denied_path');
  const parsed = call.category === 'command' ? parseCommand(call.command ?? '') : null;
  if (
    parsed &&
    denied.length > 0 &&
    commandTouchesDenied(policy, cwd, home, denied, call.command ?? '', parsed)
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
      const readOnly = rootForms(cwd, policy.filesystem.readOnlyPaths ?? [], home);
      const reading = placementReadsOnly(policy.access, {
        mode: policy.reviewCopyMode,
        enforcement: policy.enforcement,
      });
      if (reading || paths.some((path) => underAny(path, readOnly))) return deny('read_only_placement');
      const writable = rootForms(cwd, policy.filesystem.writableRoots, home);
      const protectedRoots = rootForms(cwd, policy.filesystem.protectedPaths, home);
      const free =
        paths.length > 0 &&
        paths.every((path) => underAny(path, writable) && !underAny(path, protectedRoots));
      return free && (mode === 'acceptEdits' || mode === 'auto') ? ALLOW : ASK;
    }
    case 'command': {
      // 7. Shell commands.
      if (matchesShellRule(policy, call.command ?? '')) return ALLOW;
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
