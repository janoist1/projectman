import type { DeniedSessionOperation } from './session-policy';

/**
 * The one rule for "this shell line publishes" (`git push`, `gh pr create`, `gh pr merge`), used by
 * the hub's automatic command verdicts and by the runner's own tool decision (PM-1367). It scans
 * the line as the shell splits it, so global options, quoting, wrappers and aliases do not hide
 * the operation.
 */

const MAX_NESTING = 8;
/**
 * How many characters one scan reads in all, the nested readings (`eval`, `sh -c`, substitutions,
 * here-documents) included. Each `eval` reads the rest of its command again, so without a budget a
 * short line could cost combinatorial work; past it the line is not trusted.
 */
const MAX_SCAN_CHARACTERS = 256 * 1024;
/** How many words after a command name the scan reads; a longer command counts where it decides. */
const MAX_COMMAND_WORDS = 128;

interface ScanBudget {
  left: number;
}

interface ShellUnit {
  words: string[];
  depth: number;
}

export interface ShellLineScan {
  units: ShellUnit[];
  /** Files named by a redirection (`> file`, `< file`). */
  redirects: string[];
  /** Nesting went deeper, or the line further, than the scan follows: the line is not trusted. */
  overflow: boolean;
  /** A shell that reads its script from the input (`… | sh`, `sh <<< '…'`): not seen by the scan. */
  stdinShell: boolean;
}

interface Heredoc {
  delimiter: string;
  /** `<<-`: the delimiter line may start with tabs. */
  strip: boolean;
}

/** The here-document operator at `start` (`<<`, `<<-`, not `<<<`) and where its delimiter ends. */
function heredocAt(line: string, start: number): { heredoc: Heredoc; end: number } | null {
  if (!line.startsWith('<<', start) || line.charAt(start + 2) === '<') return null;
  let i = start + 2;
  const strip = line.charAt(i) === '-';
  if (strip) i += 1;
  while (line.charAt(i) === ' ' || line.charAt(i) === '\t') i += 1;
  let delimiter = '';
  for (; i < line.length; i += 1) {
    const c = line.charAt(i);
    if (c === "'" || c === '"') {
      const close = line.indexOf(c, i + 1);
      const stop = close < 0 ? line.length : close;
      delimiter += line.slice(i + 1, stop);
      i = stop;
    } else if (c === '\\') {
      delimiter += line.charAt(i + 1);
      i += 1;
    } else if (/[\s;&|<>()]/.test(c)) {
      break;
    } else {
      delimiter += c;
    }
  }
  return delimiter === '' ? null : { heredoc: { delimiter, strip }, end: i };
}

/**
 * The body of `heredoc`, which starts after the newline at `newline`, and the index of the newline
 * that ends its delimiter line (the line's end when the delimiter never comes).
 */
function heredocBody(line: string, newline: number, heredoc: Heredoc): { body: string; end: number } {
  for (let start = newline + 1; start < line.length;) {
    const found = line.indexOf('\n', start);
    const stop = found < 0 ? line.length : found;
    const text = line.slice(start, stop);
    if ((heredoc.strip ? text.replace(/^\t+/, '') : text) === heredoc.delimiter) {
      return { body: line.slice(newline + 1, start), end: stop };
    }
    start = stop + 1;
  }
  return { body: line.slice(newline + 1), end: line.length };
}

