import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  evaluateVmReadiness,
  VM_CHECKS,
  VM_PROFILE_NAME,
  VM_PROFILE_VERSION,
  VmReadinessReport,
} from '@projectman/shared';

/**
 * The managed VM profile's files (PM-137) can only be run on a Linux guest, and that is done by
 * hand (docs/VM.md). What is checked here: the pieces agree with each other and with the shared
 * contract, the shell scripts parse, the report the helpers write is the one the contract
 * accepts, and the verdict command works. Nothing here starts a VM or touches the machine.
 */

const root = fileURLToPath(new URL('../../../', import.meta.url));
const vmDir = join(root, 'deploy/vm');
const scripts = readdirSync(vmDir).filter((name) => name.endsWith('.sh'));
const temp: string[] = [];

afterEach(() => {
  while (temp.length) rmSync(temp.pop()!, { recursive: true, force: true });
});

function read(path: string): string {
  return readFileSync(join(root, path), 'utf8');
}

/** KEY=value lines of profile.env; a double-quoted value loses its quotes. */
type ProfileKey =
  | 'PROFILE_NAME'
  | 'PROFILE_VERSION'
  | 'SERVICE_USER'
  | 'SERVICE_UID'
  | 'SERVICE_HOME'
  | 'PROJECTMAN_HOME'
  | 'APP_DIR'
  | 'APP_PORT'
  | 'SSH_PORT'
  | 'ALLOWED_PUBLIC_TCP'
  | 'WORKER_UID_MIN'
  | 'WORKER_UID_MAX'
  | 'CLI_PREFIX'
  | 'NODE_MAJOR'
  | 'NODE_MIN'
  | 'NODE_VERSION'
  | 'CLAUDE_CLI_VERSION'
  | 'CODEX_CLI_VERSION';

function profile(): Record<ProfileKey, string> {
  const values: Record<string, string> = {};
  for (const line of read('deploy/vm/profile.env').split('\n')) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line);
    if (match) values[match[1]!] = match[2]!.replace(/^"(.*)"$/, '$1');
  }
  // A key the file lacks fails the test that asks for it, not the compiler.
  return new Proxy(values as Record<ProfileKey, string>, {
    get: (target, key) => {
      if (typeof key === 'string' && !(key in target)) throw new Error(`profile.env has no ${key}`);
      return Reflect.get(target, key);
    },
  });
}

function bash(script: string, args: string[] = [], env: Record<string, string> = {}) {
  return spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', ...env },
  });
}

