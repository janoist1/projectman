/**
 * The engine host of the machine the server runs on (PM-312): everything the domain does to a disk
 * goes through `EngineHost` (`contracts/engine.ts`), and this module is what answers it here. The
 * checks (`attach_file`'s links and sizes, the session folders' ownership and renames) live in these
 * files and move with them to the machine of a remote engine. The domain keeps the decisions
 * (`DiskGuard`, the team tools, `ScreenshotRuns`).
 */
export { createLocalBranchMerger } from './branch-merger';
export type { LocalBranchMergerOptions } from './branch-merger';
export { createCheckBranchGit } from './check-branch';
export type { CheckBranchGitOptions } from './check-branch';
export { freeBytesOf } from './disk';
export { userExcludesFile } from './git-excludes';
export { createLocalEngine } from './local-engine';
export type { LocalEngineOptions } from './local-engine';
export { createLocalEngineHost } from './local-host';
export type { LocalEngineDisk, LocalEngineHostOptions } from './local-host';
export {
  isBranchName,
  isCommitFileSet,
  isCommitId,
  isMergeId,
  isMergeMessage,
  isRepoFilePath,
} from './merge-input';
export { listImages, resolveScenario } from './screenshots';
export { SessionFolders } from './session-folders';
export {
  defaultSessionTmpRoot,
  prepareSessionFoldersRoot,
  prepareSessionTmpRoot,
  sharedClaudeTmpRoots,
} from './session-roots';
export { realpathOfNearest } from './within';
export { resolveWorkRoots, WORK_ROOT_MARKER, WorkRootError } from './work-roots';
export type { WorkRoots } from './work-roots';
export { openWorkspaceFile } from './workspace-file';
export type { WorkspaceFileHooks } from './workspace-file';
