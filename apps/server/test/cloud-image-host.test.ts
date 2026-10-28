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
const classicStore = JSON.stringify({ Driver: 'overlay2', DriverStatus: [['Backing Filesystem', 'extfs']] });
const containerdStore = JSON.stringify({
  Driver: 'overlayfs',
  DriverStatus: [['driver-type', 'io.containerd.snapshotter.v1']],
});

interface BootstrapOptions {
  installed?: boolean;
  jqInstalled?: boolean;
  config?: string;
  configKind?: 'symlink' | 'directory';
  history?: string;
  unit?: string;
  container?: string;
  containerQueryError?: boolean;
  restartError?: boolean;
  afterStore?: string;
}

function fixture(scenario: string, command = 'receive', bootstrap: BootstrapOptions = {}) {
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
      Os: scenario === 'inspect-os' ? 'windows' : 'linux',
      Architecture: scenario === 'inspect-arch' ? 'amd64' : 'arm64',
      Config: {
        Labels: { 'org.opencontainers.image.revision': scenario === 'inspect-label' ? old : sha },
        Env: [`PROJECTMAN_VERSION=${scenario === 'inspect-env' ? old : sha}`],
      },
    },
  ]);
  const store =
    {
      'store-containerd': containerdStore,
      'store-marker': JSON.stringify({
        Driver: 'overlay2',
        DriverStatus: [['driver-type', 'io.containerd.snapshotter.v1']],
      }),
      'store-other': JSON.stringify({ Driver: 'vfs', DriverStatus: [] }),
      'store-invalid': '{',
      'store-null': 'null',
      'store-empty': '',
      'store-missing': JSON.stringify({ Driver: 'overlay2' }),
      'store-bad-status': JSON.stringify({ Driver: 'overlay2', DriverStatus: [['driver-type']] }),
      'store-multiple': classicStore + '\n' + classicStore,
    }[scenario] ?? classicStore;
  fs.writeFileSync(file('store'), store);
  if (bootstrap.installed !== false) fs.writeFileSync(file('installed'), '');
  if (bootstrap.jqInstalled !== false) fs.writeFileSync(file('jq-installed'), '');
  fs.writeFileSync(file('fstab'), `${file('swapfile')} none swap sw 0 0\n`);
  fs.mkdirSync(file('data'));
  fs.writeFileSync(file('data/preserved'), 'board data');
  fs.mkdirSync(file('docker'));
  if (bootstrap.config !== undefined) fs.writeFileSync(file('docker/daemon.json'), bootstrap.config);
  if (bootstrap.configKind === 'symlink') {
    fs.writeFileSync(file('config-target'), bootstrap.config ?? 'untouched');
    fs.rmSync(file('docker/daemon.json'), { force: true });
    fs.symlinkSync(file('config-target'), file('docker/daemon.json'));
  }
  if (bootstrap.configKind === 'directory') fs.mkdirSync(file('docker/daemon.json'));
  const host = [
    script.replaceAll('/swapfile', file('swapfile')).replaceAll('/etc/fstab', file('fstab')),
    `STATE_DIR=${quote(directory)}`,
    `ETC_DIR=${quote(directory)}`,
    `DEPLOY_JSON=${quote(file('deploy.json'))}`,
    `ENV_FILE=${quote(file('cloud.env'))}`,
    `IMAGE_ENV=${quote(file('image.env'))}`,
    `DATA_DIR=${quote(file('data'))}`,
    `UNIT_FILE=${quote(file('unit.service'))}`,
    `DOCKER_DIR=${quote(file('docker'))}`,
    `DOCKER_CONFIG=${quote(file('docker/daemon.json'))}`,
    `uname() { echo ${['host', 'legacy-amd64'].includes(scenario) ? 'x86_64' : 'aarch64'}; }`,
    `flock() { echo "flock $*" >>${quote(log)}; }`,
    `stat() { ${quote(process.execPath)} ${quote(tool)} stat "$@"; }`,
    `sha256sum() { ${quote(process.execPath)} ${quote(tool)} sha256sum "$@"; }`,
    `df() { echo ${scenario === 'disk' ? '1' : '99999999999'}; }`,
    `docker() {
      echo "docker $*" >>${quote(log)}
      if [ "$1" = info ]; then
        if [ "$3" = '{{json .}}' ]; then
          ${scenario === 'store-info-error' ? 'return 1' : `cat ${quote(file('store'))}; return`}
        fi
        echo linux/arm64; return
      fi
      if [ "$1" = --version ]; then echo 'Docker fake'; return; fi
      if [ "$1" = container ]; then echo ${quote(bootstrap.container ?? 'exited')}; return ${bootstrap.containerQueryError ? '1' : '0'}; fi
      if [ "$1" = load ]; then echo 'Loaded image'; return ${scenario === 'load' ? '1' : '0'}; fi
      if [ "$1" = image ] && [ "$2" = inspect ] && [ "$3" = -f ]; then ${scenario === 'collision' ? `echo sha256:${'0'.repeat(64)}; return` : 'return 1'}; fi
      if [ "$1" = image ] && [ "$2" = inspect ]; then echo ${quote(actual)}; return; fi
      if [ "$1" = inspect ]; then echo ${bootstrap.container === 'running' ? 'true' : 'false'}; return; fi
      return 1
    }`,
    `systemctl() {
      echo "systemctl $*" >>${quote(log)}
      if [ "$1" = is-active ]; then echo ${quote(bootstrap.unit ?? 'inactive')}; fi
      if [ "$*" = 'restart docker' ]; then
        ${bootstrap.restartError ? 'return 1' : `echo ${quote(bootstrap.afterStore ?? classicStore)} >${quote(file('store'))}`}
      fi
      return 0
    }`,
    `dpkg() {
      case "$2" in
        jq) [ -f ${quote(file('jq-installed'))} ] ;;
        docker.io|docker-buildx) [ -f ${quote(file('installed'))} ] ;;
        *) return 0 ;;
      esac
    }`,
    // Keep an installed host Docker daemon outside the fixture invisible.
    `command() { if [ "$*" = '-v dockerd' ]; then return 1; fi; builtin command "$@"; }`,
    `apt-get() {
      echo "apt-get $*" >>${quote(log)}
      if [ "$1" = install ]; then
        case " $* " in
          *' jq '*) touch ${quote(file('jq-installed'))} ;;
        esac
        case " $* " in
          *' docker.io '*)
            [ -f ${quote(file('jq-installed'))} ] || die 'jq not installed before Docker'
            jq -e '.features["containerd-snapshotter"] == false' "$DOCKER_CONFIG" >/dev/null || die 'store not configured before Docker installation'
            touch ${quote(file('installed'))}
            echo ${quote(bootstrap.afterStore ?? classicStore)} >${quote(file('store'))}
            ;;
        esac
      fi
    }`,
    `chown() { echo "chown $*" >>${quote(log)}; }`,
    `swapon() { echo ${quote(file('swapfile'))}; }`,
    ...(command.startsWith('bootstrap')
      ? ["bootstrap <<<'[Service]'", ...(command === 'bootstrap-repeat' ? ["bootstrap <<<'[Service]'"] : [])]
      : []),
    ...(command === 'receive' || command === 'bootstrap-deploy'
      ? [
          `receive_image ${sha} linux/arm64 ${archive.length} ${scenario === 'hash' ? '0'.repeat(64) : hash(archive)} ${scenario === 'config-id' ? `sha256:${'0'.repeat(64)}` : id} <${quote(file('image.tar'))}`,
        ]
      : []),
    ...((!command.startsWith('bootstrap') && command !== 'receive') || command === 'bootstrap-deploy'
      ? [`start ${sha} ${sha} ${command === 'legacy' ? '' : id}`]
      : []),
  ].join('\n');
  fs.writeFileSync(file('cloud.env'), 'FAKE_ENV=value\n');
  if (!command.startsWith('bootstrap')) {
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
  } else if (bootstrap.history !== undefined) fs.writeFileSync(file('deploy.json'), bootstrap.history);
  if (scenario === 'truncated') fs.writeFileSync(file('image.tar'), archive.subarray(0, 10));
  if (scenario === 'oversized') fs.appendFileSync(file('image.tar'), 'extra');
  const result = spawnSync('bash', ['-c', host], {
    input: archive,
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
  it.each(['receive', 'start', 'legacy'])(
    'rejects unsupported or unreadable stores before any %s side effect',
    (command) => {
      for (const scenario of [
        'store-containerd',
        'store-marker',
        'store-other',
        'store-info-error',
        'store-invalid',
        'store-null',
        'store-empty',
        'store-missing',
        'store-bad-status',
        'store-multiple',
      ]) {
        const f = fixture(scenario, command);
        try {
          const unsupported = ['store-containerd', 'store-marker', 'store-other'].includes(scenario);
          expect(f.result.status, `${scenario}: ${f.result.stderr}`).toBe(unsupported ? 3 : 1);
          expect(f.result.stderr).toContain(
            unsupported ? 'classic Docker image store required' : 'Docker daemon image store',
          );
          expect(f.result.stdout).toBe('');
          expect(f.calls).not.toMatch(/docker (load|image|inspect)|systemctl/);
          expect(f.calls.indexOf('flock -x 9')).toBeLessThan(f.calls.indexOf('docker info'));
          expect(fs.existsSync(f.file('image.env'))).toBe(false);
          expect(JSON.parse(fs.readFileSync(f.file('deploy.json'), 'utf8')).current.sha).toBe(old);
          expect(fs.readdirSync(f.directory).filter((name) => name.startsWith('.image.'))).toEqual([
            '.image.lock',
          ]);
        } finally {
          f.cleanup();
        }
      }
    },
  );
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
    'oversized',
    'hash',
    'tags',
    'config-id',
    'os',
    'arch',
    'label',
    'env',
    'load',
    'inspect-id',
    'inspect-os',
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
  it.each(['legacy', 'inspect-id', 'inspect-os', 'inspect-arch', 'inspect-label', 'inspect-env'])(
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

describe('host bootstrap prepares the classic Docker image store', () => {
  it('installs jq and configures the store before apt can first start Docker', () => {
    const f = fixture('ok', 'bootstrap', { installed: false, jqInstalled: false });
    try {
      expect(f.result.status, f.result.stderr).toBe(0);
      expect(f.calls.indexOf('install -y -qq --no-install-recommends jq')).toBeLessThan(
        f.calls.indexOf('chown root:root'),
      );
      expect(f.calls.indexOf('chown root:root')).toBeLessThan(
        f.calls.indexOf('install -y -qq --no-install-recommends docker.io'),
      );
      expect(fs.readFileSync(f.file('docker/daemon.json'), 'utf8')).toBe(
        '{"features":{"containerd-snapshotter":false}}\n',
      );
      expect(fs.statSync(f.file('docker/daemon.json')).mode & 0o777).toBe(0o644);
      expect(f.calls).not.toContain('restart docker');
      expect(f.calls).toContain('docker info --format {{json .}}');
    } finally {
      f.cleanup();
    }
  });

  it('preserves unrelated config and data, restarts once, then imports and starts the config digest', () => {
    const config = { 'log-level': 'info', features: { other: true, 'containerd-snapshotter': true } };
    const f = fixture('store-containerd', 'bootstrap-deploy', { config: JSON.stringify(config) });
    try {
      expect(f.result.status, f.result.stderr).toBe(0);
      expect(JSON.parse(fs.readFileSync(f.file('docker/daemon.json'), 'utf8'))).toEqual({
        ...config,
        features: { ...config.features, 'containerd-snapshotter': false },
      });
      expect(f.calls.match(/systemctl restart docker/g)).toHaveLength(1);
      expect(f.calls.indexOf('systemctl restart docker')).toBeLessThan(f.calls.indexOf('docker load'));
      expect(fs.readFileSync(f.file('image.env'), 'utf8')).toBe(`IMAGE=${f.id}\n`);
      expect(JSON.parse(fs.readFileSync(f.file('deploy.json'), 'utf8')).current.imageId).toBe(f.id);
      expect(fs.readFileSync(f.file('data/preserved'), 'utf8')).toBe('board data');
    } finally {
      f.cleanup();
    }
  });

  it.each([undefined, '{"features":{"containerd-snapshotter":false}}'])(
    'restarts an actual containerd store only once across two bootstraps (config %s)',
    (config) => {
      const f = fixture('store-containerd', 'bootstrap-repeat', { config });
      try {
        expect(f.result.status, f.result.stderr).toBe(0);
        expect(f.calls.match(/systemctl restart docker/g)).toHaveLength(1);
        expect(fs.readdirSync(f.file('docker'))).toEqual(['daemon.json']);
      } finally {
        f.cleanup();
      }
    },
  );

  it('does not restart a classic daemon even with a running board and retained history', () => {
    const f = fixture('ok', 'bootstrap-repeat', {
      unit: 'active',
      history: '{"current":{"sha":"old"}}',
      config: '{"debug":false}',
    });
    try {
      expect(f.result.status, f.result.stderr).toBe(0);
      expect(f.calls).not.toContain('restart docker');
      expect(JSON.parse(fs.readFileSync(f.file('docker/daemon.json'), 'utf8'))).toEqual({
        debug: false,
        features: { 'containerd-snapshotter': false },
      });
      expect(fs.readFileSync(f.file('deploy.json'), 'utf8')).toBe('{"current":{"sha":"old"}}');
    } finally {
      f.cleanup();
    }
  });

  it.each<BootstrapOptions>([
    { unit: 'active' },
    { unit: 'activating' },
    { unit: 'deactivating' },
    { unit: '' },
    { container: 'running' },
    { container: 'restarting' },
    { history: '{"current":{"sha":"old"}}' },
    { history: '{"previous":{"sha":"old"}}' },
    { history: '{' },
  ])('refuses a store switch without changing config, history or Docker: %j', (options) => {
    const config = '{"features":{"containerd-snapshotter":true}}';
    const f = fixture('store-containerd', 'bootstrap', { config, ...options });
    try {
      expect(f.result.status, f.result.stderr).toBe(3);
      expect(fs.readFileSync(f.file('docker/daemon.json'), 'utf8')).toBe(config);
      if (options.history) expect(fs.readFileSync(f.file('deploy.json'), 'utf8')).toBe(options.history);
      expect(f.calls).not.toMatch(/chown|restart docker|apt-get|systemctl enable/);
      expect(fs.existsSync(f.file('unit.service'))).toBe(false);
    } finally {
      f.cleanup();
    }
  });

  it.each<BootstrapOptions>([
    { config: '{' },
    { config: '[]' },
    { config: '{}\n{}' },
    { config: '{"features":null}' },
    { config: '{"features":[]}' },
    { config: '{"features":true}' },
    { configKind: 'symlink' },
    { configKind: 'directory' },
  ])('preserves and refuses unsafe configuration: %j', (options) => {
    const f = fixture('store-containerd', 'bootstrap', options);
    try {
      expect(f.result.status, f.result.stderr).toBe(3);
      if (options.config) expect(fs.readFileSync(f.file('docker/daemon.json'), 'utf8')).toBe(options.config);
      if (options.configKind === 'symlink') {
        expect(fs.lstatSync(f.file('docker/daemon.json')).isSymbolicLink()).toBe(true);
        expect(fs.readFileSync(f.file('config-target'), 'utf8')).toBe('untouched');
      }
      if (options.configKind === 'directory')
        expect(fs.lstatSync(f.file('docker/daemon.json')).isDirectory()).toBe(true);
      expect(f.calls).not.toMatch(/chown|restart docker|systemctl enable/);
      expect(fs.readdirSync(f.file('docker'))).toEqual(['daemon.json']);
    } finally {
      f.cleanup();
    }
  });

  it.each([
    ['store-info-error', {}, 1],
    ['store-invalid', {}, 1],
    ['store-containerd', { containerQueryError: true }, 1],
    ['store-containerd', { restartError: true }, 1],
    ['store-containerd', { afterStore: '{' }, 1],
    ['store-containerd', { afterStore: containerdStore }, 3],
    ['ok', { installed: false, afterStore: containerdStore }, 3],
  ] as const)('stops on daemon failure or ineffective configuration: %s %j', (scenario, options, code) => {
    const f = fixture(scenario, 'bootstrap-deploy', options);
    try {
      expect(f.result.status, f.result.stderr).toBe(code);
      expect(f.calls).not.toMatch(/docker load|systemctl start projectman-cloud|systemctl daemon-reload/);
      expect(fs.existsSync(f.file('unit.service'))).toBe(false);
      expect(fs.existsSync(f.file('image.env'))).toBe(false);
    } finally {
      f.cleanup();
    }
  });
});
