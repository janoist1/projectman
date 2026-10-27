export { createWorktreeManager } from './worktree-manager';
export { createMemberWorkspaceManager } from './member-workspace-manager';
export { createMemberWorkspaceRegistry } from './member-workspace-registry';
export { createDependencyGate } from './dependency-gate';
export { git } from './git';
export {
  DEPENDENCY_LOCKFILE,
  dependencyState,
  findDependencyReference,
  markDependenciesInstalled,
} from './dependencies';
export { copyDependencyTrees } from './dependency-copy';
