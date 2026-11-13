import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The friend's install script (PM-1425) runs as a real `sh` process with Apple's `ditto`, `plutil` and `shasum`,
 * and stand-ins for `curl`, `gh`, `codesign`, `xattr`, `uname` and `sw_vers` that log their calls. The risk is the
 * order: the quarantine attribute may only be removed after every check has passed.
 */

const ROOT = fs.realpathSync(fileURLToPath(new URL('../../..', import.meta.url)));
const SCRIPT = path.join(ROOT, 'deploy/mac/install-engine-app.sh');
const TAG = 'v2026.11.13';
const COMMIT = 'a1b2c3d4'.repeat(5);
const BUNDLE_VERSION = '20261113.0';
const APP = 'projectman motor.app';
const IDENTIFIER = 'com.projectman.engine-app';
const QUARANTINE = 'com.apple.quarantine';

const FAKES: Record<string, string> = {
  curl: `out=''; url=''
while [ $# -gt 0 ]; do case $1 in -o) out=$2; shift 2 ;; -*) shift ;; *) url=$1; shift ;; esac; done
[ -f "$FAKE_RELEASE/$(basename "$url")" ] || exit 22
cp "$FAKE_RELEASE/$(basename "$url")" "$out"`,
  gh: `case $1 in
  --version) echo "gh version $FAKE_GH_VERSION (2026-01-01)" ;;
  auth) exit "$FAKE_GH_AUTH" ;;
  attestation) [ "$(basename "$3")" != "$FAKE_ATTEST_FAIL" ] || exit 1 ;;
esac`,
  codesign: `for argument; do [ "$argument" != "=identifier \\"$FAKE_SIGNED_ID\\"" ] || exit 0; done
exit 3`,
  xattr: `if [ "$1" = -rl ] && [ "$FAKE_QUARANTINE" = 1 ]; then echo "$2: ${QUARANTINE}: 0083;6735a1b2;Safari;"; fi`,
  uname: `case $1 in -s) echo Darwin ;; -m) echo arm64 ;; esac`,
  sw_vers: 'echo 15.1',
  mv: `case $1 in */.projectman-install.*/"${APP}") [ "$FAKE_MV_FAIL" != 1 ] || exit 1 ;; esac
exec /bin/mv "$@"`,
};

