import net from 'node:net';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONTROL_SOCKET_NAME } from '@projectman/shared';
import { runControl, sendControlRequest } from '../../../scripts/control/client';
import { serveControlConnection, startControlSocket } from '../src/control';
import type { ControlPause } from '../src/control';
import { DomainError } from '../src/domain';
import {
  pausedSession as session,
  pauseStatus as status,
  recordingLog as quietLog,
  ScriptedPause,
} from './helpers/control';

// The protocol and the command run over a loopback port here, because a Unix socket cannot be bound in
// the agent sandbox; the socket file itself (mode, leftovers, the app) is control-socket.integration.test.ts.

describe('the control protocol and command', () => {
  const servers: net.Server[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0))
      await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** The protocol on a loopback port. */
  async function open(pause: ControlPause = new ScriptedPause()) {
    const log = quietLog();
    const server = net.createServer((connection) => serveControlConnection(connection, pause, log));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const target = { host: '127.0.0.1', port: (server.address() as net.AddressInfo).port };
    return { target, log };
  }

  /** The command's run, with its output and without waiting a real second. */
  async function control(target: net.NetConnectOpts | undefined, args: string[], clock?: () => number) {
    const out: string[] = [];
    const err: string[] = [];
    let slept = 0;
    const code = await runControl(args, {
      target,
      env: { PROJECTMAN_HOME: '/nonexistent-home' },
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      sleep: async (ms) => {
        slept += ms;
      },
      now: clock,
      pollMs: 1000,
    });
    return { code, out: out.join('\n'), err: err.join('\n'), slept };
  }

  /** Raw lines over a fresh connection, for what the client library would never send. */
  const rawLines = (target: net.NetConnectOpts, text: string, count: number) =>
    new Promise<string[]>((resolve, reject) => {
      const connection = net.connect(target);
      let buffer = '';
      connection.setEncoding('utf8');
      connection.once('connect', () => connection.write(text));
      connection.on('data', (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split('\n').filter(Boolean);
        if (lines.length >= count) {
          connection.destroy();
          resolve(lines);
        }
      });
      connection.on('error', reject);
    });

  describe('the protocol', () => {
    it('answers the four requests', async () => {
      const pause = new ScriptedPause();
      pause.current = status([session({ point: 'idle', waitingFor: null })]);
      const { target } = await open(pause);
      expect(await sendControlRequest(target, { op: 'status' })).toEqual({ ok: true, pause: pause.current });
      await sendControlRequest(target, { op: 'pause', reason: 'Fictional deploy', forceAfterMs: 5000 });
      expect(pause.pauseRequests).toEqual([{ reason: 'Fictional deploy', forceAfterMs: 5000 }]);
      await sendControlRequest(target, { op: 'force' });
      expect(await sendControlRequest(target, { op: 'resume' })).toEqual({ ok: true, pause: null });
      expect(pause.requests).toEqual(['status', 'pause', 'force', 'resume']);
    });

    it('answers several requests on one connection, in order', async () => {
      const { target } = await open();
      const lines = await rawLines(target, '{"op":"status"}\n{"op":"nonsense"}\n{"op":"resume"}\n', 3);
      expect(JSON.parse(lines[0]!)).toEqual({ ok: true, pause: null });
      expect(JSON.parse(lines[1]!)).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
      expect(JSON.parse(lines[2]!)).toEqual({ ok: true, pause: null });
    });

    it.each([
      ['not JSON', 'pause please'],
      ['an unknown operation', '{"op":"restart"}'],
      ['a deadline over the limit', '{"op":"pause","forceAfterMs":999999999}'],
      ['an empty reason', '{"op":"pause","reason":"  "}'],
    ])('refuses %s with invalid_request', async (_name, line) => {
      const pause = new ScriptedPause();
      const { target } = await open(pause);
      const [answer] = await rawLines(target, `${line}\n`, 1);
      expect(JSON.parse(answer!)).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
      expect(pause.requests).toEqual([]);
    });

    it('refuses a line that never ends', async () => {
      const { target } = await open();
      const [answer] = await rawLines(target, 'x'.repeat(20_000), 1);
      expect(JSON.parse(answer!)).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    });

    it('passes the code of a domain error on and keeps serving', async () => {
      const pause = new ScriptedPause();
      pause.pause = async () => {
        throw new DomainError('insufficient_access', 'not for you');
      };
      const { target } = await open(pause);
      expect(await sendControlRequest(target, { op: 'pause' })).toEqual({
        ok: false,
        error: { code: 'insufficient_access', message: 'not for you' },
      });
      expect(await sendControlRequest(target, { op: 'status' })).toEqual({ ok: true, pause: null });
    });

    it('does not open on a path too long for a socket, and says so', async () => {
      const log = quietLog();
      const socket = await startControlSocket({
        path: join('/tmp', 'x'.repeat(120), CONTROL_SOCKET_NAME),
        pause: new ScriptedPause(),
        log,
      });
      expect(log.lines).toEqual([
        'error: the control socket path is too long for a socket; it is not opened',
      ]);
      await socket.close();
    });
  });

  describe('the command', () => {
    it('pauses with the deadline and the reason, and prints the pause', async () => {
      const pause = new ScriptedPause();
      pause.current = status([session({ point: 'idle', waitingFor: null })], { reason: 'Fictional deploy' });
      const { target } = await open(pause);
      const result = await control(target, ['pause', '--force-after', '45', '--reason', 'Fictional deploy']);
      expect(result.code).toBe(0);
      expect(pause.pauseRequests).toEqual([{ reason: 'Fictional deploy', forceAfterMs: 45_000 }]);
      expect(result.out).toContain('Pause pau_1: paused');
      expect(result.out).toContain('reason: Fictional deploy');
    });

    it('prints the status as JSON for a script', async () => {
      const pause = new ScriptedPause();
      pause.current = status([session({ point: 'idle', waitingFor: null })]);
      const { target } = await open(pause);
      const result = await control(target, ['status', '--json']);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.out)).toEqual(pause.current);
      expect((await control(target, ['resume'])).out).toBe('No pause is open.');
    });

    it('waits until every session has stopped, and names the ones it waits for', async () => {
      const pause = new ScriptedPause();
      const working = [
        session(),
        session({ sessionId: 'ses_2', member: 'qa', workItem: { type: 'general' } }),
      ];
      pause.current = status(working);
      pause.polls = [
        status(working),
        status([session({ point: 'idle', waitingFor: null }), working[1]!]),
        status(working.map((s) => ({ ...s, point: 'idle' as const, waitingFor: null }))),
      ];
      const { target } = await open(pause);
      const result = await control(target, ['pause', '--wait']);
      expect(result.code).toBe(0);
      expect(result.out).toContain('still working: dev (AR, AR-1), waiting for Bash');
      expect(result.out).toContain('still working: qa (AR, general chat), waiting for Bash');
      expect(result.out).toContain('All 2 sessions have stopped.');
      expect(result.slept).toBe(3000);
    });

    it('keeps stdout to the final answer with --json --wait', async () => {
      const pause = new ScriptedPause();
      const done = status([session({ point: 'idle', waitingFor: null })]);
      pause.current = status([session()]);
      pause.polls = [done];
      const { target } = await open(pause);
      const result = await control(target, ['pause', '--wait', '--json']);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.out)).toEqual(done);
      expect(result.err).toContain('still working: dev');
    });

    it('times out with 1 and names the stragglers', async () => {
      const pause = new ScriptedPause();
      pause.current = status([session()]);
      pause.polls = [status([session()])];
      const { target } = await open(pause);
      let clock = 0;
      const result = await control(
        target,
        ['pause', '--wait', '--force-after', '10', '--timeout', '5'],
        () => (clock += 1000),
      );
      expect(result.code).toBe(1);
      expect(result.err).toContain('timed out after 5 s');
      expect(result.out).toContain('still working: dev (AR, AR-1)');
    });

    it('gives up with 1 when somebody resumed the pause meanwhile', async () => {
      const pause = new ScriptedPause();
      pause.current = status([session()]);
      pause.polls = [null];
      const { target } = await open(pause);
      const result = await control(target, ['pause', '--wait']);
      expect(result.code).toBe(1);
      expect(result.err).toContain('resumed while waiting');
    });

    it('exits 2 when the server does not run', async () => {
      const home = realpathSync(mkdtempSync(join(tmpdir(), 'pm-ctl-')));
      dirs.push(home);
      const result = await control(undefined, ['status', '--home', home]);
      expect(result.code).toBe(2);
      expect(result.err).toContain('the server does not run');
    });

    it('exits 1 with a message for a server refusal', async () => {
      const pause = new ScriptedPause();
      pause.pause = async () => {
        throw new DomainError('insufficient_access', 'not for you');
      };
      const { target } = await open(pause);
      const result = await control(target, ['pause']);
      expect(result.code).toBe(1);
      expect(result.err).toContain('refused: insufficient_access: not for you');
    });

    it.each([
      [['frobnicate']],
      [[]],
      [['pause', '--force-after']],
      [['pause', '--force-after', '-1']],
      [['pause', '--force-after', '999999']],
      [['pause', '--nonsense']],
      [['resume', '--wait']],
      [['status', '--reason', 'x']],
      [['pause', '--timeout', '5']],
    ])('exits 1 with the usage for %j', async (args) => {
      const pause = new ScriptedPause();
      const { target } = await open(pause);
      const result = await control(target, args);
      expect(result.code).toBe(1);
      expect(result.err).toContain('usage');
      expect(pause.requests).toEqual([]);
    });
  });
});
