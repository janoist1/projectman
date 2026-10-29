import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

/** The node flags of the fatal-error report and the near-limit heap snapshot (PM-1105). */
const diagnosticArgs = (home: string) =>
  `--report-on-fatalerror --report-directory=${home}/diagnostics --heapsnapshot-near-heap-limit=1 --diagnostic-dir=${home}/diagnostics`;

describe('cloud backup and restore with fake storage tools', () => {
  let temp: string;
  let home: string;
  let bin: string;
  let app: string;
  let state: string;
  const files = [
    'secret',
    'secrets/app.json',
    'customization/.git/config',
    'customization/projects.yaml',
    'attachments/card.bin',
    'message-attachments/message.bin',
    'feedback/widget.bin',
    'memory/member.md',
  ];
  const excluded = [
    'db.sqlite-wal',
    'db.sqlite-shm',
    'logs/server.log',
    'diagnostics/near-limit.heapsnapshot',
    'providers/login.json',
    'engine.key',
    'engine.json',
    'engine-spool/data',
    'browsers/data',
    'member-caches/data',
    'github-publish/key',
    'worktrees/data',
    'workspaces/data',
    'spool/data',
    'attachments-cache/data',
    '.cloud-volume',
  ];
  const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
  const bash = existsSync('/opt/homebrew/bin/bash') ? '/opt/homebrew/bin/bash' : 'bash';
  function put(path: string, content: string) {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
  function mode(value: object) {
    writeFileSync(state, JSON.stringify(value));
  }
  function calls(): string[] {
    return existsSync(join(temp, 'calls'))
      ? readFileSync(join(temp, 'calls'), 'utf8').trim().split('\n')
      : [];
  }
  function run(
    command: 'backup' | 'restore' | 'check' | 'serve' | 'rehearse',
    scratch = join(temp, 'restored'),
    extraEnv: Record<string, string> = {},
  ) {
    return spawnSync(
      bash,
      [
        join(
          app,
          'deploy/cloud',
          command === 'serve' || command === 'rehearse' ? 'entrypoint.sh' : 'backup.sh',
        ),
        command,
        ...(command === 'restore' ? [scratch] : []),
      ],
      {
        encoding: 'utf8',
        timeout: 10000,
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          HOME: temp,
          TMPDIR: temp,
          PROJECTMAN_HOME: command === 'serve' ? join(temp, 'fresh') : home,
          REHEARSAL_DIR: scratch,
          TUNNEL_TOKEN: 'fixture',
          RESTIC_REPOSITORY: 'fixture',
          RESTIC_PASSWORD: 'fixture',
          RESTIC_ACCESS_KEY_ID: 'fixture',
          RESTIC_SECRET_ACCESS_KEY: 'fixture',
          LITESTREAM_BUCKET: 'fixture',
          LITESTREAM_ENDPOINT: 'fixture',
          LITESTREAM_REGION: 'fixture',
          LITESTREAM_ACCESS_KEY_ID: 'fixture',
          LITESTREAM_SECRET_ACCESS_KEY: 'fixture',
          ...extraEnv,
        },
      },
    );
  }
  beforeEach(() => {
    temp = mkdtempSync(join(tmpdir(), 'cloud-backup-'));
    home = join(temp, 'data');
    bin = join(temp, 'bin');
    app = join(temp, 'app');
    state = join(temp, 'state.json');
    mkdirSync(bin);
    mode({});
    for (const path of [...files, ...excluded]) put(join(home, path), `fixture bytes: ${path}`);
    const db = new Database(join(home, 'db.sqlite'));
    db.exec('CREATE TABLE file_references (path TEXT PRIMARY KEY, sha256 TEXT NOT NULL)');
    for (const path of files)
      db.prepare('INSERT INTO file_references VALUES (?, ?)').run(path, hash(join(home, path)));
    db.close();
    put(join(app, 'deploy/cloud/backup.sh'), backup);
    // Only the container path is adapted; the production control flow and environment filter run unchanged.
    put(join(app, 'deploy/cloud/entrypoint.sh'), entrypoint.replace('APP_DIR=/app', `APP_DIR='${app}'`));
    put(join(app, 'deploy/cloud/smoke.sh'), '#!/bin/sh\nexit 0\n');
    for (const path of ['backup.sh', 'smoke.sh']) {
      // Scripts invoked directly by the entrypoint need executable permissions.
      chmodSync(join(app, 'deploy/cloud', path), 0o755);
    }
    const fake = `#!${process.execPath}
const fs = require('node:fs'), p = require('node:path');
const temp = ${JSON.stringify(temp)}, home = ${JSON.stringify(home)};
const tool = p.basename(process.argv[1]), args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(p.join(temp, 'state.json'), 'utf8'));
fs.appendFileSync(p.join(temp, 'calls'), tool + ' ' + args.join(' ') + '\\n');
const copy = (from, to) => { fs.mkdirSync(p.dirname(to), {recursive:true}); fs.cpSync(from, to, {recursive:true}); };
if (tool === 'id') { console.log('10001'); }
else if (tool === 'curl') { if (!fs.existsSync(p.join(temp, 'server-ready'))) process.exit(1); }
else if (tool === 'node') {
  const role = JSON.parse(fs.readFileSync(p.join(process.env.PROJECTMAN_HOME, 'instance.json'), 'utf8'));
  if (role.role !== 'standby') process.exit(9);
  fs.writeFileSync(p.join(temp, 'server-ready'), 'ready');
  setInterval(() => {}, 1000);
} else if (tool === 'litestream') {
  if (args[0] !== 'restore') process.exit(9);
  if (state.databaseError) { console.error('litestream: replica cannot be read'); process.exit(state.databaseError); }
  if (!state.noDatabase) copy(p.join(home, 'db.sqlite'), args[args.indexOf('-o') + 1]);
} else if (tool === 'restic') {
  const command = args[0];
  if (command === 'cat') process.exit(state.repositoryError || 0);
  if (command === 'snapshots') { if (state.listError) { console.error('restic: listing failed'); process.exit(state.listError); } console.log(state.invalidList ? 'null' : state.empty ? '[]' : '[{"id":"fixture"}]'); }
  if (command === 'backup') {
    const excludes = args.flatMap((v,i) => v === '--exclude' ? [args[i+1]] : []);
    fs.cpSync(home, p.join(temp, 'snapshot'), {recursive:true, filter: path => !excludes.includes(path)});
  }
  if (command === 'restore') {
    if (state.restoreError) { console.error('restic: restore failed'); process.exit(state.restoreError); }
    if (state.missingFile) { console.error('restic: snapshot file is missing'); process.exit(1); }
    if (!state.missingHome) copy(p.join(temp, 'snapshot'), args[args.indexOf('--target')+1] + process.env.PROJECTMAN_HOME);
  }
  if (command === 'check') process.exit(state.checkError || 0);
}
`;
    for (const tool of ['restic', 'litestream', 'node'])
      writeFileSync(join(bin, tool), fake, { mode: 0o755 });
    // The two that are polled or trivial are shell scripts: starting node for each costs most of a run.
    writeFileSync(
      join(bin, 'curl'),
      `#!/bin/sh\necho "curl $*" >> '${join(temp, 'calls')}'\n[ -e '${join(temp, 'server-ready')}' ]\n`,
      { mode: 0o755 },
    );
    writeFileSync(join(bin, 'id'), `#!/bin/sh\necho "id $*" >> '${join(temp, 'calls')}'\necho 10001\n`, {
      mode: 0o755,
    });
    // The entrypoint polls the server once a second; a poll of 50 ms keeps the same loop and the same exits.
    // Any other sleep (the backup loop's long ones) is left as it is.
    writeFileSync(join(bin, 'sleep'), '#!/bin/sh\n[ "$1" = 1 ] && set -- 0.05\nexec /bin/sleep "$@"\n', {
      mode: 0o755,
    });
  });
  afterEach(() => rmSync(temp, { recursive: true, force: true }));

  it('forgets old snapshots on every backup and prunes at most once a week', () => {
    expect(run('backup').status).toBe(0);
    expect(run('backup').status).toBe(0);
    const resticCalls = calls().filter((line) => line.startsWith('restic '));
    expect(resticCalls.filter((line) => line.startsWith('restic forget')).length).toBe(2);
    expect(resticCalls.some((line) => line.includes('--prune'))).toBe(false);
    expect(resticCalls.filter((line) => line === 'restic prune').length).toBe(1);
  });

  it('restores every durable file with matching SQLite references, without engine credentials or a second writer', () => {
    expect(run('backup').status).toBe(0);
    const scratch = join(temp, 'rehearsal');
    const result = run('rehearse', scratch);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('REHEARSAL PASSED');
    const db = new Database(join(scratch, 'db.sqlite'), { readonly: true });
    const refs = db.prepare('SELECT path, sha256 FROM file_references').all() as {
      path: string;
      sha256: string;
    }[];
    expect(refs.map((row) => row.path)).toEqual(files);
    for (const row of refs) expect(hash(join(scratch, row.path))).toBe(row.sha256);
    db.close();
    for (const path of excluded) expect(existsSync(join(scratch, path)), path).toBe(false);
    expect(calls().filter((call) => call.startsWith('litestream '))).toHaveLength(1);
    expect(calls().join('\n')).not.toMatch(/litestream replicate|cloudflared/);
    expect(run('check').status).toBe(0);
    mode({ checkError: 1 });
    expect(run('check').status).toBe(1);
  });

  it.each([{ repositoryError: 10 }, { empty: true }])('accepts a genuinely empty repository: %j', (state) => {
    mode(state);
    const result = run('restore');
    expect(result.status).toBe(0);
    expect(existsSync(join(temp, 'restored/secret'))).toBe(false);
    mode({ ...state, noDatabase: true });
    expect(run('rehearse').status).toBe(3);
    expect(calls().some((call) => call.startsWith('node '))).toBe(false);
  });

  it.each([
    { repositoryError: 1 },
    { repositoryError: 3 },
    { listError: 1 },
    { invalidList: true },
    { missingFile: true },
    { restoreError: 1 },
    { missingHome: true },
    { databaseError: 1 },
  ])('refuses unreadable or incomplete recovery before any writer starts: %j', (state) => {
    expect(run('backup').status).toBe(0);
    mode(state);
    const result = run('serve');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(
      /repository cannot be read|invalid snapshot listing|snapshot file is missing|latest snapshot has no|listing failed|restore failed|replica cannot be read/,
    );
    expect(calls().join('\n')).not.toMatch(/node |litestream replicate|cloudflared/);
    expect(existsSync(join(temp, 'fresh/.cloud-volume'))).toBe(false);
  });

  it.each(['128', '256', '4096', '0256'])(
    'gives the server --max-old-space-size from PROJECTMAN_HEAP_LIMIT_MB=%s (PM-775)',
    (value) => {
      expect(run('backup').status).toBe(0);
      const result = run('rehearse', join(temp, 'rehearsal'), { PROJECTMAN_HEAP_LIMIT_MB: value });
      expect(result.status).toBe(0);
      const server = calls().filter((call) => call.startsWith('node '));
      expect(server).toEqual([`node --max-old-space-size=${Number(value)} ${app}/apps/server/dist/index.js`]);
    },
  );

  it.each([undefined, ''])(
    'leaves the node default heap limit when PROJECTMAN_HEAP_LIMIT_MB is %j',
    (value) => {
      expect(run('backup').status).toBe(0);
      const result = run(
        'rehearse',
        join(temp, 'rehearsal'),
        value === undefined ? {} : { PROJECTMAN_HEAP_LIMIT_MB: value },
      );
      expect(result.status).toBe(0);
      expect(calls().filter((call) => call.startsWith('node '))).toEqual([
        `node ${app}/apps/server/dist/index.js`,
      ]);
    },
  );

  it('with PROJECTMAN_HEAP_SNAPSHOT=1 writes a fatal-error report and one heap snapshot into <home>/diagnostics, keeping only the newest earlier snapshot (PM-1105)', () => {
    expect(run('backup').status).toBe(0);
    const dir = join(temp, 'fresh', 'diagnostics');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'old.heapsnapshot'), 'x');
    utimesSync(join(dir, 'old.heapsnapshot'), new Date(1_000_000_000_000), new Date(1_000_000_000_000));
    writeFileSync(join(dir, 'new.heapsnapshot'), 'x');
    writeFileSync(join(dir, 'report.json'), '{}');
    run('serve', join(temp, 'fresh'), { PROJECTMAN_HEAP_SNAPSHOT: '1' });
    expect(calls().filter((call) => call.startsWith('node '))).toEqual([
      `node ${diagnosticArgs(join(temp, 'fresh'))} ${app}/apps/server/dist/index.js`,
    ]);
    expect(readdirSync(dir).sort()).toEqual(['new.heapsnapshot', 'report.json']);
  });

  it.each([undefined, '0'])(
    'writes no diagnostics and touches none when PROJECTMAN_HEAP_SNAPSHOT is %j (PM-1105)',
    (value) => {
      expect(run('backup').status).toBe(0);
      run('serve', join(temp, 'fresh'), value === undefined ? {} : { PROJECTMAN_HEAP_SNAPSHOT: value });
      expect(calls().filter((call) => call.startsWith('node '))).toEqual([
        `node ${app}/apps/server/dist/index.js`,
      ]);
      expect(existsSync(join(temp, 'fresh', 'diagnostics'))).toBe(false);
    },
  );

  it('refuses an unknown PROJECTMAN_HEAP_SNAPSHOT before starting anything (PM-1105)', () => {
    expect(run('backup').status).toBe(0);
    const before = calls().length;
    const result = run('serve', join(temp, 'fresh'), { PROJECTMAN_HEAP_SNAPSHOT: 'yes' });
    expect(result.status).toBe(64);
    expect(result.stderr).toContain('invalid PROJECTMAN_HEAP_SNAPSHOT');
    expect(calls()).toHaveLength(before);
  });

  it.each(['127', '4097', '99999', 'abc', '1e3', '-256', '256.5', '256 ', ' 256', '0'])(
    'refuses PROJECTMAN_HEAP_LIMIT_MB=%j before starting anything (PM-775)',
    (value) => {
      expect(run('backup').status).toBe(0);
      const before = calls().length;
      for (const command of ['serve', 'rehearse'] as const) {
        const result = run(command, join(temp, 'rehearsal'), { PROJECTMAN_HEAP_LIMIT_MB: value });
        expect(result.status).toBe(64);
        expect(result.stderr).toContain('invalid PROJECTMAN_HEAP_LIMIT_MB');
      }
      expect(calls()).toHaveLength(before);
    },
  );

  it('refuses a rehearsal against the original home or a reused scratch directory', () => {
    expect(run('rehearse', home).status).toBe(64);
    put(join(temp, 'reused/.cloud-volume'), 'old marker');
    expect(run('rehearse', join(temp, 'reused')).status).toBe(64);
    expect(calls().some((call) => call.startsWith('litestream '))).toBe(false);
  });
});