let directory: string;
let home: string;
let release: string;
let log: string;
let env: Record<string, string>;

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Builds the release pair; `engineCommit` is the commit of the engine bundled in the app. */
function writeRelease(engineCommit = COMMIT): void {
  const source = path.join(directory, 'source');
  const contents = path.join(source, APP, 'Contents');
  fs.mkdirSync(path.join(contents, 'Resources/engine'), { recursive: true });
  fs.writeFileSync(
    path.join(contents, 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${IDENTIFIER}</string>
<key>CFBundleVersion</key><string>${BUNDLE_VERSION}</string>
</dict></plist>
`,
  );
  fs.writeFileSync(
    path.join(contents, 'Resources/engine/engine-package.json'),
    JSON.stringify({ version: engineCommit }),
  );
  const zip = path.join(release, 'projectman-motor.zip');
  execFileSync('ditto', ['-c', '-k', '--keepParent', path.join(source, APP), zip]);
  writeManifest({});
}

function writeManifest(change: { tag?: string; sha256?: string }): void {
  const zip = path.join(release, 'projectman-motor.zip');
  const manifest = {
    schemaVersion: 1,
    tag: change.tag ?? TAG,
    version: COMMIT,
    bundleVersion: BUNDLE_VERSION,
    minimumMacOS: '13.0',
    arch: 'arm64',
    teamId: '',
    zip: { name: 'projectman-motor.zip', sha256: change.sha256 ?? sha256(zip), size: fs.statSync(zip).size },
    dmg: { name: 'projectman-motor.dmg', sha256: 'b'.repeat(64), size: 1 },
  };
  fs.writeFileSync(path.join(release, 'projectman-motor.json'), JSON.stringify(manifest));
}

function install(args: string[] = ['--tag', TAG]) {
  const result = spawnSync('/bin/sh', [SCRIPT, ...args], { env, encoding: 'utf8' });
  // `mv` is a stand-in only to fail on demand; its calls are not part of the order under test.
  const calls = (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []).filter(
    (call) => !call.startsWith('mv '),
  );
  return { ...result, calls };
}

const installed = () => path.join(home, 'Applications', APP);
const xattrCalls = (calls: string[]) => calls.filter((call) => call.startsWith('xattr '));

beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engine-app-install-')));
  home = path.join(directory, 'home');
  release = path.join(directory, 'release');
  log = path.join(directory, 'calls.log');
  const bin = path.join(directory, 'bin');
  for (const folder of [home, release, bin, path.join(directory, 'tmp')]) fs.mkdirSync(folder);
  for (const [name, body] of Object.entries(FAKES))
    fs.writeFileSync(
      path.join(bin, name),
      `#!/bin/sh\n{ printf '%s' ${name}; for a; do printf ' %s' "$a"; done; echo; } >>"$FAKE_LOG"\n${body}\n`,
      { mode: 0o755 },
    );
  env = {
    PATH: `${bin}:/usr/bin:/bin`,
    PROJECTMAN_INSTALL_TEST_BIN: bin,
    HOME: home,
    TMPDIR: path.join(directory, 'tmp'),
    FAKE_LOG: log,
    FAKE_RELEASE: release,
    FAKE_GH_VERSION: '2.62.0',
    FAKE_GH_AUTH: '0',
    FAKE_ATTEST_FAIL: '',
    FAKE_SIGNED_ID: IDENTIFIER,
    FAKE_QUARANTINE: '0',
    FAKE_MV_FAIL: '0',
  };
  writeRelease();
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

describe.skipIf(process.platform !== 'darwin')('install-engine-app.sh', () => {
  it.each([
    ['the zip differs from the manifest', 'sha256_mismatch', () => writeManifest({ sha256: 'c'.repeat(64) })],
    [
      'the zip has no valid attestation',
      'attestation_invalid',
      () => (env.FAKE_ATTEST_FAIL = 'projectman-motor.zip'),
    ],
    [
      'the manifest has no valid attestation',
      'attestation_invalid',
      () => (env.FAKE_ATTEST_FAIL = 'projectman-motor.json'),
    ],
    ['the signature is not valid', 'signature_invalid', () => (env.FAKE_SIGNED_ID = '')],
    ['the app has another identifier', 'signature_invalid', () => (env.FAKE_SIGNED_ID = 'com.example.other')],
    ['the bundled engine is another commit', 'version_mismatch', () => writeRelease('f'.repeat(40))],
    ['the manifest is of another release', 'manifest_invalid', () => writeManifest({ tag: 'v2026.11.12' })],
    ['gh is not logged in', 'gh_not_logged_in', () => (env.FAKE_GH_AUTH = '1')],
    ['gh is too old for attestations', 'gh_outdated', () => (env.FAKE_GH_VERSION = '2.48.0')],
  ])('refuses when %s, before touching the quarantine', (_case, code, damage) => {
    env.FAKE_QUARANTINE = '1';
    damage();
    const result = install();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`REFUSED [${code}]`);
    expect(xattrCalls(result.calls)).toEqual([]);
    expect(fs.existsSync(installed())).toBe(false);
    expect(fs.readdirSync(path.join(directory, 'tmp'))).toEqual([]);
  });

  it('removes the quarantine as the last step, after the attestations and the signature', () => {
    env.FAKE_QUARANTINE = '1';
    const result = install();
    expect(result.status, result.stderr).toBe(0);
    const verifyArgs = [
      '--repo janoist1/projectman',
      '--signer-workflow janoist1/projectman/.github/workflows/projectman-engine-release.yml',
      '--source-ref refs/heads/main',
      '--deny-self-hosted-runners',
    ].join(' ');
    const attestations = result.calls.filter((call) => call.startsWith('gh attestation verify'));
    expect(attestations.map((call) => path.basename(call.split(' ')[3]!))).toEqual([
      'projectman-motor.zip',
      'projectman-motor.json',
    ]);
    for (const call of attestations) expect(call.endsWith(verifyArgs)).toBe(true);
    const signature = result.calls.findIndex((call) => call.startsWith('codesign '));
    const firstXattr = result.calls.findIndex((call) => call.startsWith('xattr '));
    expect(signature).toBeGreaterThan(result.calls.lastIndexOf(attestations.at(-1)!));
    expect(firstXattr).toBeGreaterThan(signature);
    expect(result.calls.at(-1)).toMatch(new RegExp(`^xattr -dr ${QUARANTINE} `));
    expect(fs.existsSync(path.join(installed(), 'Contents/Resources/engine/engine-package.json'))).toBe(true);
    expect(fs.readdirSync(path.join(home, 'Applications'))).toEqual([APP]);
    expect(result.stdout).toContain(`open "${installed()}"`);
  });

  it('leaves an app without quarantine alone', () => {
    const result = install();
    expect(result.status, result.stderr).toBe(0);
    expect(xattrCalls(result.calls).filter((call) => call.startsWith('xattr -d'))).toEqual([]);
    expect(fs.existsSync(installed())).toBe(true);
  });

  it('ends with the NEXT guide and exit 0 without a here-document, which bash 3.2 writes to /tmp', () => {
    const result = install();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('NEXT');
    // /tmp cannot be made unwritable here, so the cause is checked: no here-document or here-string in the code.
    const code = fs
      .readFileSync(SCRIPT, 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'));
    expect(code.filter((line) => line.includes('<<'))).toEqual([]);
  });

  it('keeps the previous install when the new app cannot be moved into place', () => {
    fs.mkdirSync(installed(), { recursive: true });
    fs.writeFileSync(path.join(installed(), 'previous-marker'), 'old');
    env.FAKE_MV_FAIL = '1';
    const result = install();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('REFUSED [copy_failed]');
    expect(fs.readFileSync(path.join(installed(), 'previous-marker'), 'utf8')).toBe('old');
    expect(fs.readdirSync(path.join(home, 'Applications'))).toEqual([APP]);
  });

  it('replaces the previous install when the new app is moved into place', () => {
    fs.mkdirSync(installed(), { recursive: true });
    fs.writeFileSync(path.join(installed(), 'previous-marker'), 'old');
    const result = install();
    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(path.join(installed(), 'previous-marker'))).toBe(false);
    expect(fs.existsSync(path.join(installed(), 'Contents/Info.plist'))).toBe(true);
    expect(fs.readdirSync(path.join(home, 'Applications'))).toEqual([APP]);
  });

  it('warns when the test tool directory is set, and only then', () => {
    const warned = install();
    expect(warned.stderr).toContain('WARNING PROJECTMAN_INSTALL_TEST_BIN is set');
    delete env.PROJECTMAN_INSTALL_TEST_BIN;
    const quiet = install(['--tag', 'not-a-tag']);
    expect(quiet.stderr).toContain('REFUSED [usage]');
    expect(quiet.stderr).not.toContain('WARNING');
  });

  it('runs the same checks on a pair downloaded by hand', () => {
    env.FAKE_QUARANTINE = '1';
    env.FAKE_ATTEST_FAIL = 'projectman-motor.zip';
    const manual = path.join(directory, 'Downloads');
    fs.renameSync(release, manual);
    const args = [
      '--tag',
      TAG,
      '--zip',
      path.join(manual, 'projectman-motor.zip'),
      '--manifest',
      path.join(manual, 'projectman-motor.json'),
    ];
    const refused = install(args);
    expect(refused.stderr).toContain('REFUSED [attestation_invalid]');
    expect(refused.calls.filter((call) => call.startsWith('curl '))).toEqual([]);
    expect(xattrCalls(refused.calls)).toEqual([]);

    env.FAKE_ATTEST_FAIL = '';
    const result = install(args);
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.at(-1)).toMatch(new RegExp(`^xattr -dr ${QUARANTINE} `));
  });
});
