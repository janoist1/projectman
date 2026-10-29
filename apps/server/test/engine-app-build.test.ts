import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CloudDeps, RunOptions } from '../../../scripts/cloud/deps';
import { buildEngineApp, isMachO } from '../../../scripts/engine-app/build';
import { runEngineAppCli } from '../../../scripts/engine-app/commands';
import { bundleVersions, EngineAppManifest } from '../../../scripts/engine-app/manifest';

const repo = fileURLToPath(new URL('../../..', import.meta.url));
const commit = 'a'.repeat(40);
const macho = Buffer.from('cffaedfe00000000', 'hex');
let root: string;
let pkg: string;
let out: string;
let calls: { command: string; args: string[]; options?: RunOptions }[];
let fail: (command: string, args: string[]) => boolean;
let notaryStatus: string;

const write = (file: string, content: string | Buffer) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
const run: CloudDeps['run'] = async (command, args, options) => {
  calls.push({ command, args, options });
  if (fail(command, args)) return { code: 1, stdout: '', stderr: 'fake failure' };
  let stdout = '';
  if (command === 'swift') {
    const bin = path.join(args[args.indexOf('--scratch-path') + 1]!, 'release');
    write(path.join(bin, 'EngineMenu'), macho);
    stdout = bin;
  }
  if (command === 'ditto') {
    if (args[0] === '-c') write(args.at(-1)!, `archive:${args.at(-2)}`);
    else fs.cpSync(args[0]!, args[1]!, { recursive: true, verbatimSymlinks: true });
  }
  if (command === 'hdiutil') {
    const image = args[args.indexOf('-srcfolder') + 1]!;
    expect(fs.readlinkSync(path.join(image, 'Applications'))).toBe('/Applications');
    expect(fs.existsSync(path.join(image, 'projectman motor.app/Contents/Info.plist'))).toBe(true);
    write(args.at(-1)!, 'image');
  }
  if (args[0] === 'notarytool')
    stdout = JSON.stringify(
      args[1] === 'submit' ? { id: 'submission-id', status: notaryStatus } : { issues: ['fake rejection'] },
    );
  if (args[0] === 'stapler' && args.at(-1)!.endsWith('.dmg')) fs.appendFileSync(args.at(-1)!, 'stapled');
  return { code: 0, stdout, stderr: '' };
};

