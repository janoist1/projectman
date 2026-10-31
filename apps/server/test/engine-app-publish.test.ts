import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { publishEngineApp } from '../../../scripts/engine-app/publish';
import type { PublishDeps } from '../../../scripts/engine-app/publish';
import { runEngineAppCli } from '../../../scripts/engine-app/commands';
import { uploadEngineApp } from '../../../scripts/engine-app/upload';

const tag = 'v2026.10.29.2';
const commit = 'a'.repeat(40);
let root: string;
let config: string;
let remote: Map<string, string>;
let missing: boolean;
let uploads: string[];
let deps: PublishDeps;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const artifacts = () =>
  new Map([
    ['projectman-motor.zip', 'zip'],
    ['projectman-motor.dmg', 'dmg'],
    [
      'projectman-motor.json',
      JSON.stringify({
        schemaVersion: 1,
        tag,
        version: commit,
        bundleVersion: '20261029.2',
        minimumMacOS: '13.0',
        arch: 'arm64',
        teamId: 'ABCDE12345',
        zip: { name: 'projectman-motor.zip', sha256: digest('zip'), size: 3 },
        dmg: { name: 'projectman-motor.dmg', sha256: digest('dmg'), size: 3 },
      }),
    ],
  ]);
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-publish-test-'));
  config = path.join(root, 'config.json');
  fs.writeFileSync(
    config,
    JSON.stringify({
      version: 1,
      signingIdentity: 'Developer ID Application: Example',
      teamId: 'ABCDE12345',
      notaryProfile: 'release',
    }),
  );
  remote = new Map();
  missing = false;
  uploads = [];
  let locked = false;
  deps = {
    heavyLock: async () => {
      locked = true;
      return {
        release: async () => {
          locked = false;
        },
      };
    },
    run: async (command, args, options) => {
      expect(options?.signal).toBeDefined();
      let stdout = '';
      if (command === 'git') {
        if (args[0] === 'ls-remote')
          stdout = `${'b'.repeat(40)}\trefs/tags/${tag}\n${commit}\trefs/tags/${tag}^{}\n`;
        if (args.includes('init')) fs.mkdirSync(args[1]!, { recursive: true });
        if (args.includes('rev-parse')) stdout = commit;
      } else {
        if (args[1] === 'view') {
          if (missing) return { code: 1, stdout: '', stderr: 'release not found' };
          stdout = JSON.stringify({ assets: [...remote.keys()].map((name) => ({ name })) });
        }
        if (args[1] === 'download')
          fs.writeFileSync(
            path.join(args.at(-1)!, args[args.indexOf('--pattern') + 1]!),
            remote.get(args[args.indexOf('--pattern') + 1]!)!,
          );
        if (args[1] === 'upload') {
          uploads.push(path.basename(args[3]!));
          remote.set(path.basename(args[3]!), fs.readFileSync(args[3]!, 'utf8'));
        }
      }
      return { code: 0, stdout, stderr: '' };
    },
    build: vi.fn(async (request) => {
      expect(locked).toBe(true);
      expect(request.commit).toBe(commit);
      return { root: request.outDir };
    }),
    buildApp: vi.fn(async (request) => {
      expect(locked).toBe(true);
      expect(request.sourceRepo).not.toBe(root);
      expect(request.adHoc).toBe(false);
      fs.mkdirSync(request.outDir);
      for (const [name, content] of artifacts()) fs.writeFileSync(path.join(request.outDir, name), content);
      return { root: request.outDir };
    }),
  };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const publish = () =>
  publishEngineApp(deps, { tag, config, repositoryUrl: 'https://github.com/example/projectman.git' });

