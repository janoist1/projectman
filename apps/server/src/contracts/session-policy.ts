import type {
  DeniedSessionOperation,
  ReviewCopyMode,
  SessionAccess,
  ShellToolRule,
} from '@projectman/shared';

/** Versioned provider-neutral intent. Legacy enforcement is not a strict isolation boundary. */
export interface SessionPolicy {
  version: 1;
  enforcement: 'legacy' | 'strict';
  access: SessionAccess;
  /** Separate review-copy opt-in; absent means inherit, never inferred from permissionMode. */
  reviewCopyMode?: ReviewCopyMode;
  placement:
    | {
        kind: 'task_worktree';
        path: string;
        /** A shared git directory outside `path` (a git worktree's); absent for an independent clone. */
        gitDir?: string;
        /** The member's durable workspace (PM-138): the task branch in it and where it started. */
        workspace?: { branch: string; baseCommit: string | null };
      }
    | {
        kind: 'review_copy';
        path: string;
        gitDir: string;
        sourceCommit: string;
        roundId: string;
        cacheDir?: string;
        tempDir?: string;
        /** The handed-over branch and the default branch commit pinned for the round (PM-138). */
        sourceBranch?: string;
        baseBranch?: string;
        baseCommit?: string;
      }
    | { kind: 'read_only'; path: string };
  tools: {
    team: { all: boolean; names: string[] };
    files: Array<'read' | 'grep' | 'glob'>;
    shell: ShellToolRule[];
  };
  filesystem: {
    readableRoots: string[];
    writableRoots: string[];
    protectedPaths: string[];
    /** Directories outside the placement the session reads but never changes (a task's attachments). */
    readOnlyPaths?: string[];
  };
  deniedOperations: DeniedSessionOperation[];
  network: { allowedDomains: string[]; allowLocalBinding: boolean };
  outsideSandbox: 'ask' | 'deny';
  permissions: {
    claude: 'default' | 'acceptEdits' | 'auto' | 'plan' | 'bypassPermissions';
    sandbox: 'read-only' | 'workspace-write';
    approval: 'never' | 'on-request';
  };
}