function build(adHoc = false) {
  return buildEngineApp(
    { run, platform: 'darwin' },
    {
      packageDir: pkg,
      outDir: out,
      sourceRepo: repo,
      originUrl: 'git@github.com:example/projectman.git',
      adHoc,
      identity: 'Developer ID Application: Example',
      teamId: 'ABCDE12345',
      notaryProfile: 'release-notary',
    },
  );
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-app-build-'));
  pkg = path.join(root, 'package');
  out = path.join(root, 'out');
  write(
    path.join(pkg, 'engine-package.json'),
    JSON.stringify({
      schemaVersion: 1,
      version: commit,
      tag: 'v2026.10.29.2',
      node: '22.23.4',
      arch: 'arm64',
      builtAt: '2026-10-29T12:00:00Z',
    }),
  );
  for (const file of [
    'bin/node',
    'node_modules/addon.node',
    'node_modules/lib.dylib',
    'node_modules/pty/spawn-helper',
  ])
    write(path.join(pkg, file), macho);
  write(path.join(pkg, 'node_modules/not-native.node'), 'plain text');
  fs.symlinkSync('addon.node', path.join(pkg, 'node_modules/link.node'));
  calls = [];
  fail = () => false;
  notaryStatus = 'Accepted';
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

it('builds, signs inside out, staples before archiving, and hashes the final assets', async () => {
  await build();
  const app = path.join(out, 'projectman motor.app');
  const signing = calls.filter((c) => c.command === 'codesign' && c.args.includes('--sign'));
  expect(signing.map((c) => path.relative(app, c.args.at(-1)!))).toEqual([
    'Contents/Resources/engine/bin/node',
    'Contents/Resources/engine/node_modules/addon.node',
    'Contents/Resources/engine/node_modules/lib.dylib',
    'Contents/Resources/engine/node_modules/pty/spawn-helper',
    '',
    '../projectman-motor.dmg',
  ]);
  expect(signing[0]!.args).toContain('--entitlements');
  expect(signing.slice(1).every((c) => !c.args.includes('--entitlements'))).toBe(true);
  expect(signing.every((c) => c.args.includes('--timestamp') && c.args.includes('runtime'))).toBe(true);
  const swift = calls.find((c) => c.command === 'swift')!;
  expect(swift.args.slice(0, 6)).toEqual(['build', '-c', 'release', '--arch', 'arm64', '--package-path']);
  for (const flag of ['--scratch-path', '--cache-path', '--config-path', '--security-path'])
    expect(swift.args[swift.args.indexOf(flag) + 1]).toMatch(out);
  expect(Object.values(swift.options!.env!).every((v) => v.startsWith(out))).toBe(true);
  const staple = calls.findIndex((c) => c.args[0] === 'stapler' && c.args.at(-1) === app);
  const finalZip = calls.findIndex(
    (c) => c.command === 'ditto' && c.args.at(-1) === path.join(out, 'projectman-motor.zip'),
  );
  expect(finalZip).toBeGreaterThan(staple);
  expect(calls.filter((c) => c.args[0] === 'notarytool' && c.args[1] === 'submit')).toHaveLength(2);
  expect(calls.filter((c) => c.args[1] === 'submit').every((c) => c.options?.timeoutMs === 1800000)).toBe(
    true,
  );
  expect(calls.at(-1)).toMatchObject({ command: 'spctl', args: ['-a', '-t', 'exec', '-vv', app] });
  const plist = fs.readFileSync(path.join(app, 'Contents/Info.plist'), 'utf8');
  for (const value of [
    'com.projectman.engine-app',
    '2026.10.29.2',
    '20261029.2',
    commit,
    'example/projectman',
    'ABCDE12345',
  ])
    expect(plist).toContain(`<string>${value}</string>`);
  const manifest = EngineAppManifest.parse(
    JSON.parse(fs.readFileSync(path.join(out, 'projectman-motor.json'), 'utf8')),
  );
  for (const asset of [manifest.zip, manifest.dmg]) {
    const bytes = fs.readFileSync(path.join(out, asset.name));
    expect(asset.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(asset.size).toBe(bytes.length);
  }
  expect(fs.readdirSync(out).some((file) => file.startsWith('.build-'))).toBe(false);
  expect(fs.readFileSync(path.join(pkg, 'bin/node'))).toEqual(macho);
});

it('ad-hoc builds have no team id, notarization, DMG signing or Gatekeeper assessment', async () => {
  await build(true);
  const signs = calls.filter((c) => c.command === 'codesign' && c.args.includes('--sign'));
  expect(
    signs.every((c) => c.args[c.args.indexOf('--sign') + 1] === '-' && !c.args.includes('--timestamp')),
  ).toBe(true);
  expect(signs.some((c) => c.args.at(-1)!.endsWith('.dmg'))).toBe(false);
  expect(calls.some((c) => ['spctl', 'xcrun'].includes(c.command))).toBe(false);
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'projectman-motor.json'), 'utf8'));
  expect(manifest.teamId).toBe('');
});

it.each(['swift', 'ditto', 'codesign', 'hdiutil', 'spctl', 'notarytool', 'stapler'])(
  'removes publishable outputs when %s fails',
  async (tool) => {
    fail = (command, args) => command === tool || args[0] === tool;
    await expect(build()).rejects.toThrow();
    expect(fs.readdirSync(out).every((file) => file.includes('notary'))).toBe(true);
  },
);

it('saves the notary rejection log even when submit exits successfully', async () => {
  notaryStatus = 'Invalid';
  await expect(build()).rejects.toThrow(/notarization/);
  expect(JSON.parse(fs.readFileSync(path.join(out, 'app-notary-log.json'), 'utf8'))).toHaveProperty('issues');
  expect(calls.some((c) => c.args[0] === 'stapler')).toBe(false);
});

