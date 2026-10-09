import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The cloud deployment files (PM-317, docs/HYBRID.md) cannot be built or run in the test
 * environment (no container daemon, no Cloudflare, no storage). What is checked here: the pieces
 * agree with each other and with the guide, the shell scripts parse, nothing in the image brings
 * an AI CLI, no file holds a secret, and the rehearsal can never touch the production replica.
 */

const root = fileURLToPath(new URL('../../../', import.meta.url));
const cloudDir = join(root, 'deploy/cloud');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const dockerfile = read('deploy/cloud/Dockerfile');
const entrypoint = read('deploy/cloud/entrypoint.sh');
const backup = read('deploy/cloud/backup.sh');
const litestream = read('deploy/cloud/litestream.yml');
const fly = read('deploy/cloud/fly.toml');
const guide = read('docs/HYBRID.md');

/** A shell function: its one line, or from `name() {` to the closing `}` at column 0. */
function shellFunction(source: string, name: string): string {
  const start = source.indexOf(`\n${name}() {`);
  if (start < 0) throw new Error(`no function ${name}`);
  const lineEnd = source.indexOf('\n', start + 1);
  if (source.slice(start + 1, lineEnd).endsWith('}')) return source.slice(start + 1, lineEnd);
  const end = source.indexOf('\n}\n', start);
  return source.slice(start + 1, end + 2);
}

const withoutComments = (source: string) =>
  source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');

describe('deploy/cloud shell scripts', () => {
  for (const name of ['entrypoint.sh', 'backup.sh', 'smoke.sh']) {
    it(`${name} parses`, () => {
      const result = spawnSync('bash', ['-n', join(cloudDir, name)], { encoding: 'utf8' });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
    });
  }

  it('the entrypoint starts as root only to drop to an unprivileged user, and keeps it dropped', () => {
    expect(entrypoint).toMatch(
      /exec setpriv --reuid="\$RUN_UID" --regid="\$RUN_GID" --clear-groups --no-new-privs/,
    );
    expect(dockerfile).toContain('useradd --system --uid 10001');
    expect(entrypoint).toContain('RUN_UID=10001');
  });

  it('the server never gets the tunnel token, the storage keys or the restic password', () => {
    const allowlist = entrypoint.split('\n').filter((line) => line.startsWith('load_env server_env'));
    expect(allowlist).toHaveLength(1);
    expect(allowlist[0]).not.toMatch(/TUNNEL|LITESTREAM|RESTIC|AWS/);
    // The processes run in a cleared environment (`env -i`) with only their own variables.
    for (const name of ['start_server', 'restic_run', 'litestream_run']) {
      expect(shellFunction(entrypoint, name)).toContain('env -i');
    }
    expect(entrypoint).toMatch(
      /env -i "\$\{base_env\[@\]\}" TUNNEL_TOKEN="\$TUNNEL_TOKEN" \\\n\s+cloudflared/,
    );
  });

  it('the server is forced into cloud mode on the loopback', () => {
    const start = shellFunction(entrypoint, 'start_server');
    expect(start).toContain('HOST=127.0.0.1');
    expect(start).toContain('PROJECTMAN_MODE=cloud');
  });

  it('the rehearsal restores into a scratch directory and never replicates or opens the tunnel', () => {
    const rehearsal = shellFunction(entrypoint, 'rehearse');
    expect(rehearsal).toContain('restore_state "$scratch" no');
    expect(rehearsal).not.toMatch(/replicate|cloudflared|restic_run backup/);
    expect(rehearsal).toContain('"role":"standby"');
    // A failed restore stops the start: only the "does not exist" answers continue empty.
    expect(entrypoint).toContain('-if-db-not-exists -if-replica-exists');
    expect(backup).toContain('10) return 1 ;;');
    expect(entrypoint.split('\n')[0]).toBe('#!/usr/bin/env bash');
    expect(entrypoint).toMatch(/^set -euo pipefail$/m);
  });

  it('the restic backup leaves the database to Litestream and the repository password apart from the key', () => {
    expect(backup).toContain('--exclude "$PROJECTMAN_HOME/db.sqlite"');
    expect(backup).toContain('--exclude "$PROJECTMAN_HOME/db.sqlite-wal"');
    expect(backup).toContain('RESTIC_PASSWORD');
    expect(backup).toContain('RESTIC_ACCESS_KEY_ID');
  });
});

