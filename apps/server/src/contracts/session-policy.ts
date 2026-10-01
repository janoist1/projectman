import type {
  DeniedSessionOperation,
  ReviewCopyMode,
  SessionAccess,
  ShellToolRule,
} from '@projectman/shared';

/**
 * How the managed VM profile (PM-141) runs a session: the installation's verified boundary, not
 * the CLI, holds the limits, so the CLI asks nothing locally. Absent in a policy means `legacy`
 * (the Mac installation as it always was). It never says `strict`: the strict native sandbox is a
 * different, stopped direction (decision 25) and the two are not mixed.
 */
export interface ManagedVmExecution {
  profile: 'managed_vm';
  /** The readiness profile the boundary was verified for (`VM_PROFILE_NAME` / `VM_PROFILE_VERSION`). */
  boundary: { name: string; version: number };
}

/** Versioned provider-neutral intent. Legacy enforcement is not a strict isolation boundary. */
export interface SessionPolicy {
  version: 1;
  enforcement: 'legacy' | 'strict';
  /** Present only for the managed VM profile; an adapter without it runs the legacy way. */
  execution?: ManagedVmExecution;
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
    | { kind: 'read_only'; path: string }
    | {
        /**
         * The managed VM's placement: the member's own workspace, whatever it does there. `use` says
         * what the role does (the task branch, a pinned review round, or no repository at all); it
         * limits nothing locally, the boundary does.
         */
        kind: 'member_workspace';
        path: string;
        use: 'work' | 'review' | 'home';
        /** `use` work: the task branch in the workspace and where it started. */
        workspace?: { branch: string; baseCommit: string | null };
        /** `use` review: the pinned round (the same facts as a review copy's). */
        review?: {
          sourceCommit: string;
          roundId: string;
          sourceBranch?: string;
          baseBranch?: string;
          baseCommit?: string;
        };
      };
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
    sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
    approval: 'never' | 'on-request';
  };
}
