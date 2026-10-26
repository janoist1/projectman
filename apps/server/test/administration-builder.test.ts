import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBuilderToolbox } from '../../../scripts/administration/builder';
import type { BranchMerger, FullTestExecutor } from '../src/contracts';
import { defaultSessionTmpRoot, sharedClaudeTmpRoots } from '../src/engine-host';
import { installerSettings, runPaths, srtSettings } from '../src/full-test';

const fake = vi.hoisted(() => ({
  checkoutForCheck: vi.fn<BranchMerger['checkoutForCheck']>(),
  releaseCheck: vi.fn<BranchMerger['releaseCheck']>(),
  run: vi.fn<FullTestExecutor['run']>(),
}));

vi.mock('../src/engine-host', async (original) => ({
  ...(await original<typeof import('../src/engine-host')>()),
  createLocalBranchMerger: () => ({
    checkoutForCheck: fake.checkoutForCheck,
    releaseCheck: fake.releaseCheck,
  }),
}));
vi.mock('../src/full-test', async (original) => ({
  ...(await original<typeof import('../src/full-test')>()),
  createFullTestExecutor: () => ({ available: async () => ({ ok: true }), run: fake.run }),
}));

const CHECKOUT = '/srv/builder/checkouts/check';
const GIT_DIR = '/srv/builder/repo/.git/worktrees/check';
const paths = runPaths('/private/tmp/pmft-builder');

async function runBuilderTest(appHome: string) {
  const toolbox = createBuilderToolbox({
    repo: '/srv/builder/repo',
    root: '/srv/builder/checkouts',
    appHome,
  });
  await toolbox.runTest({
    runId: 'adminft_builder',
    commit: 'a'.repeat(40),
    command: 'npm run merge-test',
    signal: new AbortController().signal,
  });
  const spec = fake.run.mock.calls[0]![0];
  expect(spec.npmCi).toBeDefined();
  return [
    srtSettings(spec, paths),
    installerSettings(spec, paths, [path.join(CHECKOUT, 'node_modules')]),
  ] as const;
}

describe('administration builder sandbox', () => {
  let root: string;
  let claudeTmpBase: string;

  beforeEach(() => {
    vi.clearAllMocks();
    root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'adm-builder-'));
    claudeTmpBase = path.join(root, 'claude-tmp');
    fs.mkdirSync(claudeTmpBase);
    vi.stubEnv('CLAUDE_CODE_TMPDIR', claudeTmpBase);
    fake.checkoutForCheck.mockResolvedValue({
      path: CHECKOUT,
      gitDir: GIT_DIR,
      dependencyInstallRequired: true,
    });
    fake.releaseCheck.mockResolvedValue(undefined);
    fake.run.mockResolvedValue({
      outcome: 'passed',
      exitCode: 0,
      durationMs: 1,
      failedFiles: [],
      outputTail: '',
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('denies shared temporary roots during installation and testing while keeping its own sandbox readable', async () => {
    const [test, install] = await runBuilderTest(path.join(os.homedir(), '.projectman'));
    const closedRoots = [
      ...sharedClaudeTmpRoots({ claudeTmpBase }),
      defaultSessionTmpRoot(),
      path.join(fs.realpathSync(os.tmpdir()), 'projectman-sessions'),
    ];
    expect(closedRoots).toContain(path.join(claudeTmpBase, `claude-${process.getuid?.() ?? 'user'}`));
    for (const settings of [test, install]) {
      expect(settings.filesystem.denyRead).toEqual(expect.arrayContaining(closedRoots));
      expect(settings.filesystem.denyRead).not.toContain(fs.realpathSync(os.tmpdir()));
      expect(settings.filesystem.allowRead).toEqual(
        expect.arrayContaining([CHECKOUT, GIT_DIR, paths.sandbox]),
      );
      for (const denied of closedRoots)
        expect(
          settings.filesystem.allowRead.some(
            (allowed) =>
              denied === allowed || denied.startsWith(`${allowed}/`) || allowed.startsWith(`${denied}/`),
          ),
        ).toBe(false);
    }
    expect(test.network.allowedDomains).toEqual([]);
    expect(install.network.allowedDomains).toEqual(['registry.npmjs.org', 'nodejs.org']);
  });

  it('denies the configured app home outside the user home in both steps', async () => {
    const appHome = '/srv/projectman-builder-app';
    expect(appHome.startsWith(`${os.homedir()}/`)).toBe(false);
    for (const settings of await runBuilderTest(appHome)) {
      expect(settings.filesystem.denyRead).toContain(appHome);
      expect(settings.filesystem.allowRead).not.toContain(appHome);
    }
  });
});