describe('profile, units and rules agree', () => {
  const p = profile();

  it('carries the contract version and name of the shared module', () => {
    expect(p.PROFILE_NAME).toBe(VM_PROFILE_NAME);
    expect(Number(p.PROFILE_VERSION)).toBe(VM_PROFILE_VERSION);
  });

  it('names the confined uids the same way in the egress rules', () => {
    const nft = read('deploy/vm/projectman-gate.nft');
    expect(nft).toContain(
      `meta skuid { ${p.SERVICE_UID}, ${p.WORKER_UID_MIN}-${p.WORKER_UID_MAX} } jump worker_egress`,
    );
    expect(Number(p.SERVICE_UID)).toBeLessThan(Number(p.WORKER_UID_MIN));
  });

  it('keeps the SSH port of the rules and the profile together', () => {
    expect(read('deploy/vm/projectman-gate.nft')).toContain(`tcp dport ${p.SSH_PORT} accept`);
    expect(p.ALLOWED_PUBLIC_TCP.split(' ')).toContain(p.SSH_PORT);
  });

  it('runs the service as the profile account, from the profile paths, on loopback', () => {
    const unit = read('deploy/projectman.service');
    expect(unit).toContain(`User=${p.SERVICE_USER}`);
    expect(unit).toContain(`WorkingDirectory=${p.APP_DIR}`);
    expect(unit).toContain(`Environment=HOME=${p.SERVICE_HOME}`);
    expect(unit).toContain(`Environment=PROJECTMAN_HOME=${p.PROJECTMAN_HOME}`);
    expect(unit).toContain(`Environment=PORT=${p.APP_PORT}`);
    expect(unit).toContain('Environment=HOST=127.0.0.1');
    expect(unit).toContain(`${p.CLI_PREFIX}/bin`);
    expect(unit).toContain('After=network-online.target projectman-gate.service');
    for (const setting of [
      'NoNewPrivileges=true',
      'PrivateTmp=true',
      'RestrictSUIDSGID=true',
      'CapabilityBoundingSet=\n',
    ]) {
      expect(unit).toContain(setting);
    }
  });

  it('closes all non-loopback IPv6, and the Tailscale socket directory, for the confined accounts', () => {
    const nft = read('deploy/vm/projectman-gate.nft');
    expect(nft).toContain('ip6 daddr ::1 accept');
    expect(nft).toMatch(/meta nfproto ipv6 reject with icmpx type admin-prohibited/);
    const bootstrap = read('deploy/vm/bootstrap.sh');
    expect(bootstrap).toContain('RuntimeDirectoryMode=0700');
    expect(bootstrap).toContain('tailscaled.service.d');
    const verify = read('deploy/vm/verify.sh');
    expect(verify).toContain('/run/tailscale/tailscaled.sock');
    expect(verify).toContain('guest_global_ipv6');
    expect(verify).toContain('PROBE_IPV6_PUBLIC');
    expect(read('deploy/projectman.service')).toContain('AF_NETLINK');
  });

  it('pins an exact Node release of the pinned major', () => {
    expect(p.NODE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(p.NODE_VERSION.startsWith(`${p.NODE_MAJOR}.`)).toBe(true);
  });

  it('pins every version and never gives an account sudo or an API key', () => {
    expect(p.CLAUDE_CLI_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(p.CODEX_CLI_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(p.NODE_MIN.startsWith(`${p.NODE_MAJOR}.`)).toBe(true);
    for (const name of [...scripts, 'profile.env', 'projectman-gate.nft', 'cloud-init.yaml']) {
      const text = readFileSync(join(vmDir, name), 'utf8');
      expect(text, name).not.toMatch(/NOPASSWD|sudoers|ANTHROPIC_API_KEY|OPENAI_API_KEY|CODEX_API_KEY/);
    }
  });

  it('does not share anything of the Mac with the VM', () => {
    const mac = read('deploy/vm/mac-multipass.sh');
    expect(mac).not.toMatch(/multipass\s+(mount|set)/);
    expect(mac).not.toMatch(/ForwardAgent=yes|\s-A\s/);
    expect(mac).toContain('ForwardAgent=no');
    expect(mac).toContain('primary|debian-vm');
  });
});

describe('the shell scripts', () => {
  it.each(scripts)('%s parses', (name) => {
    const result = spawnSync('bash', ['-n', join(vmDir, name)], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('verify.sh measures every check of the contract', () => {
    const verify = read('deploy/vm/verify.sh');
    for (const check of VM_CHECKS)
      expect(verify, check.id).toMatch(new RegExp(`(record|check_cli) "?${check.id}\\b|\\b${check.id}\\b`));
  });

  it('verify.sh refuses to run without root, and without an installed profile', () => {
    if (process.getuid?.() === 0) return;
    const result = bash(join(vmDir, 'verify.sh'));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('must run as root');
  });

  it('bootstrap.sh needs root, a worker list and an existing admin', () => {
    if (process.getuid?.() === 0) return;
    const result = bash(join(vmDir, 'bootstrap.sh'), ['--workers', 'a b']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('must run as root');
  });
});

describe('the report the shell helpers write', () => {
  function emit(body: string): unknown {
    const result = spawnSync(
      'bash',
      [
        '-c',
        `. "${join(vmDir, 'lib.sh')}"\n${body}\nemit_report ${VM_PROFILE_NAME} ${VM_PROFILE_VERSION} 'Ubuntu 24.04' '6.8.0' aarch64`,
      ],
      { encoding: 'utf8' },
    );
    expect(result.stderr).toBe('');
    return JSON.parse(result.stdout);
  }

  it('is accepted by the contract, with hostile evidence text escaped', () => {
    const lines = VM_CHECKS.map((check) => `record ${check.id} pass 'measured "${check.id}" \\ with a	tab'`);
    lines.push(`record extra fail "line one
line two $(printf '\\001\\302\\251')"`);
    const parsed = VmReadinessReport.parse(emit(lines.join('\n')));
    expect(parsed.checks).toHaveLength(VM_CHECKS.length + 1);
    expect(parsed.checks[0]!.evidence).toBe('measured "os" \\ with a tab');
    expect(parsed.checks.at(-1)!.evidence).toBe('line one line two ');
    const required = VM_CHECKS.filter((check) => check.required).length;
    expect(required).toBeGreaterThan(0);
    expect(evaluateVmReadiness(parsed).ready).toBe(true);
  });

  it('turns an empty evidence into text and caps a long one', () => {
    const parsed = VmReadinessReport.parse(emit(`record os pass ''\nrecord node fail "${'x'.repeat(900)}"`));
    expect(parsed.checks[0]!.evidence).toBe('(no detail)');
    expect(parsed.checks[1]!.evidence).toHaveLength(500);
  });

  it('is not ready when verify.sh style output misses a check or fails one', () => {
    const lines = VM_CHECKS.filter((check) => check.id !== 'launcher').map(
      (check) => `record ${check.id} ${check.id === 'gate-control' ? 'fail' : 'pass'} ok`,
    );
    const parsed = VmReadinessReport.parse(emit(lines.join('\n')));
    expect(evaluateVmReadiness(parsed)).toMatchObject({
      ready: false,
      failed: ['gate-control'],
      missing: [],
    });
  });

  it('matches socket patterns and compares versions like the probes need', () => {
    const result = spawnSync(
      'bash',
      [
        '-c',
        `. "${join(vmDir, 'lib.sh')}"
matches_any /run/dbus/system_bus_socket '/run/dbus/* /dev/log' && echo allow1
matches_any /run/docker.sock '/run/dbus/* /dev/log' || echo deny1
matches_any /run/systemd/journal/socket '/run/systemd/*' && echo allow2
version_at_least 22.12.0 22.12.0 && echo v1
version_at_least 22.12.0 22.9.0 || echo v2
version_at_least 22.12.0 23.1.0 && echo v3`,
      ],
      { encoding: 'utf8' },
    );
    expect(result.stdout.split('\n').filter(Boolean)).toEqual([
      'allow1',
      'deny1',
      'allow2',
      'v1',
      'v2',
      'v3',
    ]);
  });
});

describe('scripts/vm-readiness.ts', () => {
  function run(content: string, extra: string[] = []) {
    const dir = mkdtempSync(join(tmpdir(), 'pm-vm-report-'));
    temp.push(dir);
    const file = join(dir, 'readiness.json');
    writeFileSync(file, content);
    return spawnSync(
      process.execPath,
      ['--import', 'tsx', join(root, 'scripts/vm-readiness.ts'), file, ...extra],
      {
        encoding: 'utf8',
        cwd: root,
      },
    );
  }

  const checks = (status: (id: string) => string) =>
    VM_CHECKS.map((check) => ({ id: check.id, status: status(check.id), evidence: `measured ${check.id}` }));
  const reportJson = (status: (id: string) => string, generatedAt = new Date().toISOString()) =>
    JSON.stringify({
      schemaVersion: 1,
      profile: { name: VM_PROFILE_NAME, version: VM_PROFILE_VERSION },
      generatedAt,
      host: { os: 'Ubuntu 24.04', kernel: '6.8.0', arch: 'aarch64' },
      checks: checks(status),
    });

  it('exits 0 for a ready report and prints the verdict', () => {
    const result = run(
      reportJson((id) => (VM_CHECKS.find((c) => c.id === id)!.required ? 'pass' : 'unverified')),
    );
    expect(result.stdout).toContain('READY: every required check passed.');
    expect(result.status).toBe(0);
  });

  it('exits 1 when a required check failed, and when the report is too old', () => {
    const failing = run(reportJson((id) => (id === 'worker-denied-read' ? 'fail' : 'pass')));
    expect(failing.status).toBe(1);
    expect(failing.stdout).toContain('NOT READY.');
    const old = run(
      reportJson(() => 'pass', '2020-01-01T00:00:00Z'),
      ['60'],
    );
    expect(old.status).toBe(1);
    expect(old.stdout).toContain('too old');
  });

  it('exits 2 for something that is not a report, such as a bare VM claim', () => {
    expect(run('{"vm":true}').status).toBe(2);
    expect(run('not json').status).toBe(2);
  });
});
