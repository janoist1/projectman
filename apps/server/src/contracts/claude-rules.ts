import type { DeniedSessionOperation, ShellToolRule } from '@projectman/shared';
import type { SessionPolicy } from './session-policy';

export function claudeShellRule(rule: ShellToolRule): string {
  return `Bash(${rule.command}${rule.arguments === 'prefix' ? ':*' : ''})`;
}
const operations: Record<DeniedSessionOperation, string> = {
  git_push: 'Bash(git push:*)',
  pull_request_create: 'Bash(gh pr create:*)',
  pull_request_merge: 'Bash(gh pr merge:*)',
};
const files = { read: 'Read', grep: 'Grep', glob: 'Glob' } as const;

/**
 * Characters a directory may hold to be named in a Claude Code path rule as it is: letters, marks and
 * digits of any script (an accented project path too, PM-188), `_ . / @ + ~ -` and the space; none of
 * the pattern or rule syntax (`* ? [ ] { } ( ) \`).
 */
const PLAIN_RULE_PATH = /^\/[\p{L}\p{M}\p{N}_./@+~ -]*$/u;

/** An absolute directory as a Claude Code rule path: `//dir/**` takes everything below it. */
function belowDirectory(dir: string): string {
  return `/${dir.replace(/\/+$/, '')}/**`;
}

/**
 * The rule paths of everything below an absolute directory, for `Read(...)` or `Edit(...)`; null
 * when a rule cannot name it as it is. An accented name is named both composed (NFC) and decomposed
 * (NFD, as macOS often hands it out): a rule matches the text it is given.
 */
export function directoryRulePaths(dir: string): string[] | null {
  if (!PLAIN_RULE_PATH.test(dir)) return null;
  return [...new Set([dir, dir.normalize('NFC'), dir.normalize('NFD')])].map(belowDirectory);
}

/** Deny rules for a path (a file or a directory) of the built-in file tools: reading and changing it. */
function denyFileRules(target: string): string[] {
  const path = `/${target.replace(/\/+$/, '')}`;
  return ['Read', 'Edit'].flatMap((tool) => [`${tool}(${path})`, `${tool}(${path}/**)`]);
}

/**
 * The built-in tools a team-tools-only session is refused outright (PM-475), by name: `--tools` already
 * leaves them out, and the deny rule holds even if a settings layer or a future CLI version brings one back.
 */
const TEAM_TOOLS_ONLY_DENIED = ['Bash', 'Read', 'Edit', 'Write', 'WebFetch', 'WebSearch', 'Agent'] as const;

export function claudeToolRules(
  policy: Pick<SessionPolicy, 'tools' | 'deniedOperations' | 'teamToolsOnly'> & {
    filesystem?: Pick<
      SessionPolicy['filesystem'],
      'readOnlyPaths' | 'deniedPaths' | 'sessionFolder' | 'sessionFoldersRoot' | 'readBoundary'
    >;
    network?: Pick<SessionPolicy['network'], 'deniedHosts'>;
  },
) {
  if (policy.teamToolsOnly) {
    // Nothing but the team tools: no file, shell or web tool, and no allow rule for a directory
    // (neither the session folders nor the read-only paths), whatever the rest of the policy says.
    return {
      allow: [
        ...new Set([
          ...(policy.tools.team.all ? ['mcp__team__*'] : []),
          ...policy.tools.team.names.map((name) => `mcp__team__${name}`),
        ]),
      ],
      deny: [...TEAM_TOOLS_ONLY_DENIED],
    };
  }
  const readOnly = policy.filesystem?.readOnlyPaths ?? [];
  // The session folders (PM-268, PM-333): every member's is read, only its own is changed. No deny
  // rule for the root: a deny beats an allow, and would shut the session's own folder too. A path a
  // rule cannot name gets no rule, and the session is asked, as anywhere else outside its directories.
  const folderRoot = policy.filesystem?.sessionFoldersRoot;
  const folder = policy.filesystem?.sessionFolder;
  const rootPaths = (folderRoot && directoryRulePaths(folderRoot)) || [];
  const folderPaths = (folder && directoryRulePaths(folder)) || [];
  // A reader with a read boundary (PM-425) is granted the file tools on its allowed places only, never on
  // every path: `Read(...)` rules cover Grep and Glob too. The rest of the home is refused by the runner's
  // hook, the places outside the home are allowed there (a deny rule would also shut what is allowed).
  const boundary = policy.filesystem?.readBoundary;
  const boundaryAllows = (boundary?.allowedPaths ?? []).flatMap((entry) =>
    entry.kind === 'directory'
      ? (directoryRulePaths(entry.path) ?? [])
      : PLAIN_RULE_PATH.test(entry.path)
        ? [entry.path]
        : [],
  );
  return {
    allow: [
      ...new Set([
        ...(policy.tools.team.all ? ['mcp__team__*'] : []),
        ...policy.tools.team.names.map((name) => `mcp__team__${name}`),
        ...(boundary ? [] : policy.tools.files.map((name) => files[name])),
        ...(boundary && policy.tools.files.length > 0
          ? boundaryAllows.map((p) => `Read(${p.startsWith('//') ? p : `/${p}`})`)
          : []),
        ...policy.tools.shell.map(claudeShellRule),
        // Read without asking, never edit: not an extra working directory, whose files
        // acceptEdits would let it change.
        ...readOnly.map((dir) => `Read(${belowDirectory(dir)})`),
        ...rootPaths.map((p) => `Read(${p})`),
        ...folderPaths.flatMap((p) => [`Read(${p})`, `Edit(${p})`]),
      ]),
    ],
    deny: [
      ...policy.deniedOperations.map((name) => operations[name]),
      ...readOnly.map((dir) => `Edit(${belowDirectory(dir)})`),
      ...(policy.filesystem?.deniedPaths ?? []).flatMap(denyFileRules),
      ...(policy.network?.deniedHosts ?? []).map((host) => `WebFetch(domain:${host})`),
    ],
  };
}
