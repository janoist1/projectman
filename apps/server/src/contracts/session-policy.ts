import type {
  DeniedSessionOperation,
  ReviewCopyMode,
  SessionAccess,
  SessionReadBoundary,
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
        mergeFix?: { branch: string };
        path: string;
        /** A shared git directory outside `path` (a git worktree's); absent for an independent clone. */
        gitDir?: string;
        /** The worktree's own admin directory inside `gitDir` (`worktrees/<name>`, PM-399): its index and `HEAD`. */
        worktreeGitDir?: string;
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
  /**
   * The session works through the team tools alone (the Operator's conversation with someone who is not
   * an owner, PM-475). The adapter then offers no other built-in tool, denies the file, shell and web
   * tools, and renders no allow rule for a directory or a command.
   */
  teamToolsOnly?: boolean;
  filesystem: {
    readableRoots: string[];
    writableRoots: string[];
    protectedPaths: string[];
    /** Directories outside the placement the session reads but never changes (a task's attachments). */
    readOnlyPaths?: string[];
    /**
     * Files and directories the built-in file tools never read or change, in every permission mode
     * (the credentials of the user and the sensitive parts of the live instance, PM-165). Claude
     * Code renders them as deny rules, which hold in Auto too; its shell uses `denyRead` (PM-167).
     * Local Codex/NanoGPT shell commands use the same denials in their permission profile (PM-356).
     * Approved host commands are outside that boundary.
     */
    deniedPaths?: string[];
    /**
     * The session's own folder (PM-268, `PROJECTMAN_SESSION_DIR`): the file tools read and change it
     * without asking. Not a working directory (`--add-dir`). Legacy Claude sessions only.
     */
    sessionFolder?: string;
    /**
     * The root of this instance's session folders (PM-333), the parent of `sessionFolder`: the file
     * tools read every member's folder below it without asking and change nothing through it.
     * Present only with `sessionFolder`.
     */
    sessionFoldersRoot?: string;
    /**
     * Only a reading session (PM-425): the places below the user's home and the app home it reads (the
     * exact files and directory subtrees in `allowedPaths`) and the roots that stay closed otherwise.
     * Every provider's file-tool decision uses this one list (`readBoundaryVerdict`); the CLI's own
     * sandbox is rendered from the same list. `deniedPaths` stay denied whatever it allows.
     */
    readBoundary?: SessionReadBoundary;
  };
  deniedOperations: DeniedSessionOperation[];
  network: {
    allowedDomains: string[];
    allowLocalBinding: boolean;
    /** Hosts the built-in web fetch tool never reaches (the live instance on localhost, PM-165). */
    deniedHosts?: string[];
    /**
     * The member's outbound network (PM-355): `open` reaches any host but `deniedHosts`, `allowlist` only
     * the npm registry. The session's sandbox applies it.
     */
    outbound?: 'open' | 'allowlist';
  };
  outsideSandbox: 'ask' | 'deny';
  permissions: {
    claude: 'default' | 'acceptEdits' | 'auto' | 'plan' | 'bypassPermissions';
    sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
    approval: 'never' | 'on-request';
  };
}
