import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HOST_SUBCOMMANDS } from '../../../scripts/cloud/host';

/**
 * The files for the EC2 machine (PM-535, docs/AWS.md) cannot run in the test environment (no Ubuntu, no
 * Docker, no systemd). What is checked: the script parses, the unit and the script keep the container closed
 * (no published port, no host network, no extra privilege, no Docker socket), the image id is checked, and the
 * subcommands the client calls exist in the script.
 */

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const hostScript = read('deploy/aws/host.sh');
const unit = read('deploy/aws/projectman-cloud.service');

function shellFunction(source: string, name: string): string {
  const start = source.indexOf(`\n${name}() {`);
  if (start < 0) throw new Error(`no function ${name}`);
  const end = source.indexOf('\n}\n', start);
  return source.slice(start + 1, end + 2);
}

const withoutComments = (source: string) =>
  source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');

describe('deploy/aws/host.sh', () => {
  it.each(['legacy', 'isolated', 'wrong-code', 'machine-open', 'ws-open', 'unavailable'])(
    'probes the running integrator boundary with a %s backend',
    (scenario) => {
      const fixture = `
CONTAINER=fixture
board_running() { return 0; }
die() { exit 1; }
refuse() { exit 2; }
docker() {
  case "$*" in
    *pmi_boundary_probe*)
      if [ '${scenario}' = unavailable ]; then return 1; fi
      if [ '${scenario}' = wrong-code ]; then printf '{"error":{"code":"integrator_key_invalid"}}\\n403';
      else printf '{"error":{"code":"integrator_host_required"}}\\n403'; fi ;;
    */api/setup) printf '{"publicBoard":true,"emailLoginEnabled":true,"needsSetup":false}' ;;
    */api/auth/login) printf 403 ;;
    */ws) if [ '${scenario}' = ws-open ]; then printf 200; else printf 404; fi ;;
    */api/projects) if [ '${scenario}' = machine-open ]; then printf 200; else printf 401; fi ;;
    *) printf 401 ;;
  esac
}
${shellFunction(hostScript, 'public_check')}
public_check board.example.com ${scenario === 'legacy' ? '' : 'machine.example.com'}
`;
      const result = spawnSync('bash', ['-c', fixture], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH },
      });
      expect(result.status, result.stderr).toBe(0);
      const answer = JSON.parse(result.stdout);
      expect(answer).toMatchObject({
        publicBoard: true,
        emailLoginEnabled: true,
        needsSetup: false,
        apiStatus: 401,
        crossOriginStatus: 403,
      });
      if (scenario === 'legacy') expect(answer).not.toHaveProperty('integratorHostIsolated');
      else expect(answer.integratorHostIsolated).toBe(scenario === 'isolated');
    },
  );

  it('keeps the data size when du fails because a file vanished during the walk', () => {
    const fixture = `
set -euo pipefail
du() {
  echo "du: cannot access '$2/ltx/0/x.ltx.tmp': No such file or directory" >&2
  printf '4096\\t%s\\n' "$2"
  return 1
}
${shellFunction(hostScript, 'data_size_bytes')}
data_bytes=$(data_size_bytes /data)
echo "$data_bytes"
`;
    const result = spawnSync('bash', ['-c', fixture], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('4096');
  });

  it.each(['deploy/aws/host.sh', 'deploy/cloudflare/check.sh'])('%s parses', (file) => {
    const result = spawnSync('bash', ['-n', join(root, file)], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('is executable, strict and small enough to travel as one ssh argument', () => {
    expect(statSync(join(root, 'deploy/aws/host.sh')).mode & 0o111).not.toBe(0);
    expect(hostScript.split('\n')[0]).toBe('#!/usr/bin/env bash');
    expect(hostScript).toMatch(/^set -euo pipefail$/m);
    expect(Buffer.byteLength(hostScript)).toBeLessThan(90_000);
  });

  it('has a branch for every subcommand the client calls, and refuses others', () => {
    const main = shellFunction(hostScript, 'main');
    for (const subcommand of HOST_SUBCOMMANDS) expect(main).toContain(`${subcommand})`);
    expect(main).toMatch(/\*\) +die/);
  });

  it('runs docker without a published port, a host network, privilege or the Docker socket', () => {
    const dockerLines = withoutComments(hostScript)
      .split('\n')
      .filter((line) => /\bdocker\b/.test(line));
    expect(dockerLines.length).toBeGreaterThan(5);
    for (const line of dockerLines) {
      expect(line).not.toMatch(/\s(-p|--publish|--publish-all|-P)\b/);
      expect(line).not.toMatch(/--network|--net\b|--privileged|--cap-add|--pid|--userns|--device/);
      expect(line).not.toMatch(/docker\.sock/);
      expect(line).not.toMatch(/\s-v\s|--volume|--mount/);
    }
    expect(withoutComments(hostScript)).not.toMatch(/docker\.sock/);
  });

  it('the rehearsal publishes nothing and mounts nothing', () => {
    const rehearsal = shellFunction(hostScript, 'rehearse');
    expect(rehearsal).toContain('docker run --rm');
    expect(rehearsal).toContain('REHEARSAL_PORT=');
    expect(rehearsal).not.toMatch(/\s-p\s|\s-v\s|--network|--publish/);
  });

  it('takes only an arm64 image by its ID: no host build, no amd64 branch', () => {
    const script = withoutComments(hostScript);
    expect(shellFunction(hostScript, 'check_sha')).toContain('[0-9a-f]{40}');
    expect(shellFunction(hostScript, 'start')).toContain('requires a recorded image ID');
    expect(script).not.toMatch(/amd64|x86_64|buildx build/);
    for (const retired of ['build', 'seed-digest', 'receive-data'])
      expect(HOST_SUBCOMMANDS).not.toContain(retired);
  });

  it('keeps no secret in the script and writes the environment file for root only', () => {
    expect(hostScript).not.toMatch(/AKIA|SECRET_ACCESS_KEY=|TUNNEL_TOKEN=|RESTIC_PASSWORD=/);
    const receive = shellFunction(hostScript, 'receive_env');
    expect(receive).toContain('-m 600');
    expect(receive).toContain('-o root');
  });

  it('refuses to send the data of a running board', () => {
    expect(shellFunction(hostScript, 'send_data')).toContain('board_running');
  });
});

describe('deploy/aws/projectman-cloud.service', () => {
  const settings = withoutComments(unit);

  it('runs the image of image.env with the environment file and only the data directory', () => {
    expect(settings).toContain('EnvironmentFile=/etc/projectman/image.env');
    expect(settings).toContain('--env-file /etc/projectman/cloud.env');
    expect(settings).toContain('-v /var/lib/projectman/data:/data');
    expect(settings).toContain('${IMAGE}');
    expect(settings).toContain('Restart=always');
    expect(settings).toContain('RestartSec=5');
    expect(settings).toContain('TimeoutStopSec=75');
    expect(settings).toContain('docker stop -t 60 projectman-cloud');
    expect(settings).toContain('WantedBy=multi-user.target');
  });

  it('publishes no port and gives the container no host network or privilege', () => {
    expect(settings).not.toMatch(/\s(-p|--publish|-P)\b/);
    expect(settings).not.toMatch(/--network|--privileged|--cap-add|--pid|--userns|--device|docker\.sock/);
    expect(settings.match(/\s-v\s/g)).toHaveLength(1);
  });

  it('holds no secret', () => {
    expect(unit).not.toMatch(/AKIA|SECRET|TOKEN=|PASSWORD=/);
  });
});

/** `env-check` and `prune-images` of the deploy from a GitHub Actions job (PM-1197), run with stubbed docker and flock. */
describe('deploy/aws/host.sh env-check and prune-images', () => {
  const requiredNames = hostScript.split('\n').find((line) => line.startsWith('REQUIRED_ENV_NAMES='))!;
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'host-sh-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const bash = (fixture: string) =>
    spawnSync('bash', ['-c', `set -euo pipefail\n${fixture}`], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    });
  const common = `
die() { echo "host.sh: $*" >&2; exit 1; }
refuse() { echo "host.sh: refused: $*" >&2; exit 3; }
`;
  const envCheck = (envText: string | null) => {
    const file = join(dir, 'cloud.env');
    if (envText !== null) writeFileSync(file, envText);
    return bash(
      `${common}ENV_FILE='${file}'\n${requiredNames}\n${shellFunction(hostScript, 'env_check')}\nenv_check`,
    );
  };
  const COMPLETE =
    'LITESTREAM_BUCKET=b\nLITESTREAM_ACCESS_KEY_ID=k\nRESTIC_REPOSITORY=r\nRESTIC_PASSWORD=secret-value\n';

  it('env-check answers the names of cloud.env, never a value', () => {
    const result = envCheck(COMPLETE);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual([
      'LITESTREAM_BUCKET',
      'LITESTREAM_ACCESS_KEY_ID',
      'RESTIC_REPOSITORY',
      'RESTIC_PASSWORD',
    ]);
    expect(result.stdout).not.toContain('secret-value');
  });

  it.each([
    ['there is no cloud.env', null],
    ['a name has no value', COMPLETE.replace('RESTIC_PASSWORD=secret-value', 'RESTIC_PASSWORD=')],
    ['a name is missing', COMPLETE.replace('LITESTREAM_BUCKET=b\n', '')],
  ])('env-check refuses with env_missing when %s', (_label, envText) => {
    const result = envCheck(envText);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('env_missing');
    expect(result.stderr).not.toContain('secret-value');
  });

  const SHA = (digit: string) => digit.repeat(40);
  const prune = (deploy: object | null, tags: string[]) => {
    if (deploy) writeFileSync(join(dir, 'deploy.json'), JSON.stringify(deploy));
    const fixture = `${common}
STATE_DIR='${dir}'; STAGE_ROOT="$STATE_DIR/.stage"; DEPLOY_JSON="$STATE_DIR/deploy.json"; IMAGE_REPO=projectman-cloud
mkdir -p "$STAGE_ROOT"
flock() { :; }
require_classic_docker_store() { :; }
docker() {
  case "$1" in
    image) printf '%s\\n' ${tags.map((tag) => `'${tag}'`).join(' ')} ;;
    rmi) echo "$2" >> "$STATE_DIR/rmi.log" ;;
  esac
}
${shellFunction(hostScript, 'read_deploy')}
${shellFunction(hostScript, 'prune_images')}
prune_images`;
    return bash(fixture);
  };
  const removedLog = () =>
    existsSync(join(dir, 'rmi.log')) ? readFileSync(join(dir, 'rmi.log'), 'utf8').trim().split('\n') : [];

  it('prune-images removes every projectman-cloud commit image except the current and the previous one', () => {
    const deploy = { current: { sha: SHA('c') }, previous: { sha: SHA('b') } };
    const result = prune(deploy, [SHA('c'), SHA('b'), SHA('a'), SHA('d'), 'latest']);
    expect(result.status, result.stderr).toBe(0);
    expect(removedLog()).toEqual([`projectman-cloud:${SHA('a')}`, `projectman-cloud:${SHA('d')}`]);
    expect(JSON.parse(result.stdout)).toEqual({ removed: [SHA('a'), SHA('d')], kept: [SHA('c'), SHA('b')] });
    expect(existsSync(join(dir, '.stage'))).toBe(false);
  });

  it('prune-images with nothing to remove still answers an empty list', () => {
    const result = prune({ current: { sha: SHA('c') }, previous: null }, [SHA('c')]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ removed: [], kept: [SHA('c')] });
  });

  it('prune-images refuses, and removes nothing, when no deploy is recorded', () => {
    const result = prune(null, [SHA('a')]);
    expect(result.status).toBe(3);
    expect(removedLog()).toEqual([]);
  });
});

describe('the build argument', () => {
  it('the Dockerfile comment and the guide pass the full commit id, not the short one', () => {
    expect(read('deploy/cloud/Dockerfile')).not.toContain('--short');
    expect(read('docs/HYBRID.md')).not.toContain('--short');
    expect(read('docs/HYBRID.md')).toContain('PROJECTMAN_VERSION=$(git rev-parse HEAD)');
  });
});
