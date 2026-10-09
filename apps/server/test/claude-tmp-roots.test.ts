import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectConfig } from '@projectman/shared';
import { sharedClaudeTmpRoots } from '../src/engine-host';
import { createDomainHarness, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';

const task = { type: 'task', taskKey: 'AR-1' } as const;
/** The roots the harness hands the domain (not this machine's: see `claudeTmpRoots` of the harness). */
const CLAUDE_ROOTS = sharedClaudeTmpRoots({ uid: 'test' });

/** Claude Code's temporary root: a session's own, and the shared ones closed (PM-353). */
describe('the shared Claude Code temporary roots', () => {
  let h: DomainHarness | undefined;
  let base: string;
  let home: string;
  let appHome: string;
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'pm-claude-tmp-test-')));
    home = join(base, 'user-home');
    appHome = join(base, 'app-home');
    mkdirSync(home);
    mkdirSync(appHome);
  });
  afterEach(async () => {
    await h?.cleanup();
    h = undefined;
    rmSync(base, { recursive: true, force: true });
  });

  const open = (options: { folders?: boolean; tmp?: boolean; adjust?: (config: ProjectConfig) => void }) =>
    createDomainHarness({
      userHome: home,
      appHome,
      sessionFolders: options.folders ?? true,
      sessionTmp: options.tmp ?? true,
      adjust: options.adjust,
    });
  const asCodex = (config: ProjectConfig) => {
    const dev = config.team.members.find((m) => m.handle === 'dev-1');
    if (dev?.kind === 'ai') dev.provider = 'codex';
  };
  const begin = async (handle = 'dev-1') => {
    await h!.domain.tasks.create('AR', { title: 'Login page', repo: 'web' }, OWNER_ACTOR);
    return h!.domain.sessions.ensureSession('AR', handle, task);
  };
  const started = () => h!.runner.lastStarted();
  const mode = (path: string) => statSync(path).mode & 0o777;

  it('gives a Claude developer its own root, closes the shared ones and opens only its own', async () => {
    h = await open({});
    const { session } = await begin();
    const spec = started();
    const tmpDir = spec.sandbox!.portable!.tmpDir!;
    expect(tmpDir).toMatch(new RegExp(`^${h.sessionTmpDir}/[0-9a-f]{12}$`));
    expect(existsSync(tmpDir)).toBe(true);
    expect(mode(tmpDir)).toBe(0o700);
    // The roots are denied to the file tools (the policy) and to the commands (the sandbox).
    expect(spec.policy!.filesystem.deniedPaths).toEqual(expect.arrayContaining(CLAUDE_ROOTS));
    expect(spec.sandbox!.denyRead).toEqual(
      expect.arrayContaining([...CLAUDE_ROOTS, dirname(h.sessionTmpDir!)]),
    );
    expect(spec.sandbox!.denyWrite).toEqual(expect.arrayContaining(CLAUDE_ROOTS));
    expect(spec.sandbox!.denyWrite).not.toContain(dirname(h.sessionTmpDir!));
    expect(spec.sandbox!.allowRead).toContain(tmpDir);
    expect(spec.sandbox!.allowWrite).toContain(tmpDir);
    // It goes with the session's end.
    await h.runner.stop(session.id);
    await h.domain.sessions.settleFolderRemovals();
    expect(existsSync(tmpDir)).toBe(false);
    expect(readdirSync(h.sessionTmpDir!)).toEqual([]);
  });

  it('gives a Claude reader the same, besides its read-only checkout', async () => {
    h = await open({});
    await begin();
    await h.domain.sessions.ensureSession('AR', 'cr', task);
    const spec = started();
    expect(spec.policy!.access).toBe('read_only');
    const tmpDir = spec.sandbox!.portable!.tmpDir!;
    expect(existsSync(tmpDir)).toBe(true);
    expect(spec.policy!.filesystem.deniedPaths).toEqual(expect.arrayContaining(CLAUDE_ROOTS));
    expect(spec.sandbox!.denyRead).toEqual(
      expect.arrayContaining([...CLAUDE_ROOTS, dirname(h.sessionTmpDir!)]),
    );
    expect(spec.sandbox!.denyWrite).toEqual(expect.arrayContaining(CLAUDE_ROOTS));
    expect(spec.sandbox!.allowWrite).toContain(tmpDir);
  });

  it('a new directory at every start of the same session', async () => {
    h = await open({});
    const { session } = await begin();
    const first = started().sandbox!.portable!.tmpDir!;
    await h.runner.stop(session.id);
    await h.domain.sessions.ensureSession('AR', 'dev-1', task);
    const second = started().sandbox!.portable!.tmpDir!;
    expect(second).not.toBe(first);
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(true);
  });

  it('leaves the shared roots open to a Claude session that has no root of its own (the CLI still uses them)', async () => {
    h = await open({ tmp: false });
    await begin();
    const spec = started();
    expect(spec.sandbox!.portable?.tmpDir).toBeUndefined();
    for (const root of CLAUDE_ROOTS) {
      expect(spec.policy!.filesystem.deniedPaths).not.toContain(root);
      expect(spec.sandbox!.denyRead).not.toContain(root);
    }
  });

  it('gets no root of its own without the session folders either', async () => {
    h = await open({ folders: false, tmp: true });
    await begin();
    const spec = started();
    expect(spec.sandbox!.portable?.tmpDir).toBeUndefined();
    expect(spec.policy!.filesystem.deniedPaths).not.toContain(CLAUDE_ROOTS[0]);
  });

  it('closes the shared roots for a Codex session, with or without a root of its own', async () => {
    for (const tmp of [true, false]) {
      h = await open({ tmp, adjust: asCodex });
      await begin();
      expect(started().policy!.filesystem.deniedPaths).toEqual(expect.arrayContaining(CLAUDE_ROOTS));
      await h.cleanup();
      h = undefined;
    }
  });
});
