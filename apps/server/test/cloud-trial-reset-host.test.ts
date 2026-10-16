import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { trialInventory } from '../../../scripts/cloud/trial-reset';

const source = fs.readFileSync(new URL('../../../deploy/aws/host.sh', import.meta.url), 'utf8');
const embedded = source.split("<<'TRIAL_RESET_PY'\n")[1]!.split('\nTRIAL_RESET_PY')[0]!;
const id = '12345678-1234-4234-8234-123456789012';
const planSha = 'a'.repeat(64);
const hash = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
let root: string, state: string, etc: string, data: string, archive: string, program: string;
let expected: ReturnType<typeof trialInventory>;
let scenario: string;
let calls: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trial-host-')));
  state = path.join(root, 'state');
  etc = path.join(root, 'etc');
  data = path.join(state, 'data');
  archive = path.join(state, 'trial-archive', id);
  calls = path.join(root, 'calls');
  fs.mkdirSync(state, { mode: 0o700 });
  fs.mkdirSync(etc, { mode: 0o700 });
  fs.mkdirSync(data, { mode: 0o700 });
  fs.mkdirSync(path.join(root, 'proc'));
  fs.mkdirSync(path.join(data, 'empty'));
  fs.mkdirSync(path.join(data, 'files'));
  fs.writeFileSync(path.join(data, 'db.sqlite'), 'database');
  fs.writeFileSync(path.join(data, '\ufeffmanifest'), 'bom');
  fs.writeFileSync(path.join(data, 'files', 'árvíz\nfile'), 'payload');
  fs.writeFileSync(path.join(state, 'deploy.json'), 'deploy');
  fs.writeFileSync(path.join(state, '.image.lock'), '', { mode: 0o600 });
  fs.writeFileSync(path.join(etc, 'image.env'), 'image');
  fs.writeFileSync(path.join(etc, 'cloud.env'), 'secret-credential');
  fs.writeFileSync(path.join(root, 'mountinfo'), '1 0 1:1 / / rw - rootfs rootfs rw\n');
  fs.writeFileSync(calls, '');
  expected = trialInventory(data);
  scenario = 'ok';
  const tool = path.join(root, 'tool');
  fs.writeFileSync(
    tool,
    `#!${process.execPath}\nconst fs=require('node:fs');\nconst args=process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(calls)},args.join(' ')+'\\n');\nconst s=fs.readFileSync(${JSON.stringify(path.join(root, 'scenario'))},'utf8');\nif(args[0]==='show') {console.log(s==='running'?'active':'inactive');process.exit(0);}\nif(args[0]==='is-enabled') {console.log(s==='enabled'?'enabled':'disabled');process.exit(s==='enabled'?0:1);}\nif(args[0]==='ps') {if(s==='docker-error') process.exit(1); if(s==='container'||s==='starting') console.log('a'.repeat(64));process.exit(0);}\nif(args[0]==='inspect') {console.log(JSON.stringify([{State:{Running:s==='container',Restarting:false,Status:s==='starting'?'created':'running'}}]));process.exit(0);}\nprocess.exit(1);`,
    { mode: 0o700 },
  );
  // All substitutions are confined to this temporary fixture; production accepts no path overrides.
  program = embedded
    .replace('STATE = "/var/lib/projectman"', `STATE = ${JSON.stringify(state)}`)
    .replace('ETC = "/etc/projectman"', `ETC = ${JSON.stringify(etc)}`)
    .replace(
      'MOUNTINFO = "/proc/self/mountinfo"',
      `MOUNTINFO = ${JSON.stringify(path.join(root, 'mountinfo'))}`,
    )
    .replace('PROCESS_ROOT = "/proc"', `PROCESS_ROOT = ${JSON.stringify(path.join(root, 'proc'))}`)
    .replace('SYSTEMCTL = "/usr/bin/systemctl"', `SYSTEMCTL = ${JSON.stringify(tool)}`)
    .replace('DOCKER = "/usr/bin/docker"', `DOCKER = ${JSON.stringify(tool)}`)
    .replace('HOST_PLATFORM = sys.platform', 'HOST_PLATFORM = "linux"')
    .replace('ROOT_UID = 0', `ROOT_UID = ${process.getuid!()}`)
    .replace('DATA_UID = 10001', `DATA_UID = ${process.getuid!()}`)
    .replace('DATA_GID = 10001', `DATA_GID = ${process.getgid!()}`);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const args = () => [id, planSha, expected.inventorySha256, hash('deploy'), hash('image')];
