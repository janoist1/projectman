import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expectedServiceKind, loadSupervisorConfig } from './config';
import { LAUNCHCTL, PS, SYSTEMCTL, createServiceController } from './service-control';
import type { RunCommand } from './service-control';

type Call = { file: string; args: readonly string[] };

function fakeRun(answer: (call: Call) => { exitCode: number; stdout: string }) {
  const calls: Call[] = [];
  const run: RunCommand = async (file, args) => {
    const call = { file, args };
    calls.push(call);
    return answer(call);
  };
  return { calls, run };
}

const PRINTED = ['gui/501/com.projectman.live = {', '\tstate = running', '\tpid = 4321', '}'].join('\n');

describe('launchd controller', () => {
  const config = { service: { kind: 'launchd', label: 'com.projectman.live' } } as const;

  it('derives the boot id from the pid and the process start time, so a reused pid still changes it', async () => {
    let started = 'Sat Oct 17 10:00:00 2026';
    const { run, calls } = fakeRun(({ file }) =>
      file === LAUNCHCTL ? { exitCode: 0, stdout: PRINTED } : { exitCode: 0, stdout: `${started}\n` },
    );
    const controller = createServiceController(config, 'darwin', { run, uid: 501 })!;
    const first = await controller.probe();
    started = 'Sat Oct 17 10:05:00 2026';
    const second = await controller.probe();
    expect(first.running).toBe(true);
    expect(first.bootId).toMatch(/^launchd-[0-9a-f]{32}$/);
    expect(second.bootId).not.toBe(first.bootId);
    expect(calls[0]).toEqual({ file: LAUNCHCTL, args: ['print', 'gui/501/com.projectman.live'] });
    expect(calls[1]).toEqual({ file: PS, args: ['-o', 'lstart=', '-p', '4321'] });
  });

  it('refuses to guess a user domain when the numeric user id is unknown', () => {
    expect(() =>
      createServiceController(config, 'darwin', {
        run: fakeRun(() => ({ exitCode: 0, stdout: '' })).run,
        uid: null,
      }),
    ).toThrow(/numeric user id/);
  });

  it('is not running when launchd does not know the service or it has no pid', async () => {
    const missing = createServiceController(config, 'darwin', {
      run: fakeRun(() => ({ exitCode: 113, stdout: '' })).run,
      uid: 501,
    })!;
    expect(await missing.probe()).toEqual({ running: false, bootId: null });
    const stopped = createServiceController(config, 'darwin', {
      run: fakeRun(() => ({ exitCode: 0, stdout: 'state = waiting\n' })).run,
      uid: 501,
    })!;
    expect(await stopped.probe()).toEqual({ running: false, bootId: null });
  });

  it('restarts only the configured label, with fixed arguments', async () => {
    const { run, calls } = fakeRun(() => ({ exitCode: 0, stdout: '' }));
    await createServiceController(config, 'darwin', { run, uid: 501 })!.restart();
    expect(calls).toEqual([{ file: LAUNCHCTL, args: ['kickstart', '-k', 'gui/501/com.projectman.live'] }]);
    const refusing = createServiceController(config, 'darwin', {
      run: fakeRun(() => ({ exitCode: 1, stdout: '' })).run,
      uid: 501,
    })!;
    await expect(refusing.restart()).rejects.toThrow();
  });
});

describe('systemd controller', () => {
  const config = { service: { kind: 'systemd', unit: 'projectman.service' } } as const;
  const INVOCATION = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

  it('uses the invocation id as the boot id and reports an inactive unit as not running', async () => {
    const active = createServiceController(config, 'linux', {
      run: fakeRun(() => ({ exitCode: 0, stdout: `ActiveState=active\nInvocationID=${INVOCATION}\n` })).run,
    })!;
    expect(await active.probe()).toEqual({ running: true, bootId: `systemd-${INVOCATION}` });
    const inactive = createServiceController(config, 'linux', {
      run: fakeRun(() => ({ exitCode: 0, stdout: `ActiveState=inactive\nInvocationID=${INVOCATION}\n` })).run,
    })!;
    expect(await inactive.probe()).toEqual({ running: false, bootId: null });
  });

  it('restarts only the configured unit, with fixed arguments', async () => {
    const { run, calls } = fakeRun(() => ({ exitCode: 0, stdout: '' }));
    await createServiceController(config, 'linux', { run })!.restart();
    expect(calls).toEqual([{ file: SYSTEMCTL, args: ['restart', 'projectman.service'] }]);
  });
});

describe('operating system mismatch', () => {
  it('has no controller where the configured service manager does not exist, and tries nothing else', () => {
    const { run, calls } = fakeRun(() => ({ exitCode: 0, stdout: '' }));
    expect(
      createServiceController({ service: { kind: 'launchd', label: 'x.y' } }, 'linux', { run }),
    ).toBeNull();
    expect(
      createServiceController({ service: { kind: 'systemd', unit: 'x.service' } }, 'darwin', { run }),
    ).toBeNull();
    expect(
      createServiceController({ service: { kind: 'systemd', unit: 'x.service' } }, 'win32', { run }),
    ).toBeNull();
    expect(calls).toEqual([]);
    expect(expectedServiceKind('darwin')).toBe('launchd');
    expect(expectedServiceKind('linux')).toBe('systemd');
    expect(expectedServiceKind('win32')).toBeNull();
  });
});

describe('supervisor config file', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'adm-cfg-'));
    await mkdir(path.join(root, 'state'), { mode: 0o700 });
    await mkdir(path.join(root, 'run'), { mode: 0o700 });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const valid = () => ({
    version: 1,
    target: { kind: 'hub' },
    stateDir: path.join(root, 'state'),
    socketPath: path.join(root, 'run', 's.sock'),
    service: { kind: 'systemd', unit: 'projectman.service' },
  });
  const write = async (value: unknown, mode = 0o600) => {
    const file = path.join(root, 'config.json');
    await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value), { mode });
    await chmod(file, mode);
    return file;
  };
  const reason = async (action: Promise<unknown>) => {
    try {
      await action;
    } catch (err) {
      return (err as { reason?: string }).reason;
    }
    return null;
  };

  it('loads a protected, strict configuration', async () => {
    const config = await loadSupervisorConfig(await write(valid()));
    expect(config.service).toEqual({ kind: 'systemd', unit: 'projectman.service' });
  });

  it('refuses a file open to others, a missing file, bad JSON and a relative path', async () => {
    expect(await reason(loadSupervisorConfig(await write(valid(), 0o644)))).toBe('too_open');
    expect(await reason(loadSupervisorConfig(path.join(root, 'absent.json')))).toBe('missing');
    expect(await reason(loadSupervisorConfig(await write('{not json')))).toBe('unsupported');
    expect(await reason(loadSupervisorConfig('config.json'))).toBe('unsupported');
  });

  it('refuses anything the installer did not write: unknown keys, a shell-looking service, a loose state directory', async () => {
    expect(await reason(loadSupervisorConfig(await write({ ...valid(), program: '/bin/sh' })))).toBe(
      'unsupported',
    );
    expect(
      await reason(
        loadSupervisorConfig(
          await write({ ...valid(), service: { kind: 'systemd', unit: 'x.service; reboot' } }),
        ),
      ),
    ).toBe('unsupported');
    expect(await reason(loadSupervisorConfig(await write({ ...valid(), stateDir: 'relative/state' })))).toBe(
      'unsupported',
    );
    await chmod(path.join(root, 'state'), 0o755);
    expect(await reason(loadSupervisorConfig(await write(valid())))).toBe('too_open');
  });
});
