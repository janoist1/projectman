import { describe, expect, it } from 'vitest';

describe('engine-host index', () => {
  it('gives out only the names the server side and the engine link use', async () => {
    expect(Object.keys(await import('./index')).sort()).toEqual([
      'SessionFolders',
      'WORK_ROOT_MARKER',
      'WorkRootError',
      'createCheckBranchGit',
      'createLocalBranchMerger',
      'createLocalEngine',
      'createLocalEngineHost',
      'defaultSessionTmpRoot',
      'freeBytesOf',
      'isBranchName',
      'isCommitFileSet',
      'isCommitId',
      'isMergeId',
      'isMergeMessage',
      'isRepoFilePath',
      'listImages',
      'openWorkspaceFile',
      'prepareSessionFoldersRoot',
      'prepareSessionTmpRoot',
      'realpathOfNearest',
      'resolveScenario',
      'resolveWorkRoots',
      'sharedClaudeTmpRoots',
      'userExcludesFile',
    ]);
  });
});