/** The index of the parenthesis that closes the one before `start`, quotes, nesting and here-documents aware. */
function matchParen(line: string, start: number): number {
  let level = 1;
  let pending: Heredoc[] = [];
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
    } else if (c === '<') {
      const found = heredocAt(line, i);
      if (found) {
        pending.push(found.heredoc);
        i = found.end - 1;
      } else {
        while (line.charAt(i + 1) === '<') i += 1;
      }
    } else if (c === '\n' && pending.length > 0) {
      for (const heredoc of pending) i = heredocBody(line, i, heredoc).end;
      pending = [];
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

const emptyScan = (): ShellLineScan => ({
  units: [],
  redirects: [],
  overflow: false,
  stdinShell: false,
});

/** Stands in a word for what a substitution (`$( )`, backticks) will put there. */
const DYNAMIC = '\u0000';
/** A word whose value the line does not say: a variable, a substitution or an empty word. */
const isDynamic = (word: string): boolean => word === '' || word.includes('$') || word.includes(DYNAMIC);
/** The last part of a path (`/usr/bin/git` is `git`). */
const commandName = (word: string): string => word.slice(word.lastIndexOf('/') + 1);

/**
 * Splits a shell line into simple commands (words with the quotes and escapes taken off), and
 * adds the commands inside `$( )`, backticks and `<( )` as commands of their own; `sh -c`, `eval`
 * and a shell that reads its script from the input are followed afterwards (`expandNested`). A
 * here-document's body is read on its own, as commands too (whatever reads it may run it), so a
 * quote in it cannot reach past its delimiter line.
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
function parseShell(line: string, state: ShellLineScan, depth: number, budget: ScanBudget): void {
  if (state.overflow) return;
  budget.left -= line.length;
  if (depth > MAX_NESTING || budget.left < 0) {
    state.overflow = true;
    return;
  }
  let words: string[] = [];
  let word = '';
  let inWord = false;
  let redirectTarget = false;
  let pending: Heredoc[] = [];

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
    parseShell(inner, state, depth + 1, budget);
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
      // A quote that never closes is read as a character: the words after it are still read.
      const end = line.indexOf("'", i + 1);
      word += end < 0 ? c : line.slice(i + 1, end);
      inWord = true;
      if (end >= 0) i = end;
    } else if (c === '"') {
      const open = i;
      const before = word;
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
      if (i >= line.length) {
        word = before + c;
        i = open;
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
    } else if (c === '\n' && pending.length > 0) {
      endCommand();
      for (const heredoc of pending) {
        const { body, end } = heredocBody(line, i, heredoc);
        const text = emptyScan();
        parseShell(body, text, depth + 1, budget);
        state.units.push(...text.units);
        state.redirects.push(...text.redirects);
        state.overflow ||= text.overflow;
        i = end;
      }
      pending = [];
    } else if (c === ';' || c === '&' || c === '|' || c === '\n' || c === '(' || c === ')') {
      endCommand();
    } else if (c === '<' || c === '>') {
      endWord();
      const found = c === '<' ? heredocAt(line, i) : null;
      if (found) {
        pending.push(found.heredoc);
        i = found.end - 1;
      } else {
        while (/[<>&|]/.test(line.charAt(i + 1))) i += 1;
        redirectTarget = true;
      }
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

/**
 * How many words at the start only prepare the command after them (a wrapper, its options): a word
 * at that index or before it is in the command's place.
 */
function preparingWords(words: string[]): number {
  const index = words.findIndex(
    (word) =>
      !(
        WRAPPERS.has(commandName(word)) ||
        word.startsWith('-') ||
        /^[A-Za-z_]\w*=/.test(word) ||
        /^\d+$/.test(word)
      ),
  );
  return index < 0 ? words.length : index;
}

/**
 * Follows `sh -c '…'` and `eval …` into the script they run, as commands of their own, and notes
 * a shell that takes its script from the input instead: the scan cannot see that script.
 */
function expandNested(state: ShellLineScan, budget: ScanBudget): void {
  for (let index = 0; index < state.units.length && !state.overflow; index += 1) {
    const { words, depth } = state.units[index]!;
    const prepared = preparingWords(words);
    for (let i = 0; i < words.length && !state.overflow; i += 1) {
      const name = commandName(words[i]!);
      if (name === 'eval') {
        parseShell(words.slice(i + 1).join(' '), state, depth + 1, budget);
      } else if (SHELLS.has(name)) {
        let readsInput = true;
        for (let j = i + 1; j < words.length; j += 1) {
          if (j > i + MAX_COMMAND_WORDS) {
            state.overflow = true;
            break;
          }
          const arg = words[j]!;
          if (arg === '-') break;
          if (!arg.startsWith('-')) {
            readsInput = false;
            break;
          }
          if (SHELL_VALUE_OPTIONS.has(arg)) {
            j += 1;
          } else if (!arg.startsWith('--') && arg.includes('c')) {
            parseShell(words[j + 1] ?? '', state, depth + 1, budget);
            readsInput = false;
            break;
          }
        }
        if (readsInput && i <= prepared) state.stdinShell = true;
      }
    }
  }
}

const GIT_PUSH_SUBCOMMANDS = new Set(['push', 'send-pack']);

/**
 * Whether `args` (after `git`) push: the subcommand after the global options, or an alias for it.
 * `cut`: the command goes on past `args`, so what is not decided within them counts as a push.
 */
function gitPushes(args: string[], cut: boolean, aliasedByEnvironment: boolean): boolean {
  // An alias set on the command line or in the environment may stand for `push`; its value
  // can come from a variable, so any such alias counts.
  let aliasedPush = aliasedByEnvironment;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (!arg.startsWith('-')) {
      if (isDynamic(arg) || GIT_PUSH_SUBCOMMANDS.has(arg)) return true;
      if (arg === 'subtree') {
        const action = args.slice(i + 1).find((word) => !word.startsWith('-'));
        if (action === undefined ? cut : action === 'push' || isDynamic(action)) return true;
      }
      return aliasedPush;
    }
    if (arg === '-c' && /^alias\.[^=]*=.*\bpush\b/.test(args[i + 1] ?? '')) aliasedPush = true;
    if (arg === '--config-env' && /^alias\./.test(args[i + 1] ?? '')) aliasedPush = true;
    if (/^--config-env=alias\./.test(arg)) aliasedPush = true;
    if (GIT_VALUE_OPTIONS.has(arg)) i += 1;
  }
  return aliasedPush || cut;
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

/**
 * The operations of one simple command. Each word reads at most `MAX_COMMAND_WORDS` after it, so the
 * work grows with the number of words, not with its square.
 */
function unitOperations(words: string[]): Set<DeniedSessionOperation> {
  const found = new Set<DeniedSessionOperation>();
  const environmentAlias = words.findIndex((word) => /^GIT_CONFIG_(KEY_\d+|PARAMETERS)=.*alias\./.test(word));
  const lastPush = words.lastIndexOf('push');
  const lastPr = words.lastIndexOf('pr');
  const lastCreate = words.lastIndexOf('create');
  const lastMerge = words.lastIndexOf('merge');
  // Every word may start the command a wrapper runs (`env A=1 git push`, `xargs git push`).
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]!;
    const name = commandName(word);
    if (name === 'git' || name === 'gh') {
      const rest = words.slice(i + 1, i + 1 + MAX_COMMAND_WORDS);
      const cut = words.length - i - 1 > MAX_COMMAND_WORDS;
      if (name === 'git') {
        if (gitPushes(rest, cut, environmentAlias >= 0 && environmentAlias < i)) found.add('git_push');
        continue;
      }
      const [group, action] = ghSubcommands(rest);
      if (group === 'api') {
        const operations: DeniedSessionOperation[] = cut
          ? ['pull_request_create', 'pull_request_merge']
          : ghApiOperations(rest);
        for (const operation of operations) found.add(operation);
      } else if (group === undefined ? cut : group === 'pr' || isDynamic(group)) {
        const unknown = action === undefined ? cut : isDynamic(action);
        if (action === 'create' || unknown) found.add('pull_request_create');
        if (action === 'merge' || unknown) found.add('pull_request_merge');
      }
    } else if (isDynamic(word)) {
      // A variable in the command's place (`$GIT push`) may be git or gh.
      if (lastPush > i) found.add('git_push');
      if (lastPr > i && lastCreate > i) found.add('pull_request_create');
      if (lastPr > i && lastMerge > i) found.add('pull_request_merge');
    }
  }
  return found;
}

/** The simple commands of a shell line, the nested ones included. */
export function scanShellLine(line: string): ShellLineScan {
  const state = emptyScan();
  const budget: ScanBudget = { left: MAX_SCAN_CHARACTERS };
  parseShell(line, state, 0, budget);
  expandNested(state, budget);
  return state;
}

/**
 * Whether the line runs one of `operations` (publishing), disguised or not. A line the scan cannot
 * vouch for counts as running them.
 */
export function runsSessionOperation(
  line: string | ShellLineScan,
  operations: readonly DeniedSessionOperation[],
): boolean {
  if (operations.length === 0) return false;
  const scan = typeof line === 'string' ? scanShellLine(line) : line;
  if (scan.overflow || scan.stdinShell) return true;
  return scan.units.some(({ words }) =>
    [...unitOperations(words)].some((operation) => operations.includes(operation)),
  );
}