describe('deploy/cloud shell scripts', () => {
  for (const name of ['entrypoint.sh', 'backup.sh', 'smoke.sh']) {
    it(`${name} parses`, () => {
      const result = spawnSync('bash', ['-n', join(cloudDir, name)], {
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C' },
      });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
    });
  }

  describe('smoke.sh engine door probes (PM-723)', () => {
    let temp: string;
    beforeEach(() => {
      temp = mkdtempSync(join(tmpdir(), 'pm-smoke-'));
      const bin = join(temp, 'bin');
      mkdirSync(bin);
      // A fake curl: logs "METHOD path", answers the status from the "answers" file ("METHOD path code").
      writeFileSync(
        join(bin, 'curl'),
        [
          '#!/usr/bin/env bash',
          'method=GET; url=""; fmt=""',
          'while [ $# -gt 0 ]; do',
          '  case "$1" in',
          '    -X) method="$2"; shift ;;',
          '    -w) fmt="$2"; shift ;;',
          '    -o|-H|--max-time|--data-binary) shift ;;',
          '    -*) ;;',
          '    *) url="$1" ;;',
          '  esac',
          '  shift',
          'done',
          'path="/${url#*://*/}"',
          'echo "$method $path" >> "$FAKE_CURL_DIR/calls"',
          'code=$(awk -v k="$method $path" \'index($0, k " ") == 1 { print $NF }\' "$FAKE_CURL_DIR/answers")',
          '[ -n "$code" ] || { printf 000; exit 7; }',
          'if [ "$path" = /api/setup ]; then printf \'{"needsSetup":false,"publicBoard":false}\\n%s\' "$code"; exit 0; fi',
          'printf \'%s\' "$code"',
          '',
        ].join('\n'),
      );
      chmodSync(join(bin, 'curl'), 0o755);
    });
    afterEach(() => rmSync(temp, { recursive: true, force: true }));

    const DOORS = {
      linkGet: 'GET /engine/link',
      downloadGet: 'GET /engine/files/downloads/smoke-test',
      uploadGet: 'GET /engine/files/uploads/smoke-test',
      uploadPost: 'POST /engine/files/uploads/smoke-test',
    };
    function smoke(answers: Record<string, string | null>) {
      const lines = ['GET /api/setup 200'];
      for (const [key, code] of Object.entries(answers))
        if (code !== null) lines.push(`${DOORS[key as keyof typeof DOORS]} ${code}`);
      writeFileSync(join(temp, 'answers'), `${lines.join('\n')}\n`);
      const result = spawnSync('bash', [join(cloudDir, 'smoke.sh'), 'https://board.example.com'], {
        encoding: 'utf8',
        timeout: 10000,
        env: {
          PATH: `${join(temp, 'bin')}:${process.env.PATH}`,
          FAKE_CURL_DIR: temp,
          CF_ACCESS_CLIENT_ID: 'test-id.access',
          CF_ACCESS_CLIENT_SECRET: 'test-secret',
        },
      });
      const calls = readFileSync(join(temp, 'calls'), 'utf8').trim().split('\n');
      return { result, calls };
    }
    const refused = { linkGet: '401', downloadGet: '401', uploadGet: '404', uploadPost: '401' };

    it('probes the upload door with a GET and with a POST, and passes when every probe is refused', () => {
      const { result, calls } = smoke(refused);
      expect(result.status).toBe(0);
      expect(calls).toEqual(
        expect.arrayContaining([DOORS.linkGet, DOORS.downloadGet, DOORS.uploadGet, DOORS.uploadPost]),
      );
      expect(result.stdout).toContain(
        'POST /engine/files/uploads/smoke-test refuses an anonymous caller (401)',
      );
    });

    it('fails when only the upload POST answers 2xx', () => {
      const { result } = smoke({ ...refused, uploadPost: '200' });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('POST /engine/files/uploads/smoke-test answered 200');
    });

    it('fails when the upload GET answers 200 (the web app fallback)', () => {
      const { result } = smoke({ ...refused, uploadGet: '200' });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('GET /engine/files/uploads/smoke-test answered 200');
    });

    it('fails when an engine probe cannot be reached', () => {
      const { result } = smoke({ ...refused, uploadPost: null });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('POST /engine/files/uploads/smoke-test is not reachable');
    });
  });

  it('the entrypoint starts as root only to drop to an unprivileged user, and keeps it dropped', () => {
    expect(entrypoint).toMatch(
      /exec setpriv --reuid="\$RUN_UID" --regid="\$RUN_GID" --clear-groups --no-new-privs/,
    );
    expect(dockerfile).toContain('useradd --system --uid 10001');
    expect(entrypoint).toContain('RUN_UID=10001');
  });

  it('the server environment holds no tunnel token, storage key or restic password (an environment filter only)', () => {
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

  it('the server gets the PROJECTMAN_* settings of cloud.env (the e-mail login ones too), the rehearsal copy sends no mail (PM-669)', () => {
    const allowlist = entrypoint.split('\n').find((line) => line.startsWith('load_env server_env'))!;
    expect(allowlist).toContain("'PROJECTMAN_*'");
    // Only the server's own environment holds the SES keys: the other processes get their own allowlists.
    for (const name of ['restic_run', 'litestream_run']) {
      expect(shellFunction(entrypoint, name)).not.toContain('server_env');
    }
    expect(shellFunction(entrypoint, 'rehearse')).toContain(
      'start_server "$scratch" "$port" PROJECTMAN_EMAIL_LOGIN_ENABLED=0 PROJECTMAN_PUBLIC_BOARD=0',
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
    // A repository without any snapshot restores nothing instead of failing the start.
    expect(backup).toContain("'[]')");
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
  it('copies the built feedback widget into the runtime image', () => {
    const runtime = dockerfile.split(/^FROM .* AS runtime\s*$/m)[1];
    expect(runtime).toBeDefined();
    expect(runtime).toContain('COPY --from=build /app/apps/feedback-widget/dist ./apps/feedback-widget/dist');
  });

  it('copies every workspace manifest before installing build dependencies', () => {
    const { workspaces } = JSON.parse(read('package.json')) as { workspaces: string[] };
    const manifests = globSync(
      workspaces.map((workspace) => `${workspace}/package.json`),
      {
        cwd: root,
      },
    );
    expect(manifests.length).toBeGreaterThan(0);

    const buildStage = withoutComments(dockerfile)
      .split(/^FROM .+ AS build\s*$/m)[1]
      ?.split(/^FROM /m)[0];
    expect(buildStage).toBeDefined();
    const installSteps = buildStage!.split(/^RUN npm ci\s*$/m);
    expect(installSteps).toHaveLength(2);
    const copiesBeforeInstall = installSteps[0]!.split('\n').map((line) => line.trim());

    for (const manifest of manifests) {
      expect(copiesBeforeInstall, manifest).toContain(`COPY ${manifest} ${dirname(manifest)}/`);
    }
  });

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

  it('checks its health with curl, not a node process, and sets the memory log and the heap limit (PM-775)', () => {
    const runtime = dockerfile.split(/^FROM .* AS runtime\s*$/m)[1]!;
    expect(runtime).toMatch(/apt-get install[^\n]*\bcurl\b/);
    const healthcheck = runtime.match(/^HEALTHCHECK (--[^\n]*\\\n)*\s*CMD (\[[^\n]*\])$/m);
    expect(healthcheck?.[0]).toMatch(/--interval=30s --timeout=5s --start-period=60s --retries=3/);
    expect(JSON.parse(healthcheck![2]!)).toEqual([
      'curl',
      '-fsS',
      '--max-time',
      '5',
      '-o',
      '/dev/null',
      'http://127.0.0.1:4700/api/setup',
    ]);
    expect(runtime).toContain('PROJECTMAN_MEMORY_LOG_SECONDS=600');
    // The ceiling is a whole number in the range the entrypoint accepts (docs/HYBRID.md "Settings").
    const limit = Number(runtime.match(/PROJECTMAN_HEAP_LIMIT_MB=(\d+)/)?.[1]);
    expect(limit).toBeGreaterThanOrEqual(128);
    expect(limit).toBeLessThanOrEqual(4096);
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
    expect(ignored).toEqual(expect.arrayContaining(['.git', '**/node_modules', '**/.env', '**/.env.*']));
  });

  it('the engine Access application covers the whole /engine path, and the smoke test checks the file routes', () => {
    // The engine calls /engine/link and /engine/files/{uploads,downloads}/:token with one token.
    expect(guide).toContain('projectman.example.com/engine`');
    expect(guide).not.toContain('projectman.example.com/engine/link');
    const smoke = read('deploy/cloud/smoke.sh');
    for (const path of ['/engine/link', '/engine/files/downloads/', '/engine/files/uploads/']) {
      expect(smoke, path).toContain(path);
    }
  });

  it('the guide carries the account protection, the cost estimate and the limits of the container', () => {
    expect(guide).toMatch(/passkey or a hardware security key/);
    expect(guide).toMatch(/5 to 10 USD a month/);
    expect(guide).toMatch(/No control socket client and no migration tools in the container/);
  });

  it('does not claim the processes are isolated from a compromised server', () => {
    for (const text of [guide, entrypoint, read('docs/SECURITY.md'), read('docs/ARCHITECTURE.md')]) {
      expect(text).not.toMatch(/server never sees the tunnel token/i);
    }
    expect(guide).toMatch(/does not protect against a compromised server/);
  });
});

describe('deploy/cloud configuration', () => {
  it('litestream.yml takes every credential from the environment', () => {
    expect(litestream).toContain('sync-interval: 1s');
    expect(entrypoint).toContain('BACKUP_INTERVAL_SECONDS:-21600');
    expect(entrypoint).toContain('BACKUP_FIRST_DELAY_SECONDS:-300');
    expect(dockerfile).toContain('litestream/litestream:0.5.17');
    expect(dockerfile).toContain('restic/restic:0.19.1');
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
  });
});