it('refuses nonempty output before running a tool', async () => {
  write(path.join(out, 'keep'), 'existing');
  await expect(build()).rejects.toMatchObject({ exitCode: 2 });
  expect(calls).toEqual([]);
  expect(fs.readFileSync(path.join(out, 'keep'), 'utf8')).toBe('existing');
});

it('uses development versions for an untagged package', async () => {
  const file = path.join(pkg, 'engine-package.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  write(file, JSON.stringify({ ...manifest, tag: null }));
  await build(true);
  const plist = fs.readFileSync(path.join(out, 'projectman motor.app/Contents/Info.plist'), 'utf8');
  expect(plist).toContain('<string>0.0.0</string>');
  expect(plist).toContain('<string>0</string>');
  expect(JSON.parse(fs.readFileSync(path.join(out, 'projectman-motor.json'), 'utf8')).tag).toBeNull();
});

it('refuses a signed build without keychain names before running a tool', async () => {
  await expect(
    buildEngineApp(
      { run, platform: 'darwin' },
      {
        packageDir: pkg,
        outDir: out,
        sourceRepo: repo,
        originUrl: 'https://github.com/example/projectman',
        adHoc: false,
      },
    ),
  ).rejects.toMatchObject({ exitCode: 2 });
  expect(calls).toEqual([]);
});

it('removes the already stapled app and zip if DMG notarization fails', async () => {
  fail = (_, args) => args[0] === 'notarytool' && args[1] === 'submit' && args[2]!.endsWith('.dmg');
  await expect(build()).rejects.toThrow(/notarization of dmg/);
  expect(fs.readdirSync(out).sort()).toEqual(['app-notary-submit.json', 'dmg-notary-submit.json']);
});

it.each([
  [null, '0.0.0', '0'],
  ['v2026.10.29', '2026.10.29', '20261029.0'],
  ['v2026.1.2.12', '2026.1.2.12', '20260102.12'],
  ['v2028.2.29', '2028.2.29', '20280229.0'],
] as const)('derives bundle versions from %s', (tag, short, build) => {
  expect(bundleVersions(tag)).toEqual({ short, build });
});
it.each(['latest', 'v2026.2.29', 'v2026.13.1', 'v2026.1.0'])('refuses invalid tag %s', (tag) => {
  expect(() => bundleVersions(tag)).toThrow();
});
it.each(['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'])(
  'recognizes Mach-O magic %s',
  (magic) => {
    expect(isMachO(Buffer.from(magic, 'hex'))).toBe(true);
  },
);
it.each([Buffer.alloc(0), Buffer.from('abc'), Buffer.from('plain text')])(
  'ignores non-Mach-O header %s',
  (header) => {
    expect(isMachO(header)).toBe(false);
  },
);
it('validates the shared Swift fixture with the release manifest schema', () => {
  const fixture = JSON.parse(
    fs.readFileSync(
      path.join(repo, 'deploy/mac/menubar/Tests/EngineMenuCoreTests/Fixtures/projectman-motor.json'),
      'utf8',
    ),
  );
  expect(EngineAppManifest.safeParse(fixture).success).toBe(true);
  expect(
    EngineAppManifest.safeParse({ ...fixture, zip: { ...fixture.zip, name: '../other.zip' } }).success,
  ).toBe(false);
});
it('routes build CLI options with resolved paths', async () => {
  const buildApp = vi.fn(async () => ({ root: out }));
  const deps = {
    originUrl: async () => 'https://github.com/example/projectman.git',
    sourceRepo: repo,
    cwd: root,
    build: vi.fn(),
    buildApp,
    out: vi.fn(),
    err: vi.fn(),
  };
  expect(await runEngineAppCli(['build', '--package', 'package', '--out', 'out', '--ad-hoc'], deps)).toBe(0);
  expect(buildApp).toHaveBeenCalledWith(
    expect.objectContaining({ packageDir: pkg, outDir: out, adHoc: true }),
  );
  expect(await runEngineAppCli(['build', '--package', '--out', 'out'], deps)).toBe(64);
});
