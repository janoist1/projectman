import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_CONTROL_REQUEST_BYTES } from '@projectman/shared';
import { runCloud } from '../../../scripts/cloud/commands';
import { HostWorld, REPO_ROOT, unquoteWords } from './helpers/fake-host';

/** `npm run cloud -- release-control` (PM-749): the Mac end of the protected admin channel. */

const TARGET = { projectKey: 'PM', repo: 'projectman' };
const STATUS = '{"op":"status"}\n';
const CLAIM = '{"op":"release_claim","releaseId":"rel_1","previousCommit":null}\n';

let world: HostWorld;
beforeEach(() => {
  world = HostWorld.ready();
  world.machine.preload('1'.repeat(40), 'v2026.10.1');
  world.writeConfig({ releaseTarget: TARGET });
});
afterEach(() => world.cleanup());

async function* chunks(...parts: (string | Uint8Array)[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield typeof part === 'string' ? Buffer.from(part) : part;
}

/** Runs the command with `input` on the standard input; the outputs are kept apart. */
async function relay(input: AsyncIterable<Uint8Array> | undefined, ...flags: string[]) {
  world.lines.length = 0;
  world.errors.length = 0;
  const code = await runCloud(
    ['release-control', '--config', world.configFile, ...flags],
    world.deps({ stdin: input }),
  );
  return { code, stdout: world.lines.join('\n'), stderr: world.errors.join('\n') };
}

const relayed = () => world.hostCalls.filter((call) => call.subcommand === 'release-control');

describe('the relay command', () => {
  it('hands the request line to the fixed host command and prints only the response line', async () => {
    world.machine.controlAnswer = {
      code: 0,
      stdout: '{"ok":true,"pause":null,"appVersion":"abc"}\n',
      stderr: '',
    };
    const result = await relay(chunks(STATUS));
    expect(result).toMatchObject({ code: 0, stdout: '{"ok":true,"pause":null,"appVersion":"abc"}' });
    expect(relayed()).toHaveLength(1);
    expect(relayed()[0]!.args).toEqual([]);
    expect(relayed()[0]!.input).toBe(STATUS);
    expect(world.machine.controlInputs).toEqual([STATUS]);
    // The report (the firewall steps and the like) is for the standard error, never the response channel.
    expect(result.stderr).toContain('firewall-open');
    expect(result.stdout).not.toContain('firewall');
  });

  it('puts nothing of the input into the remote command', async () => {
    const hostile = `{"op":"pause","reason":"'; touch /tmp/pwned; echo '$(id) \`id\` docker exec evil"}\n`;
    await relay(chunks(hostile));
    const call = relayed()[0]!;
    const words = unquoteWords(call.remote);
    expect(words.slice(0, 3)).toEqual(['sudo', 'bash', '-c']);
    expect(words[3]).toBe(readFileSync(path.join(REPO_ROOT, 'deploy/aws/host.sh'), 'utf8'));
    expect(words.slice(4)).toEqual(['host.sh', 'release-control']);
    expect(call.input).toBe(hostile);
    expect(call.remote).not.toContain('touch /tmp/pwned');
  });

  it('passes a domain refusal on unchanged and exits 0', async () => {
    const refusal = '{"ok":false,"error":{"code":"release_state_conflict","message":"not approved"}}';
    world.machine.controlAnswer = { code: 0, stdout: `${refusal}\n`, stderr: '' };
    expect(await relay(chunks(CLAIM))).toMatchObject({ code: 0, stdout: refusal });
  });

  it('relays engine_status, with or without a release target', async () => {
    const answer = {
      ok: true,
      pause: null,
      engines: [{ id: 'eng_abcdefghijkl', online: true, version: 'abc', lastSeenAt: null }],
    };
    world.machine.controlAnswer = { code: 0, stdout: `${JSON.stringify(answer)}\n`, stderr: '' };
    expect(JSON.parse((await relay(chunks('{"op":"engine_status"}\n'))).stdout)).toEqual(answer);
    world.writeConfig();
    expect((await relay(chunks('{"op":"engine_status"}\n'))).code).toBe(0);
  });

  it('prints only the fields of the contract, so nothing else the machine said leaves', async () => {
    world.machine.controlAnswer = {
      code: 0,
      stdout: '{"ok":true,"pause":null,"token":"TOP-SECRET-VALUE"}\n',
      stderr: 'TOP-SECRET-VALUE\n',
    };
    const result = await relay(chunks(STATUS));
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('{"ok":true,"pause":null}');
    expect(result.stderr).not.toContain('TOP-SECRET-VALUE');
  });

  it.each([
    ['an empty input', () => chunks()],
    ['a request without a newline', () => chunks('{"op":"status"}')],
    ['two requests', () => chunks(STATUS, STATUS)],
    ['a request and more text', () => chunks(STATUS, '\n')],
    ['broken JSON', () => chunks('{"op":\n')],
    ['an approval', () => chunks('{"op":"release_approve","releaseId":"rel_1"}\n')],
    ['a missing field', () => chunks('{"op":"release_claim","releaseId":"rel_1"}\n')],
    ['bytes that are not UTF-8', () => chunks(Buffer.from([0x7b, 0xff, 0x7d, 0x0a]))],
    [
      'more than 16 KiB',
      () => chunks(`{"op":"pause","reason":"${'x'.repeat(MAX_CONTROL_REQUEST_BYTES)}"}\n`),
    ],
    ['no standard input at all', () => undefined],
  ])('refuses %s with status 2, before any connection', async (_name, input) => {
    const result = await relay(input());
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(world.hostCalls).toHaveLength(0);
    expect(world.aws.callsTo('put-instance-public-ports')).toHaveLength(0);
  });

  it('does not echo a refused request', async () => {
    const result = await relay(chunks('docker exec evil-container sh\n'));
    expect(result.code).toBe(2);
    expect(result.stderr).not.toContain('evil-container');
  });

  it('refuses a release request when the configuration names no release target', async () => {
    world.writeConfig();
    for (const line of [CLAIM, '{"op":"release_next"}\n', '{"op":"release_get","releaseId":"rel_1"}\n']) {
      const result = await relay(chunks(line));
      expect(result).toMatchObject({ code: 2, stdout: '' });
      expect(result.stderr).toContain('releaseTarget');
    }
    expect(world.hostCalls).toHaveLength(0);
  });

  it('exits 1 with nothing on the standard output when the machine cannot be reached, and sends once', async () => {
    world.machine.failures.set('release-control', {
      code: 255,
      stdout: '',
      stderr: 'ssh: connection lost\n',
    });
    const result = await relay(chunks(CLAIM));
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(relayed()).toHaveLength(1);
  });

  it('exits 1 when the relay itself fails, and never retries a request', async () => {
    world.machine.failures.set('release-control', {
      code: 1,
      stdout: '',
      stderr: 'unreachable: no answer\n',
    });
    const result = await relay(chunks(CLAIM));
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('unreachable');
    expect(relayed()).toHaveLength(1);
  });

  it('exits 2 when the machine refuses because the board does not run', async () => {
    world.machine.running = false;
    const result = await relay(chunks(STATUS));
    expect(result).toMatchObject({ code: 2, stdout: '' });
    expect(result.stderr).toContain('not running');
  });

  it.each([
    ['nothing', ''],
    ['two lines', '{"ok":true,"pause":null}\n{"ok":true,"pause":null}\n'],
    ['text that is not a response', 'hello\n'],
    ['JSON of another shape', '{"status":"fine"}\n'],
    ['a line over 64 KiB', `{"ok":false,"error":{"code":"x","message":"${'m'.repeat(65_536)}"}}\n`],
  ])('exits 1 and prints nothing when the machine answers %s', async (_name, stdout) => {
    world.machine.controlAnswer = { code: 0, stdout, stderr: '' };
    const result = await relay(chunks(STATUS));
    expect(result).toMatchObject({ code: 1, stdout: '' });
  });

  it.each([['--nonsense'], ['--dry-run-please'], ['extra']])(
    'exits 64 for the stray argument %s',
    async (flag) => {
      const result = await relay(chunks(STATUS), flag);
      expect(result.code).toBe(64);
      expect(result.stdout).toBe('');
      expect(world.hostCalls).toHaveLength(0);
    },
  );
});