describe('deploy/cloud image', () => {
  it('brings git, and neither the claude, codex nor gh CLI', () => {
    expect(dockerfile).toMatch(/apt-get install -y --no-install-recommends [^&]*\bgit\b/);
    const installs = dockerfile
      .split('\n')
      .filter((line) => /apt-get install|npm (i|install|ci) |curl |wget /.test(line))
      .join('\n');
    expect(installs).not.toMatch(/claude|codex|anthropic|openai|\bgh\b|github-cli/i);
    expect(dockerfile).not.toMatch(/^\s*COPY .*(claude|codex)/im);
  });

  it('listens on the loopback only and trusts the tunnel client header', () => {
    expect(dockerfile).toContain('HOST=127.0.0.1');
    expect(dockerfile).toContain('PROJECTMAN_MODE=cloud');
    expect(dockerfile).toContain('PROJECTMAN_CLIENT_IP_HEADER=cf-connecting-ip');
    expect(dockerfile).not.toMatch(/^EXPOSE/m);
  });

  it('holds no secret in an ENV or ARG', () => {
    const assigned = dockerfile.split('\n').filter((line) => /^\s*(ENV|ARG)\b|^\s{4}[A-Z_]+=/.test(line));
    for (const line of assigned) expect(line).not.toMatch(/TOKEN|SECRET|PASSWORD|KEY/i);
  });

  it('copies in the scripts it runs, and the context ignores the git history and the environment files', () => {
    for (const name of ['entrypoint.sh', 'backup.sh', 'smoke.sh', 'litestream.yml']) {
      expect(dockerfile).toContain(`deploy/cloud/${name}`);
    }
    const ignored = read('.dockerignore').split('\n');
    expect(ignored).toEqual(expect.arrayContaining(['.git', '**/node_modules', '.env']));
  });
});

describe('deploy/cloud configuration', () => {
  it('fly.toml has no public service and mounts the volume at the home', () => {
    const settings = withoutComments(fly);
    expect(settings).not.toMatch(/^\s*\[+(http_service|services)\]+/m);
    expect(settings).not.toMatch(/^\s*(internal_port|force_https)/m);
    expect(settings).toMatch(/destination = "\/data"/);
    expect(settings).not.toMatch(/TUNNEL_TOKEN|SECRET|PASSWORD|ACCESS_KEY/);
  });

  it('litestream.yml takes every credential from the environment', () => {
    for (const key of ['access-key-id', 'secret-access-key', 'bucket', 'endpoint']) {
      expect(litestream).toMatch(new RegExp(`${key}: \\$\\{[A-Z_]+\\}`));
    }
    expect(litestream).toContain('path: ${PROJECTMAN_HOME}/db.sqlite');
  });

  it('the variables the entrypoint requires, the config uses and the guide names agree', () => {
    const required = /require_storage\(\) \{\n\s+require ([\s\S]*?)\n\}/.exec(entrypoint)?.[1] ?? '';
    const names = required.replace(/\\\n/g, ' ').split(/\s+/).filter(Boolean);
    expect(names.length).toBeGreaterThanOrEqual(9);
    for (const name of [...names, 'TUNNEL_TOKEN']) expect(guide, name).toContain(name);
    for (const name of names.filter((name) => name.startsWith('LITESTREAM_')))
      expect(litestream, name).toContain(`\${${name}}`);
    // fly.toml's plain settings are all names the entrypoint knows.
    const flyEnv = [...fly.matchAll(/^\s{2}([A-Z_]+) = "/gm)].map((match) => match[1] ?? '');
    for (const name of flyEnv) expect([...names, 'RESTIC_REGION'], name).toContain(name);
  });
});
