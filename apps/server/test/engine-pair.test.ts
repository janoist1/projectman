import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EnginePairingStatus } from '@projectman/shared';
import { runEngineCli } from '../../../scripts/engine/commands';
import type { EngineCliIo } from '../../../scripts/engine/commands';
import { loadCredentials } from '../../../scripts/projectman/config';
import { loadEngineConfig } from '../src/engine-link/engine-config';

/** PM-1449: `pair start | wait | cancel` against a hub answered in the test, without a port or a network. */

const CLOUD = 'https://cloud.example.com';
const INTEGRATOR = 'https://pm.example.com';
const PAIRING_ID = 'epr_0123456789abcdef';
const ENGINE_ID = 'eng_abcdefabcdef';
const LINK_HEADERS = { 'CF-Access-Client-Id': 'engine-id', 'CF-Access-Client-Secret': 'engine-secret' };
const ACCESS = { 'CF-Access-Client-Id': 'client-id', 'CF-Access-Client-Secret': 'client-secret' };

interface Sent {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
}
type Reply = { status: number; json?: unknown; headers?: Record<string, string> };

const approved = (email = 'friend@example.com'): EnginePairingStatus => ({
  state: 'approved',
  engineId: ENGINE_ID,
  engineName: 'Anna Mac',
  approvedBy: { name: 'Anna', email },
  integratorKeyExpiresAt: '2027-11-14T10:00:00.000Z',
});