const execute = (action: string, argv: string[] = action === 'inspect' ? [] : args(), code = program) => {
  fs.writeFileSync(path.join(root, 'scenario'), scenario);
  return spawnSync('python3', ['-I', '-S', '-c', code, action, ...argv], {
    encoding: 'utf8',
    timeout: 15_000,
  });
};
const receipt = () => JSON.parse(fs.readFileSync(path.join(archive, 'reset.json'), 'utf8'));
const assertFailure = (r: ReturnType<typeof execute>, status = 3) => {
  expect(r.status, `${r.error ?? ''} ${r.stderr}`).toBe(status);
  expect(r.stdout).toBe('');
  expect(r.stderr).not.toMatch(/árvíz|credential|Traceback|payload/);
};

describe('isolated Ubuntu trial-reset program on a disposable filesystem', () => {
  it('matches the Node canonical Unicode/empty-directory inventory without writes', () => {
    const r = execute('inspect');
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      ...expected,
      unitInactive: true,
      unitDisabled: true,
      containerStopped: true,
      deployJsonSha256: hash('deploy'),
      imageEnvSha256: hash('image'),
    });
    expect(fs.existsSync(path.join(state, 'trial-archive'))).toBe(false);
    expect(fs.readFileSync(path.join(etc, 'cloud.env'), 'utf8')).toBe('secret-credential');
  });
  it('archives metadata before renaming data; verifies without changing any bytes or receipt', () => {
    const r = execute('archive');
    expect(r.status, r.stderr).toBe(0);
    const answer = JSON.parse(r.stdout);
    expect(answer).toEqual({
      archiveDirectory: archive,
      inventorySha256: expected.inventorySha256,
      dataEmpty: true,
      unitInactive: true,
      unitDisabled: true,
    });
    expect(trialInventory(path.join(archive, 'data'))).toEqual(expected);
    expect(fs.readdirSync(data)).toEqual([]);
    expect(fs.statSync(data).mode & 0o777).toBe(0o700);
    expect(fs.statSync(archive).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(archive, 'reset.json')).mode & 0o777).toBe(0o600);
    expect(receipt()).toMatchObject({ version: 1, planId: id, planSha256: planSha, phase: 'archived' });
    expect(Object.keys(receipt()).sort()).toEqual(['phase', 'planId', 'planSha256', 'startedAt', 'version']);
    const before = fs.readFileSync(path.join(archive, 'reset.json'));
    const verify = execute('verify');
    expect(verify.status, verify.stderr).toBe(0);
    expect(JSON.parse(verify.stdout)).toEqual(answer);
    expect(fs.readFileSync(path.join(archive, 'reset.json'))).toEqual(before);
    expect(fs.existsSync(path.join(state, 'deploy.json'))).toBe(false);
    expect(fs.existsSync(path.join(etc, 'image.env'))).toBe(false);
    expect(fs.readFileSync(path.join(etc, 'cloud.env'), 'utf8')).toBe('secret-credential');
    expect(fs.readFileSync(calls, 'utf8')).not.toMatch(/start|stop|enable |disable |run |load|rm/);
    assertFailure(execute('archive'));
  });
  it('supports absent deploy/image metadata with the exact none marker', () => {
    fs.unlinkSync(path.join(state, 'deploy.json'));
    fs.unlinkSync(path.join(etc, 'image.env'));
    const argv = [...args().slice(0, 3), 'none', 'none'];
    const r = execute('archive', argv);
    expect(r.status, r.stderr).toBe(0);
    expect(execute('verify', argv).status).toBe(0);
    expect(fs.readdirSync(archive).sort()).toEqual(['data', 'reset.json']);
  });
  it.each(['running', 'enabled', 'container', 'starting'])('refuses %s before any archive write', (s) => {
    scenario = s;
    assertFailure(execute('archive'));
    expect(fs.existsSync(path.join(state, 'trial-archive'))).toBe(false);
  });
  it('does not interpret a Docker transport failure as a stopped container', () => {
    scenario = 'docker-error';
    assertFailure(execute('archive'), 1);
    expect(fs.existsSync(path.join(state, 'trial-archive'))).toBe(false);
  });
  it('refuses an active backup process', () => {
    fs.mkdirSync(path.join(root, 'proc', '123'));
    fs.writeFileSync(path.join(root, 'proc', '123', 'cmdline'), '/usr/bin/restic\0backup\0private-source\0');
    assertFailure(execute('archive'));
    expect(fs.existsSync(path.join(state, 'trial-archive'))).toBe(false);
  });
  it.each(['symlink', 'metadata-link', 'ancestor-link', 'mount', 'bind-mount', 'missing-db'])(
    'refuses %s without changing data',
    (s) => {
      if (s === 'symlink') fs.symlinkSync('db.sqlite', path.join(data, 'linked'));
      if (s === 'metadata-link') {
        fs.unlinkSync(path.join(etc, 'image.env'));
        fs.symlinkSync('cloud.env', path.join(etc, 'image.env'));
      }
      if (s === 'ancestor-link') {
        fs.renameSync(etc, path.join(root, 'elsewhere'));
        fs.symlinkSync('elsewhere', etc);
      }
      if (s === 'missing-db') fs.unlinkSync(path.join(data, 'db.sqlite'));
      if (s === 'mount' || s === 'bind-mount')
        fs.appendFileSync(
          path.join(root, 'mountinfo'),
          `2 1 ${s === 'mount' ? '2:2' : '1:1'} / ${path.join(data, 'files')} rw - ext4 /dev/fake rw\n`,
        );
      assertFailure(execute('archive'));
      expect(fs.existsSync(path.join(state, 'trial-archive'))).toBe(false);
    },
  );
  it('detects a file changing while it is read without exposing its name', () => {
    const changing = program.replace(
      'data = os.read(fd, 1024 * 1024)',
      `data = os.read(fd, 1024 * 1024)\n            if name == "db.sqlite" and data and os.fstat(fd).st_size == 8:\n                with open(${JSON.stringify(path.join(data, 'db.sqlite'))}, "ab") as changed:\n                    changed.write(b"x")`,
    );
    assertFailure(execute('archive', args(), changing));
    expect(fs.existsSync(path.join(state, 'trial-archive'))).toBe(false);
  });
  it.each(['metadata', 'data', 'interruption'])(
    'retains started receipt after a partial %s move; blocks a new reset',
    (where) => {
      const injected =
        where === 'metadata'
          ? program.replace('os.fsync(source)', 'raise RuntimeError()')
          : where === 'data'
            ? program.replace('os.mkdir("data", 0o700, dir_fd=state)', 'raise RuntimeError()')
            : program.replace('os.fsync(source)', 'os.kill(os.getpid(), signal.SIGTERM)');
      assertFailure(execute('archive', args(), injected), 1);
      expect(receipt().phase).toBe('started');
      expect(fs.existsSync(path.join(archive, 'deploy.json'))).toBe(true);
      expect(fs.existsSync(path.join(where === 'data' ? archive : state, 'data', 'db.sqlite'))).toBe(true);
      assertFailure(execute('archive', ['22345678-1234-4234-8234-123456789012', ...args().slice(1)]));
      assertFailure(execute('verify'));
    },
  );
  it.each([
    'data',
    'metadata',
    'receipt',
    'receipt-started',
    'receipt-missing',
    'receipt-malformed',
    'active-data',
    'active-deploy',
    'active-image',
    'running',
    'mount',
    'symlink',
  ])('refuses final verification after %s changes', (what) => {
    const r = execute('archive');
    expect(r.status, r.stderr).toBe(0);
    if (what === 'data') fs.appendFileSync(path.join(archive, 'data', 'db.sqlite'), 'changed');
    if (what === 'metadata') fs.appendFileSync(path.join(archive, 'deploy.json'), 'changed');
    if (what === 'receipt') {
      const v = receipt();
      v.planSha256 = 'b'.repeat(64);
      fs.writeFileSync(path.join(archive, 'reset.json'), JSON.stringify(v));
    }
    if (what === 'receipt-started') {
      const v = receipt();
      v.phase = 'started';
      fs.writeFileSync(path.join(archive, 'reset.json'), JSON.stringify(v));
    }
    if (what === 'receipt-missing') fs.unlinkSync(path.join(archive, 'reset.json'));
    if (what === 'receipt-malformed') fs.writeFileSync(path.join(archive, 'reset.json'), '{');
    if (what === 'active-data') fs.writeFileSync(path.join(data, 'new'), 'writer');
    if (what === 'active-deploy') fs.writeFileSync(path.join(state, 'deploy.json'), 'stale');
    if (what === 'active-image') fs.writeFileSync(path.join(etc, 'image.env'), 'stale');
    if (what === 'running') scenario = 'running';
    if (what === 'mount')
      fs.appendFileSync(
        path.join(root, 'mountinfo'),
        `2 1 1:1 / ${archive}/data/files rw - ext4 /dev/fake rw\n`,
      );
    if (what === 'symlink') {
      fs.unlinkSync(path.join(archive, 'image.env'));
      fs.symlinkSync(path.join(etc, 'cloud.env'), path.join(archive, 'image.env'));
    }
    assertFailure(execute('verify'));
    expect(fs.existsSync(path.join(archive, 'data', 'db.sqlite'))).toBe(true);
  });
  it('refuses missing Linux capabilities and malformed arguments before writes', () => {
    assertFailure(
      execute('archive', args(), program.replace('HOST_PLATFORM = "linux"', 'HOST_PLATFORM = "unsupported"')),
    );
    for (const argv of [
      [],
      [...args().slice(0, 4), 'NONE'],
      ['../foreign', ...args().slice(1)],
      ['12345678-1234-1234-8234-123456789012', ...args().slice(1)],
    ])
      assertFailure(execute('archive', argv));
    expect(fs.existsSync(path.join(state, 'trial-archive'))).toBe(false);
  });
});
