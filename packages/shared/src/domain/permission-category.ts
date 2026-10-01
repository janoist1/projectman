import type { BoundaryCategory } from './boundary';

/**
 * The owner's categories an AI decider never decides (PM-169): the same four as for external
 * operations (`BoundaryCategory` without `delegable`). `cost` is listed for completeness: what a
 * command spends cannot be read from its text, so only the decider's own judgement sends it on.
 */
export type PermissionOwnerCategory = Exclude<BoundaryCategory, 'delegable'>;

/** Tools that change a file; their path is checked against the session's roots. */
const WRITING_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const PATH_KEYS = ['file_path', 'notebook_path', 'path'] as const;

/**
 * Patterns on the text of a request, one list per category. Deliberately cautious: a request that
 * merely looks like one of these goes to a person, and a person is always allowed to decide. The text
 * is read as it is, quotes included (a `git push` in a message is also asked about by a person). The
 * first matching category wins, in the order of the table: production, credentials, host.
 */
const PATTERNS: ReadonlyArray<readonly [PermissionOwnerCategory, readonly RegExp[]]> = [
  [
    'production',
    [
      // Publishing: nothing leaves the machine without the owner (decisions 7, 16).
      /\bgit\b[^|;&\n]*\bpush\b/,
      /\bgh\s+(?:pr\s+(?:create|merge)|release|repo\s+(?:create|delete|edit)|workflow\s+run|api)\b/,
      /\b(?:npm|pnpm|yarn|bun)\s+publish\b/,
      /\b(?:twine\s+upload|cargo\s+publish|gem\s+push)\b/,
      // Releases and deploys.
      /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:deploy|release|publish)\b/,
      /\b(?:deploy|release|install|bootstrap|switch-live)[\w.-]*\.sh\b/,
      /(?:^|[\s/'"=])deploy\/\S/,
      // The owner's live instance: its home (not the worktrees and workspaces in it), its checkout
      // and its port.
      /\.projectman(?![\w-])(?!\/(?:worktrees|workspaces|attachments)(?:\/|\s|$|'|"))/,
      /\.projectman\/(?:worktrees|workspaces|attachments)\/\S*\.\.\//,
      /projectman-live/,
      /db\.sqlite/,
      /(?:[:=]|--port\s+)4800(?!\d)/,
    ],
  ],
  [
    'credentials',
    [
      /(?:^|[\s'"=:/~])\.(?:ssh|codex|claude|npmrc|netrc|aws|gnupg|env)(?![\w-])/,
      /\.config\/gh(?![\w-])/,
      /\bgh\s+(?:auth|secret|ssh-key|gpg-key)\b/,
      /\b(?:ssh-keygen|ssh-add|printenv)\b/,
      /\bsecurity\s+(?:find|add|delete|import|export|dump|unlock)[\w-]*/,
      /\bnpm\s+(?:login|adduser|token)\b/,
      /\bgpg\b[^|;&\n]*--(?:export|gen|import|delete)/,
    ],
  ],
  [
    'host_expansion',
    [
      /\b(?:sudo|doas|launchctl|brew|systemctl|crontab|tailscale|networksetup|scutil|dscl|spctl|pmset)\b/,
      /\b(?:chmod|chown|chgrp)\b/,
      /\bdefaults\s+write\b/,
      /\bnpm\s+(?:i|install|add)\b[^|;&\n]*\s(?:-g|--global)\b/,
      /\b(?:pipx?3?|gem|cargo|go)\s+install\b/,
      /\b(?:curl|wget)\b[^|;&\n]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/,
      />\s*\/etc\//,
    ],
  ],
];

/**
 * The tools that work on this machine and that the decider may judge. Any other tool, one of another
 * MCP server (an email, a shared document, a payment) or a name not known here, acts on something
 * outside the session and goes to a person; the team's own tools (`mcp__team__*`) are the exception.
 */
const LOCAL_TOOLS = new Set([
  'Bash',
  'PowerShell',
  'Read',
  'NotebookRead',
  'Glob',
  'Grep',
  'LS',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
  'Task',
  'Agent',
  ...WRITING_TOOLS,
  'apply_patch',
]);

/** Every file a Codex patch names (`*** Add|Update|Delete File:`, `*** Move to:`), in any string field. */
function patchPaths(toolInput: unknown): string[] {
  const texts =
    typeof toolInput === 'string'
      ? [toolInput]
      : toolInput && typeof toolInput === 'object'
        ? Object.values(toolInput as Record<string, unknown>).filter(
            (value): value is string => typeof value === 'string',
          )
        : [];
  return texts.flatMap((text) =>
    [...text.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm)].map((match) =>
      match[1]!.trim(),
    ),
  );
}

/** The text of a request the patterns read: the command, else the paths and the address. */
function requestText(toolInput: unknown): string {
  if (!toolInput || typeof toolInput !== 'object') return '';
  const input = toolInput as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ['command', ...PATH_KEYS, 'url']) {
    const value = input[key];
    if (typeof value === 'string') parts.push(value);
  }
  return parts.join('\n');
}

/** A POSIX path with `.` and `..` resolved; a relative one is joined to `base`. */
function normalize(path: string, base: string): string {
  const segments: string[] = [];
  const joined = path.startsWith('/') ? path : `${base}/${path}`;
  for (const segment of joined.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join('/')}`;
}

function insideRoots(path: string, roots: readonly string[]): boolean {
  const target = normalize(path, roots[0] ?? '/');
  return roots.some((root) => {
    const base = normalize(root, '/');
    return target === base || target.startsWith(base === '/' ? '/' : `${base}/`);
  });
}

/**
 * The owner's category a tool request falls in, or null (PM-169). A request in a category goes to the
 * member's sponsor or an owner, whoever the approver is: an AI never decides publishing, a release or
 * `main`, credentials, a lasting widening of what the host reaches, or the live instance. `roots` are
 * the directories the session works in; a file tool writing anywhere else widens the host.
 *
 * This is a filter on text, not a proof: a command can hide its meaning. The AI decider's own
 * instructions send every doubtful request to a person as well, and the decider never sees one that
 * matches here.
 */
export function permissionOwnerCategory(
  toolName: string,
  toolInput: unknown,
  roots: readonly string[],
): PermissionOwnerCategory | null {
  if (!LOCAL_TOOLS.has(toolName) && !toolName.startsWith('mcp__team__'))
    return toolName.startsWith('mcp__') ? 'production' : 'host_expansion';
  // A patch's text is the file contents it writes; only the files it names are the request.
  // A shell command that runs apply_patch carries the patch in its text: its files count as well.
  const command = requestText(toolInput);
  const patched =
    toolName === 'apply_patch' || (toolName !== 'Read' && /\bapply_patch\b/.test(command))
      ? patchPaths(toolInput)
      : null;
  const text = toolName === 'apply_patch' ? (patched ?? []).join('\n') : command;
  for (const [category, patterns] of PATTERNS) {
    if (patterns.some((pattern) => pattern.test(text))) return category;
  }
  if (patched && (toolName === 'apply_patch' || patched.length > 0)) {
    // A patch that names no file cannot be placed; each file it names must be inside the roots.
    if (patched.length === 0 || roots.length === 0 || patched.some((file) => !insideRoots(file, roots)))
      return 'host_expansion';
  } else if (WRITING_TOOLS.has(toolName) && toolInput && typeof toolInput === 'object') {
    const input = toolInput as Record<string, unknown>;
    const target = PATH_KEYS.map((key) => input[key]).find(
      (value): value is string => typeof value === 'string',
    );
    // A write without a readable path, or outside every root, is not a routine step.
    if (!target || roots.length === 0 || !insideRoots(target, roots)) return 'host_expansion';
  }
  return null;
}
