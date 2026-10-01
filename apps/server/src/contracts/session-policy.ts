import type { DeniedSessionOperation, SessionAccess, ShellToolRule } from '@projectman/shared';

/** Versioned provider-neutral intent. Legacy enforcement is not a strict isolation boundary. */
export interface SessionPolicy {
  version: 1;
  enforcement: 'legacy' | 'strict';
  access: SessionAccess;
  placement:
    | { kind: 'task_worktree'; path: string; gitDir?: string }
    | { kind: 'review_copy'; path: string; gitDir: string; sourceCommit: string; roundId: string }
    | { kind: 'read_only'; path: string };
  tools: {
    team: { all: boolean; names: string[] };
    files: Array<'read' | 'grep' | 'glob'>;
    shell: ShellToolRule[];
  };
  filesystem: { readableRoots: string[]; writableRoots: string[]; protectedPaths: string[] };
  deniedOperations: DeniedSessionOperation[];
  network: { allowedDomains: string[]; allowLocalBinding: boolean };
  outsideSandbox: 'ask' | 'deny';
  permissions: {
    claude: 'default' | 'acceptEdits' | 'auto' | 'plan' | 'bypassPermissions';
    sandbox: 'read-only' | 'workspace-write';
    approval: 'never' | 'on-request';
  };
}
