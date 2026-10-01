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

/** An absolute directory as a Claude Code rule path: `//dir/**` takes everything below it. */
function belowDirectory(dir: string): string {
  return `/${dir.replace(/\/+$/, '')}/**`;
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