it.each(['missing', 'invalid', 'unknown-key'])(
  'refuses %s configuration before calling GitHub',
  async (variant) => {
    if (variant === 'missing') fs.unlinkSync(config);
    else
      fs.writeFileSync(
        config,
        variant === 'invalid'
          ? '{}'
          : JSON.stringify({
              version: 1,
              signingIdentity: 'id',
              teamId: 'ABCDE12345',
              notaryProfile: 'profile',
              extra: true,
            }),
      );
    const run = vi.spyOn(deps, 'run');
    await expect(publish()).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining('[app_release_not_configured]'),
    });
    expect(run).not.toHaveBeenCalled();
  },
);
it('refuses a missing release before building', async () => {
  missing = true;
  await expect(publish()).rejects.toMatchObject({
    exitCode: 2,
    message: expect.stringContaining('[app_release_missing]'),
  });
  expect(deps.build).not.toHaveBeenCalled();
});
it('uploads archives in order with the manifest last', async () => {
  await publish();
  expect(uploads).toEqual([...artifacts().keys()]);
});
it('verifies a complete release without rebuilding or uploading', async () => {
  remote = artifacts();
  await publish();
  expect(uploads).toEqual([]);
  expect(deps.build).not.toHaveBeenCalled();
});
it('refuses a conflicting archive before any upload', async () => {
  remote.set('projectman-motor.dmg', 'different');
  await expect(publish()).rejects.toMatchObject({
    exitCode: 2,
    message: expect.stringContaining('[app_asset_conflict]'),
  });
  expect(uploads).toEqual([]);
});
it('skips an identical archive in an incomplete release', async () => {
  remote.set('projectman-motor.zip', 'zip');
  await publish();
  expect(uploads).toEqual(['projectman-motor.dmg', 'projectman-motor.json']);
});
it('refuses a corrupt completed publication', async () => {
  remote = artifacts();
  remote.set('projectman-motor.zip', 'corrupt');
  await expect(publish()).rejects.toMatchObject({ exitCode: 2 });
  expect(deps.build).not.toHaveBeenCalled();
});
it('keeps network errors operational', async () => {
  deps.run = async () => ({ code: 1, stdout: '', stderr: 'network unavailable' });
  await expect(publish()).rejects.toMatchObject({ exitCode: 1 });
});
/** A build output directory as `build --ad-hoc` writes it; `edit` changes the manifest. */
const builtDir = (edit: (manifest: Record<string, unknown>) => void = () => {}) => {
  const dir = path.join(root, 'built');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of artifacts()) {
    if (name.endsWith('.json')) {
      const manifest = JSON.parse(content) as Record<string, unknown>;
      manifest.teamId = '';
      edit(manifest);
      fs.writeFileSync(path.join(dir, name), JSON.stringify(manifest));
    } else fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
};
const upload = (dir: string, uploadTag = tag) =>
  uploadEngineApp(
    { run: deps.run },
    { tag: uploadTag, dir, repositoryUrl: 'https://github.com/example/projectman' },
  );

it('uploads an ad-hoc build with the manifest last and builds nothing', async () => {
  await upload(builtDir());
  expect(uploads).toEqual([...artifacts().keys()]);
  expect(deps.build).not.toHaveBeenCalled();
});
it('skips identical assets of an interrupted upload', async () => {
  const dir = builtDir();
  remote.set('projectman-motor.zip', 'zip');
  remote.set('projectman-motor.dmg', 'dmg');
  await upload(dir);
  expect(uploads).toEqual(['projectman-motor.json']);
});
it('refuses a different existing asset before any upload', async () => {
  remote.set('projectman-motor.json', 'signed by someone else');
  await expect(upload(builtDir())).rejects.toMatchObject({
    exitCode: 2,
    message: expect.stringContaining('[app_asset_conflict]'),
  });
  expect(uploads).toEqual([]);
});
it('refuses a tag without a release', async () => {
  missing = true;
  await expect(upload(builtDir())).rejects.toMatchObject({
    exitCode: 2,
    message: expect.stringContaining('[app_release_missing]'),
  });
});
it.each([
  ['another tag', (manifest: Record<string, unknown>) => (manifest.tag = 'v2026.10.29.3')],
  ['another commit', (manifest: Record<string, unknown>) => (manifest.version = 'c'.repeat(40))],
])('refuses a manifest of %s', async (_name, edit) => {
  await expect(upload(builtDir(edit))).rejects.toMatchObject({
    exitCode: 2,
    message: expect.stringContaining('[app_manifest_mismatch]'),
  });
  expect(uploads).toEqual([]);
});
it('refuses an archive that is not the one of the manifest', async () => {
  const dir = builtDir();
  fs.writeFileSync(path.join(dir, 'projectman-motor.dmg'), 'tampered');
  await expect(upload(dir)).rejects.toMatchObject({ exitCode: 2 });
  expect(uploads).toEqual([]);
});
it('rejects malformed upload command lines', async () => {
  const cli = {
    sourceRepo: root,
    cwd: root,
    originUrl: async () => 'https://github.com/example/projectman',
    build: async () => ({ root }),
    upload: vi.fn(),
    out: vi.fn(),
    err: vi.fn(),
  };
  expect(await runEngineAppCli(['upload', '--tag', tag, '--dir', 'x', '--clobber'], cli)).toBe(64);
  expect(await runEngineAppCli(['upload', '--tag', 'main', '--dir', 'x'], cli)).toBe(64);
  expect(cli.upload).not.toHaveBeenCalled();
  expect(await runEngineAppCli(['upload', '--tag', tag, '--dir', 'x'], cli)).toBe(0);
  expect(cli.upload).toHaveBeenCalledWith({
    tag,
    dir: path.join(root, 'x'),
    repositoryUrl: 'https://github.com/example/projectman',
  });
});
it('rejects malformed publish command lines', async () => {
  const cli = {
    sourceRepo: root,
    cwd: root,
    originUrl: async () => 'https://github.com/example/projectman',
    build: async () => ({ root }),
    publish: vi.fn(),
    out: vi.fn(),
    err: vi.fn(),
  };
  expect(await runEngineAppCli(['publish', '--tag', tag, '--clobber'], cli)).toBe(64);
  expect(cli.publish).not.toHaveBeenCalled();
});
