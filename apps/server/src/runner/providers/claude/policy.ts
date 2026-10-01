import type { DeniedSessionOperation, ShellToolRule } from '@projectman/shared';
import type { SessionPolicy } from '../../../contracts';

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

export function claudeToolRules(
  policy: Pick<SessionPolicy, 'tools' | 'deniedOperations'> & {
    filesystem?: Pick<SessionPolicy['filesystem'], 'readOnlyPaths' | 'deniedPaths'>;
    network?: Pick<SessionPolicy['network'], 'deniedHosts'>;
  },
) {
  const readOnly = policy.filesystem?.readOnlyPaths ?? [];
  return {
    allow: [
      ...new Set([
        ...(policy.tools.team.all ? ['mcp__team__*'] : []),
        ...policy.tools.team.names.map((name) => `mcp__team__${name}`),
        ...policy.tools.files.map((name) => files[name]),
        ...policy.tools.shell.map(claudeShellRule),
        // Read without asking, never edit: not an extra working directory, whose files
        // acceptEdits would let it change.
        ...readOnly.map((dir) => `Read(${belowDirectory(dir)})`),
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
