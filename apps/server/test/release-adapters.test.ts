import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../scripts/cloud/config';
import type { CloudContext } from '../../../scripts/cloud/context';
import { Report } from '../../../scripts/cloud/report';
import { machinePort, relayControl, relayRequest } from '../../../scripts/release/adapters';
import { ControlError } from '../../../scripts/release/ports';
import { ACCOUNT, FOREIGN_ACCOUNT } from './helpers/fake-aws';
import { EC2_HOST_ID, Ec2HostWorld } from './helpers/fake-ec2-host';
import { SHA_NEW } from './helpers/fake-host';

/** The real ports over the cloud's fake ssh/SSM transport: the relay's error classes and the machine's checks. */

let world: Ec2HostWorld;
beforeEach(() => {
  world = Ec2HostWorld.configured();
  world.machine.running = true;
});
afterEach(() => world.cleanup());

const context = (): CloudContext => ({
  deps: world.deps(),
  config: loadConfig(world.configFile, world.home),
  report: new Report((line) => world.lines.push(line)),
  secretsDir: world.secretsDir,
  envFile: world.envFile,
});

const caught = async (promise: Promise<unknown>): Promise<ControlError> => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ControlError);
    return error as ControlError;
  }
  throw new Error('the request did not fail');
};

describe('the control relay (PM-751)', () => {
  const next = { op: 'release_next' } as const;

  it('sends one line and returns the board answer', async () => {
    const answer = await relayRequest(context(), next);
    expect(answer).toEqual({ ok: true, pause: null });
    expect(world.machine.controlInputs).toEqual([`${JSON.stringify(next)}\n`]);
  });

  it('turns an ok:false answer into a refusal that carries the board code', async () => {
    world.machine.controlAnswer = {
      code: 0,
      stdout: `${JSON.stringify({ ok: false, error: { code: 'release_deployment_conflict', message: 'busy' } })}\n`,
      stderr: '',
    };
    expect(await caught(relayRequest(context(), next))).toMatchObject({
      kind: 'refused',
      code: 'release_deployment_conflict',
    });
  });

  it('says unavailable when the board is not running: the request never ran', async () => {
    world.machine.running = false;
    expect(await caught(relayRequest(context(), next))).toMatchObject({
      kind: 'unavailable',
      code: 'board_not_running',
    });
  });

  it.each([
    ['a relay failure after it ran', { code: 1, stdout: '', stderr: 'boom' }],
    ['an empty answer', { code: 0, stdout: '', stderr: '' }],
    ['an answer that is not JSON', { code: 0, stdout: 'garbage\n', stderr: '' }],
    ['an answer that is not a response', { code: 0, stdout: '{"hello":1}\n', stderr: '' }],
    ['two lines', { code: 0, stdout: '{"ok":true,"pause":null}\n{"ok":true,"pause":null}\n', stderr: '' }],
  ])('says uncertain on %s: the request may have been applied', async (_name, answer) => {
    world.machine.controlAnswer = answer;
    expect(await caught(relayRequest(context(), next))).toMatchObject({ kind: 'uncertain' });
  });

  it('never carries a raw answer or stderr in the error', async () => {
    world.machine.controlAnswer = { code: 1, stdout: 'SECRET-OUT', stderr: 'SECRET-ERR' };
    const error = await caught(relayRequest(context(), next));
    expect(`${error.code} ${error.message}`).not.toMatch(/SECRET/);
  });

  it('refuses a deployment answer without the release, the drain and the schema as uncertain', async () => {
    world.machine.controlAnswer = { code: 0, stdout: '{"ok":true,"pause":null}\n', stderr: '' };
    expect(await caught(relayControl(context()).deployGet('rel_1'))).toMatchObject({
      kind: 'uncertain',
      code: 'bad_answer',
    });
  });

  it('answers the engines and the version of the board', async () => {
    world.machine.controlAnswer = {
      code: 0,
      stdout: `${JSON.stringify({
        ok: true,
        pause: null,
        appVersion: SHA_NEW,
        engines: [{ id: 'eng_abcdefghijkl', online: true, version: SHA_NEW, lastSeenAt: null }],
      })}\n`,
      stderr: '',
    };
    expect(await relayControl(context()).engines()).toEqual({
      appVersion: SHA_NEW,
      engines: [{ id: 'eng_abcdefghijkl', online: true, version: SHA_NEW, lastSeenAt: null }],
    });
  });
});

describe('the cloud machine port (PM-751)', () => {
  const expected = { accountId: ACCOUNT, instanceId: EC2_HOST_ID };

  it('accepts the configured account and the running instance', async () => {
    await expect(machinePort(context(), expected).verifyTarget()).resolves.toBeUndefined();
  });

  it('refuses another AWS account', async () => {
    await expect(
      machinePort(context(), { ...expected, accountId: FOREIGN_ACCOUNT }).verifyTarget(),
    ).rejects.toMatchObject({ exitCode: 2, message: expect.stringContaining('account') });
  });

  it('refuses another instance', async () => {
    await expect(
      machinePort(context(), { ...expected, instanceId: 'i-0fedcba9876543210' }).verifyTarget(),
    ).rejects.toMatchObject({ exitCode: 2 });
  });

  it('refuses a stopped instance', async () => {
    world.instances[0]!.State.Name = 'stopped';
    await expect(machinePort(context(), expected).verifyTarget()).rejects.toThrow();
  });

  it('reads the current image from the deploy record, and null when it names no image', async () => {
    const port = machinePort(context(), expected);
    world.machine.preload(SHA_NEW, 'v1');
    expect(await port.current()).toBeNull();
    const imageId = `sha256:${'1'.repeat(64)}`;
    world.machine.deploy = {
      current: { sha: SHA_NEW, ref: 'v1', at: '2026-10-01T10:00:00Z', imageId, platform: 'linux/arm64' },
      previous: null,
      lastStoppedAt: null,
    };
    expect(await port.current()).toEqual({ commit: SHA_NEW, imageId, platform: 'linux/arm64' });
  });
});
