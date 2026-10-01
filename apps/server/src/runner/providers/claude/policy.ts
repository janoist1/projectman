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

export function claudeToolRules(policy: Pick<SessionPolicy, 'tools' | 'deniedOperations'>) {
  return {
    allow: [
      ...new Set([
        ...(policy.tools.team.all ? ['mcp__team__*'] : []),
        ...policy.tools.team.names.map((name) => `mcp__team__${name}`),
        ...policy.tools.files.map((name) => files[name]),
        ...policy.tools.shell.map(claudeShellRule),
      ]),
    ],
    deny: policy.deniedOperations.map((name) => operations[name]),
  };
}
