import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const script = fs
  .readFileSync(new URL('../../../deploy/aws/host.sh', import.meta.url), 'utf8')
  .replace(/\nmain "\$@"\s*$/, '');
const sha = 'b'.repeat(40);
const old = 'a'.repeat(40);
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

function fixture(scenario: string, command = 'receive') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'image-host-'));
  const file = (name: string) => path.join(directory, name);
  const config = JSON.stringify({
    os: scenario === 'os' ? 'windows' : 'linux',
    architecture: scenario === 'arch' ? 'amd64' : 'arm64',
    config: {
      Labels: { 'org.opencontainers.image.revision': scenario === 'label' ? old : sha },
      Env: [`PROJECTMAN_VERSION=${scenario === 'env' ? old : sha}`],
    },
  });
  const id = `sha256:${hash(config)}`;
  const configName = `${hash(config)}.json`;
  fs.writeFileSync(file(configName), config);
  fs.writeFileSync(
    file('manifest.json'),
    JSON.stringify([
      {
        Config: configName,
        RepoTags: [scenario === 'tags' ? `projectman-cloud:${old}` : `projectman-cloud:${sha}`],
        Layers: [],
      },
    ]),
  );
  const tar = spawnSync('tar', ['-cf', file('image.tar'), '-C', directory, 'manifest.json', configName]);
  expect(tar.status).toBe(0);
  const archive = fs.readFileSync(file('image.tar'));
  const log = file('calls');
  fs.writeFileSync(log, '');
  const tool = file('tools.cjs');
  fs.writeFileSync(
    tool,
    `
const fs = require('node:fs');
const crypto = require('node:crypto');
const [operation, ...args] = process.argv.slice(2);
if (operation === 'stat') console.log(fs.statSync(args.at(-1)).size);
if (operation === 'sha256sum') {
 const input = args.length ? fs.readFileSync(args.at(-1)) : fs.readFileSync(0);
 console.log(crypto.createHash('sha256').update(input).digest('hex') + '  input');
}
`,
  );
  const actual = JSON.stringify([
    {
      Id: scenario === 'inspect-id' ? `sha256:${'0'.repeat(64)}` : id,
      Os: 'linux',
      Architecture: scenario === 'inspect-arch' ? 'amd64' : 'arm64',
      Config: {
        Labels: { 'org.opencontainers.image.revision': scenario === 'inspect-label' ? old : sha },
        Env: [`PROJECTMAN_VERSION=${scenario === 'inspect-env' ? old : sha}`],
      },
    },
  ]);
  const host = [
    script,
    `STATE_DIR=${quote(directory)}`,
    `ETC_DIR=${quote(directory)}`,
    `DEPLOY_JSON=${quote(file('deploy.json'))}`,
    `ENV_FILE=${quote(file('cloud.env'))}`,
    `IMAGE_ENV=${quote(file('image.env'))}`,
    `uname() { echo ${['host', 'legacy-amd64'].includes(scenario) ? 'x86_64' : 'aarch64'}; }`,
    'flock() { return 0; }',
    `stat() { ${quote(process.execPath)} ${quote(tool)} stat "$@"; }`,
    `sha256sum() { ${quote(process.execPath)} ${quote(tool)} sha256sum "$@"; }`,
    `df() { echo ${scenario === 'disk' ? '1' : '99999999999'}; }`,
    `docker() {
      echo "docker $*" >>${quote(log)}
      if [ "$1" = info ]; then echo linux/arm64; return; fi
      if [ "$1" = load ]; then echo 'Loaded image'; return ${scenario === 'load' ? '1' : '0'}; fi
      if [ "$1" = image ] && [ "$2" = inspect ] && [ "$3" = -f ]; then ${scenario === 'collision' ? `echo sha256:${'0'.repeat(64)}; return` : 'return 1'}; fi
      if [ "$1" = image ] && [ "$2" = inspect ]; then echo ${quote(actual)}; return; fi
      if [ "$1" = inspect ]; then echo false; return; fi
      return 1
    }`,
    `systemctl() { echo "systemctl $*" >>${quote(log)}; if [ "$1" = is-active ]; then echo inactive; fi; }`,
    command === 'receive'
      ? `receive_image ${sha} linux/arm64 ${archive.length} ${scenario === 'hash' ? '0'.repeat(64) : hash(archive)} ${scenario === 'config-id' ? `sha256:${'0'.repeat(64)}` : id}`
      : `start ${sha} ${sha} ${command === 'legacy' ? '' : id}`,
  ].join('\n');
  fs.writeFileSync(file('cloud.env'), 'FAKE_ENV=value\n');
  fs.writeFileSync(
    file('deploy.json'),
    JSON.stringify({
      current: {
        sha: old,
        ref: old,
        at: 'before',
        imageId: `sha256:${'2'.repeat(64)}`,
        platform: 'linux/arm64',
      },
    }),
  );
  const result = spawnSync('bash', ['-c', host], {
    input: scenario === 'truncated' ? archive.subarray(0, 10) : archive,
    encoding: 'utf8',
  });
  return {
    directory,
    file,
    id,
    result,
    calls: fs.readFileSync(log, 'utf8'),
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

describe('the real host image protocol with fake Docker and portable coreutils', () => {
  it('verifies and imports without starting a container, updating history or leaking Docker output', () => {
    const f = fixture('ok');
    try {
      expect(f.result.status, f.result.stderr).toBe(0);
      expect(f.result.stdout).toBe(
        JSON.stringify({ imageId: f.id, platform: 'linux/arm64', revision: sha }) + '\n',
      );
      expect(f.calls).toContain('docker load --input');
      expect(f.calls).not.toContain('systemctl');
      expect(JSON.parse(fs.readFileSync(f.file('deploy.json'), 'utf8')).current.sha).toBe(old);
      expect(
        fs.readdirSync(f.directory).filter((name) => name.startsWith('.image.') && name !== '.image.lock'),
      ).toEqual([]);
    } finally {
      f.cleanup();
    }
  });
  it.each([
    'host',
    'disk',
    'collision',
    'truncated',
    'hash',
    'tags',
    'config-id',
    'os',
    'arch',
    'label',
    'env',
    'load',
    'inspect-id',
    'inspect-arch',
    'inspect-label',
    'inspect-env',
  ])('refuses %s without start and removes its temporary stream', (scenario) => {
    const f = fixture(scenario);
    try {
      expect(f.result.status).toBe(['host', 'disk', 'collision'].includes(scenario) ? 3 : 1);
      expect(f.result.stdout).toBe('');
      expect(f.calls).not.toContain('systemctl');
      if (!scenario.startsWith('inspect') && scenario !== 'load')
        expect(f.calls).not.toContain('docker load');
      expect(
        fs.readdirSync(f.directory).filter((name) => name.startsWith('.image.') && name !== '.image.lock'),
      ).toEqual([]);
    } finally {
      f.cleanup();
    }
  });
  it('starts an immutable ID and records the current and previous digests', () => {
    const f = fixture('ok', 'start');
    try {
      expect(f.result.status, f.result.stderr).toBe(0);
      expect(fs.readFileSync(f.file('image.env'), 'utf8')).toBe(`IMAGE=${f.id}\n`);
      const deploy = JSON.parse(fs.readFileSync(f.file('deploy.json'), 'utf8'));
      expect(deploy.current).toMatchObject({ sha, imageId: f.id, platform: 'linux/arm64' });
      expect(deploy.previous).toMatchObject({ sha: old, imageId: `sha256:${'2'.repeat(64)}` });
      expect(f.calls).toContain('systemctl start projectman-cloud');
    } finally {
      f.cleanup();
    }
  });
  it('keeps legacy amd64 history and tag-based start compatible', () => {
    const f = fixture('legacy-amd64', 'legacy');
    try {
      expect(f.result.status, f.result.stderr).toBe(0);
      expect(fs.readFileSync(f.file('image.env'), 'utf8')).toBe(`IMAGE=projectman-cloud:${sha}\n`);
      expect(JSON.parse(fs.readFileSync(f.file('deploy.json'), 'utf8')).current).toEqual({
        sha,
        ref: sha,
        at: expect.any(String),
      });
    } finally {
      f.cleanup();
    }
  });
  it.each(['legacy', 'inspect-id', 'inspect-arch', 'inspect-label', 'inspect-env'])(
    'does not stop the running unit for invalid pinned start %s',
    (scenario) => {
      const f = fixture(scenario, scenario === 'legacy' ? 'legacy' : 'start');
      try {
        expect(f.result.status).toBe(scenario === 'legacy' ? 3 : 1);
        expect(f.calls).not.toContain('systemctl stop');
        expect(f.calls).not.toContain('systemctl start');
        expect(fs.existsSync(f.file('image.env'))).toBe(false);
      } finally {
        f.cleanup();
      }
    },
  );
});