describe('engine pair (PM-1449)', () => {
  let base: string;
  let home: string;
  let userHome: string;
  let out: string[];
  let err: string[];
  let sent: Sent[];
  let replies: Reply[];
  let clock: number;
  let argvSeen: string[][];
  let stdin: string | null;

  const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
  const mode = (file: string) => statSync(file).mode & 0o777;
  const pendingFile = () => path.join(home, 'pairing-pending.json');
  const pending = () => JSON.parse(readFileSync(pendingFile(), 'utf8')) as Record<string, unknown>;
  const clientDir = () => path.join(userHome, '.config', 'projectman');

  const io = (user: string): EngineCliIo => ({
    env: {},
    cwd: base,
    tmpdir: path.join(base, 'system-tmp'),
    userHome: user,
    readStdin: async () => stdin,
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    startEngine: async () => 0,
    isRunning: () => false,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    fetch: async (input, init) => {
      const headers = Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
      );
      sent.push({
        method: init?.method ?? 'GET',
        url: String(input),
        headers,
        body: typeof init?.body === 'string' ? init.body : null,
      });
      const reply = replies.shift();
      if (!reply) throw new Error('no hub reply left');
      return new Response(reply.json === undefined ? null : JSON.stringify(reply.json), {
        status: reply.status,
        headers: reply.headers ?? {},
      });
    },
  });
  const run = (...argv: string[]) => {
    argvSeen.push(argv);
    return runEngineCli([...argv, '--home', home], io(userHome));
  };
  const start = (...extra: string[]) =>
    run(
      'pair',
      'start',
      '--cloud',
      CLOUD,
      '--name',
      'Anna Mac',
      '--link-headers-file',
      'engine-access.json',
      '--integrator-base-url',
      INTEGRATOR,
      '--integrator-access-headers-file',
      'handoff-access.json',
      ...extra,
    );
  const started = () => ({
    status: 201,
    json: {
      id: PAIRING_ID,
      code: 'WDJB-MJHT',
      expiresAt: '2026-11-14T10:10:00.000Z',
      pollIntervalSeconds: 3,
    },
  });
  /** A started pairing, with the request and output of the start forgotten. */
  const startPairing = async (...extra: string[]) => {
    replies.push(started());
    expect(await start(...extra)).toBe(0);
    sent = [];
    out = [];
    err = [];
  };
  const keys = () => [pending().machineKey as string, pending().integratorKey as string];
  /**
   * Neither key in any argument, environment or output seen so far, nor in a request but for the machine key's own
   * bearer header of the poll and the cancel.
   */
  const expectNoKey = (secrets: string[]) => {
    const requests = sent.map(({ headers: { authorization, ...headers }, ...request }) => {
      if (authorization !== undefined) expect(authorization).toMatch(/^Bearer pme_/);
      return { ...request, headers };
    });
    const seen = JSON.stringify({ out, err, argvSeen, requests, env: process.env });
    for (const secret of secrets) expect(seen).not.toContain(secret);
  };

  beforeEach(() => {
    base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'engine-pair-')));
    home = path.join(base, 'engine-home');
    userHome = path.join(base, 'user');
    mkdirSync(userHome);
    writeFileSync(path.join(base, 'engine-access.json'), JSON.stringify(LINK_HEADERS), { mode: 0o600 });
    writeFileSync(path.join(base, 'handoff-access.json'), JSON.stringify(ACCESS), { mode: 0o600 });
    out = [];
    err = [];
    sent = [];
    replies = [];
    argvSeen = [];
    stdin = null;
    clock = Date.parse('2026-11-14T10:00:00Z');
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  describe('start', () => {
    it('sends only the hashes and prefixes of keys it made, keeps them in a 0600 file and prints the link and code', async () => {
      replies.push(started());
      expect(await start()).toBe(0);

      const [machineKey, integratorKey] = keys() as [string, string];
      expect(machineKey).toMatch(/^pme_[A-Za-z0-9_-]{43}$/);
      expect(integratorKey).toMatch(/^pmi_[A-Za-z0-9_-]{43}$/);
      expect(mode(pendingFile())).toBe(0o600);
      expect(pending()).toMatchObject({ pairingId: PAIRING_ID, cloud: CLOUD, integratorBaseUrl: INTEGRATOR });

      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ method: 'POST', url: `${CLOUD}/engine/pairings` });
      expect(sent[0]!.headers['cf-access-client-id']).toBe('engine-id');
      expect(sent[0]!.headers.authorization).toBeUndefined();
      expect(JSON.parse(sent[0]!.body!)).toEqual({
        name: 'Anna Mac',
        machineKey: { hash: sha256(machineKey), prefix: machineKey.slice(0, 10) },
        integratorKey: { hash: sha256(integratorKey), prefix: integratorKey.slice(0, 12) },
      });

      const printed = out.join('\n');
      expect(out).toContain(`  ${CLOUD}/pair/WDJB-MJHT`);
      expect(printed).toContain(`${CLOUD}/pair and`);
      expect(out).toContain('  WDJB-MJHT');
      expect(printed).toContain('10 minutes');
      expect(printed).not.toContain(sha256(machineKey));
      expect(printed).not.toContain(sha256(integratorKey));
      expectNoKey([machineKey, integratorKey]);
    });

    it.each([
      [
        'a home a server uses',
        'home_in_use',
        () => {
          mkdirSync(home);
          writeFileSync(path.join(home, 'db.sqlite'), '');
        },
      ],
      [
        'an engine configuration without --force',
        'config_exists',
        async () => {
          stdin = 'machine-key-0123456789abcdef\n';
          expect(await run('init', '--cloud', CLOUD, '--id', ENGINE_ID)).toBe(0);
          out = [];
        },
      ],
      [
        'a client key without --replace',
        'connect_file_exists',
        () => {
          mkdirSync(clientDir(), { recursive: true, mode: 0o700 });
          writeFileSync(path.join(clientDir(), 'integrator-key'), 'pmi_old\n', { mode: 0o600 });
        },
      ],
      [
        'a client.json of another hub without --replace',
        'connect_file_exists',
        () => {
          mkdirSync(clientDir(), { recursive: true, mode: 0o700 });
          writeFileSync(path.join(clientDir(), 'client.json'), '{"version":1}\n', { mode: 0o600 });
        },
      ],
      [
        'a different Access file without --replace',
        'connect_file_exists',
        () => {
          mkdirSync(path.join(clientDir(), 'cloud'), { recursive: true, mode: 0o700 });
          writeFileSync(path.join(clientDir(), 'cloud', 'integrator-access-token.json'), '{}\n', {
            mode: 0o600,
          });
        },
      ],
      [
        'a pairing already pending',
        'pairing_in_progress',
        () => {
          mkdirSync(home);
          writeFileSync(pendingFile(), '{}', { mode: 0o600 });
        },
      ],
    ])('refuses %s before asking the hub, and shows no code', async (_case, code, arrange) => {
      await arrange();
      expect(await start()).toBe(1);
      expect(err.join('\n')).toContain(`[${code}]`);
      expect(sent).toHaveLength(0);
      expect(out).toEqual([]);
      if (code !== 'pairing_in_progress') expect(existsSync(pendingFile())).toBe(false);
    });

    it.each([
      [404, 'pairing_unavailable'],
      [429, 'too_many_attempts'],
    ])('stops with exit 1 when the hub answers %i (%s), keeping nothing', async (status, code) => {
      replies.push({
        status,
        json: { error: { code: 'x', message: 'x' } },
        headers: { 'retry-after': '60' },
      });
      expect(await start()).toBe(1);
      expect(err.join('\n')).toContain(`[${code}]`);
      expect(existsSync(pendingFile())).toBe(false);
      expect(out).toEqual([]);
    });

    it('refuses a hub address that is neither https nor loopback before it makes a key or a request', async () => {
      expect(
        await run(
          'pair',
          'start',
          '--cloud',
          'http://cloud.example.com',
          '--name',
          'Anna Mac',
          '--integrator-base-url',
          INTEGRATOR,
        ),
      ).not.toBe(0);
      expect(err.join('\n')).toContain('[cloud_url_insecure]');
      expect(sent).toHaveLength(0);
      expect(existsSync(pendingFile())).toBe(false);
    });
  });

  // PM-1448 review: the poll and the cancel carry the machine key, so a pending file pointing at plain http sends nothing.
  it.each([['wait'], ['cancel']])(
    'pair %s sends no machine key to a plain-http hub address',
    async (command) => {
      await startPairing();
      writeFileSync(pendingFile(), JSON.stringify({ ...pending(), cloud: 'http://cloud.example.com' }));
      expect(await run('pair', command)).toBe(1);
      expect(err.join('\n')).toContain('[cloud_url_insecure]');
      expect(sent).toHaveLength(0);
    },
  );

  describe('wait', () => {
    it('writes what init --cloud and connect write, removes the pending file and names the approver', async () => {
      await startPairing();
      const [machineKey, integratorKey] = keys() as [string, string];
      replies.push({ status: 200, json: approved() });
      expect(await run('pair', 'wait')).toBe(0);

      expect(sent[0]).toMatchObject({ method: 'GET', url: `${CLOUD}/engine/pairings/${PAIRING_ID}` });
      expect(sent[0]!.headers.authorization).toBe(`Bearer ${machineKey}`);
      expect(sent[0]!.headers['cf-access-client-id']).toBe('engine-id');
      expect(existsSync(pendingFile())).toBe(false);

      // The engine side is exactly what init writes for the same id, name, key and link headers file.
      const initHome = path.join(base, 'init-home');
      stdin = `${machineKey}\n`;
      const initIo = io(userHome);
      expect(
        await runEngineCli(
          [
            'init',
            '--cloud',
            CLOUD,
            '--id',
            ENGINE_ID,
            '--name',
            'Anna Mac',
            '--link-headers-file',
            'engine-access.json',
            '--home',
            initHome,
          ],
          initIo,
        ),
      ).toBe(0);
      expect(loadEngineConfig(home)).toEqual(loadEngineConfig(initHome));
      expect(readFileSync(path.join(home, 'engine.key'), 'utf8')).toBe(
        readFileSync(path.join(initHome, 'engine.key'), 'utf8'),
      );
      expect(mode(path.join(home, 'engine.key'))).toBe(0o600);
      expect(mode(path.join(home, 'engine.json'))).toBe(0o600);

      // The client side is what connect writes, and the client reads it.
      expect(mode(clientDir())).toBe(0o700);
      expect(mode(path.join(clientDir(), 'cloud'))).toBe(0o700);
      for (const name of ['integrator-key', 'client.json', 'cloud/integrator-access-token.json'])
        expect(mode(path.join(clientDir(), name)), name).toBe(0o600);
      const credentials = loadCredentials({ home: userHome });
      expect(credentials.key).toBe(integratorKey);
      expect(credentials.baseUrl.origin).toBe(INTEGRATOR);
      expect(credentials.accessHeaders).toEqual(ACCESS);

      const printed = out.join('\n');
      expect(printed).toContain('Anna <friend@example.com>');
      expect(printed).toContain(`"Anna Mac" (${ENGINE_ID})`);
      expect(printed).toContain(path.join(clientDir(), 'integrator-key'));
      expectNoKey([machineKey, integratorKey]);
    });

    it.each([
      ['denied', { state: 'denied' }],
      ['expired', { state: 'expired' }],
      ['cancelled', { state: 'cancelled' }],
      ['unknown', null],
      ['approver_mismatch', approved('stranger@example.com')],
    ] as const)(
      'ends with exit 1 when %s, writes nothing and removes the pending file',
      async (reason, state) => {
        await startPairing('--expect-email', 'Friend@example.com');
        const secrets = keys();
        replies.push(state === null ? { status: 404 } : { status: 200, json: state });
        expect(await run('pair', 'wait')).toBe(1);
        expect(err.join('\n')).toContain(`[${reason}]`);
        expect(err.join('\n')).toContain('Nothing was written');
        expect(existsSync(pendingFile())).toBe(false);
        expect(existsSync(path.join(home, 'engine.json'))).toBe(false);
        expect(existsSync(path.join(home, 'engine.key'))).toBe(false);
        expect(existsSync(clientDir())).toBe(false);
        expectNoKey(secrets);
      },
    );

    it('accepts the expected approver in another letter case', async () => {
      await startPairing('--expect-email', 'Friend@Example.com');
      replies.push({ status: 200, json: approved() });
      expect(await run('pair', 'wait')).toBe(0);
    });

    it('polls at the hub interval and exits 3 at the timeout, keeping the pending file', async () => {
      await startPairing();
      for (let i = 0; i < 20; i += 1)
        replies.push({ status: 200, json: { state: 'pending', expiresAt: '2026-11-14T10:10:00.000Z' } });
      expect(await run('pair', 'wait', '--timeout', '7')).toBe(3);
      expect(sent).toHaveLength(3); // at 0, 3 and 6 seconds
      expect(existsSync(pendingFile())).toBe(true);
      expect(existsSync(path.join(home, 'engine.json'))).toBe(false);
    });

    it('exits 4 and keeps the pending file when a file appeared after start, and writes after --replace', async () => {
      await startPairing();
      const [, integratorKey] = keys() as [string, string];
      mkdirSync(clientDir(), { recursive: true, mode: 0o700 });
      writeFileSync(path.join(clientDir(), 'integrator-key'), 'pmi_other\n', { mode: 0o600 });
      replies.push({ status: 200, json: approved() });
      expect(await run('pair', 'wait')).toBe(4);
      expect(err.join('\n')).toContain('[connect_file_exists]');
      expect(existsSync(pendingFile())).toBe(true);
      expect(existsSync(path.join(home, 'engine.json'))).toBe(false);

      replies.push({ status: 200, json: approved() });
      expect(await run('pair', 'wait', '--replace')).toBe(0);
      expect(loadCredentials({ home: userHome }).key).toBe(integratorKey);
      expect(existsSync(pendingFile())).toBe(false);
    });

    it.each([['0'], ['601'], ['abc']])('refuses --timeout %s as wrong usage', async (value) => {
      expect(await run('pair', 'wait', '--timeout', value)).toBe(2);
    });

    const HOSTILE = '\u202eEvil\u001b[31m\u2028\u2067\u0085';

    it('prints no control, formatting or line-separator character of any value the hub sent', async () => {
      await startPairing('--expect-email', 'friend@example.com');
      replies.push({
        status: 200,
        json: {
          ...approved('stranger@example.com'),
          approvedBy: { name: HOSTILE, email: `${HOSTILE}@example.com` },
          engineName: HOSTILE,
          engineId: `eng_${HOSTILE}`,
          integratorKeyExpiresAt: HOSTILE,
        },
      });
      expect(await run('pair', 'wait')).toBe(1);
      expect(err.join('\n')).toContain('[approver_mismatch]');
      expect(err.join('\n')).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    });

    it.each([
      ['a bidi character', 'Mac\u202e'],
      ['no characters', ''],
      ['more than 64 characters', 'x'.repeat(65)],
    ])(
      'ends with exit 1, not 5, on an engine name with %s from the hub, keeping the pending file for "pair cancel"',
      async (_case, engineName) => {
        await startPairing();
        replies.push({ status: 200, json: { ...approved(), engineName } });
        expect(await run('pair', 'wait')).toBe(1);
        expect(err.join('\n')).toContain('[config_invalid]');
        expect(existsSync(pendingFile())).toBe(true);
        expect(existsSync(path.join(home, 'engine.json'))).toBe(false);
      },
    );

    it.each([
      ['the hub cannot be reached', [], 'hub_unreachable'],
      ['the hub answers an error', [{ status: 500 }], 'hub_error'],
    ] as Array<[string, Reply[], string]>)(
      'exits 5, not 1, and keeps the pending file when %s',
      async (_case, hubReplies, code) => {
        await startPairing();
        replies.push(...hubReplies);
        expect(await run('pair', 'wait')).toBe(5);
        expect(err.join('\n')).toContain(`[${code}]`);
        expect(existsSync(pendingFile())).toBe(true);

        replies.push({ status: 200, json: approved() });
        expect(await run('pair', 'wait')).toBe(0);
      },
    );

    it('exits 5 and keeps the pending file when an invalid engine.json is in the way after the approval', async () => {
      await startPairing();
      mkdirSync(home, { recursive: true });
      writeFileSync(path.join(home, 'engine.json'), '{ not json', { mode: 0o600 });
      replies.push({ status: 200, json: approved() });
      expect(await run('pair', 'wait', '--force')).toBe(5);
      expect(err.join('\n')).toContain('[config_invalid]');
      expect(existsSync(pendingFile())).toBe(true);
    });

    it('exits 5 and keeps the pending file when a server database sits in the home', async () => {
      await startPairing();
      writeFileSync(path.join(home, 'db.sqlite'), '');
      replies.push({ status: 200, json: approved() });
      expect(await run('pair', 'wait')).toBe(5);
      expect(err.join('\n')).toContain('[home_in_use]');
      expect(existsSync(pendingFile())).toBe(true);
    });

    it('keeps exit 1 when no pairing is pending', async () => {
      expect(await run('pair', 'wait')).toBe(1);
      expect(err.join('\n')).toContain('[pairing_missing]');
    });
  });

  describe('pair-only options', () => {
    it.each([
      ['--timeout', '5'],
      ['--expect-email', 'friend@example.com'],
      ['--integrator-base-url', INTEGRATOR],
      ['--integrator-access-headers-file', 'handoff-access.json'],
    ])('%s is refused by a command other than pair', async (flag, value) => {
      expect(await run('status', flag, value)).toBe(2);
      expect(err.join('\n')).toContain(`${flag} is an option of pair only`);
    });
  });

  describe('cancel', () => {
    it('withdraws the pairing on the hub with the machine key and removes the pending file', async () => {
      await startPairing();
      const [machineKey] = keys() as [string];
      replies.push({ status: 204 });
      expect(await run('pair', 'cancel')).toBe(0);
      expect(sent[0]).toMatchObject({ method: 'DELETE', url: `${CLOUD}/engine/pairings/${PAIRING_ID}` });
      expect(sent[0]!.headers.authorization).toBe(`Bearer ${machineKey}`);
      expect(existsSync(pendingFile())).toBe(false);
    });

    it('says so with exit 1 when nothing is pending', async () => {
      expect(await run('pair', 'cancel')).toBe(1);
      expect(err.join('\n')).toContain('[pairing_missing]');
      expect(sent).toHaveLength(0);
    });
  });
});
