export { createWorktreeManager, WorktreeError, type WorktreeErrorCode } from './worktree-manager';
export {
  createMemberWorkspaceManager,
  MemberWorkspaceError,
  type MemberWorkspaceManagerSettings,
} from './member-workspace-manager';
export { localWorkspaceAccess, SAFE_GIT_SETTINGS } from './workspace-access';
export type { TransferSource, WorkspaceAccess } from './workspace-access';
export { git, GitCommandError } from './git';
export { DEPENDENCY_LOCKFILE, findDependencyReference } from './dependencies';
