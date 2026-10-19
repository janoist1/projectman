import net from 'node:net';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONTROL_SOCKET_NAME } from '@projectman/shared';
import type { ControlRequest } from '@projectman/shared';
import {
  ControlTransportError,
  RELAY_EXIT,
  runControlRelay,
  sendControlRequest,
  startControlSocket,
} from '../src/control';
import type { ControlRelease, ControlSocket } from '../src/control';
import { DomainError } from '../src/kernel';
import { recordingLog as quietLog, ScriptedPause } from './helpers/control';

// The admin channel's client and relay over a real Unix socket (PM-749). Named "integration" because the agent
// sandbox cannot bind one; the full test sandbox runs it, with Unix sockets open below its TMPDIR only
// (PM-754). The input rules are in control-relay.test.ts, the protocol in control.test.ts.

describe('the control client and relay on a socket', () => {
  const dirs: string[] = [];
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const socketPath = () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'pm-rel-')));
    dirs.push(home);
    return join(home, CONTROL_SOCKET_NAME);
  };

  /** A socket server that answers each connection the way `behave` says; it counts the requests it got. */
  async function fake(behave: (connection: net.Socket, request: string) => void) {
    const path = socketPath();
    const requests: string[] = [];
    const server = net.createServer((connection) => {
      let text = '';
      connection.on('error', () => undefined);
      connection.on('data', (chunk) => {
        text += chunk.toString('utf8');
        if (!text.includes('\n')) return;
        requests.push(text.trim());
        behave(connection, text.trim());
      });
    });
    await new Promise<void>((resolve) => server.listen(path, resolve));
    closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    return { path, requests };
  }

  /** The real control socket, with a release port that fails the way the domain does. */
  async function real() {
    const path = socketPath();
    const release: ControlRelease = {
      appVersion: () => 'abc',
      next: () => null,
      claim: () => {
        throw new DomainError('release_state_conflict', 'not approved');
      },
      report: async () => {
        throw new DomainError('release_state_conflict', 'not deploying');
      },
      get: () => {
        throw new DomainError('not_found', 'no such release');
      },
    };
    const socket: ControlSocket = await startControlSocket({
      path,
      pause: new ScriptedPause(),
      log: quietLog(),
      release,
      engines: () => [{ id: 'eng_abcdefghijkl', online: true, version: 'abc', lastSeenAt: null }],
    });
    closers.push(() => socket.close());
    return path;
  }

  const relay = async (path: string, line: string) => {
    const out: string[] = [];
    const err: string[] = [];
    async function* stdin() {
      yield Buffer.from(line);
    }
    const code = await runControlRelay([path], {
      stdin: stdin(),
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
    });
    return { code, stdout: out.join(''), stderr: err.join('') };
  };

  it('answers a request with the response, and a domain refusal is a response too', async () => {
    const path = await real();
    expect(await sendControlRequest(path, { op: 'engine_status' })).toMatchObject({
      ok: true,
      engines: [{ id: 'eng_abcdefghijkl', online: true }],
    });
    expect(
      await sendControlRequest(path, { op: 'release_claim', releaseId: 'rel_1', previousCommit: null }),
    ).toEqual({ ok: false, error: { code: 'release_state_conflict', message: 'not approved' } });
  });

  it('has the relay print the response as the only line of its standard output', async () => {
    const path = await real();
    const claim = await relay(path, '{"op":"release_claim","releaseId":"rel_1","previousCommit":null}\n');
    expect(claim).toEqual({
      code: RELAY_EXIT.done,
      stdout: '{"ok":false,"error":{"code":"release_state_conflict","message":"not approved"}}\n',
      stderr: '',
    });
    const get = await relay(path, '{"op":"release_get","releaseId":"rel_9"}\n');
    expect(get).toMatchObject({ code: RELAY_EXIT.done });
    expect(JSON.parse(get.stdout)).toEqual({
      ok: false,
      error: { code: 'not_found', message: 'no such release' },
    });
  });

  it('fails with a timeout when nobody answers, after one request only', async () => {
    const { path, requests } = await fake(() => undefined);
    const request: ControlRequest = { op: 'release_claim', releaseId: 'rel_1', previousCommit: null };
    await expect(sendControlRequest(path, request, { timeoutMs: 100 })).rejects.toMatchObject({
      failure: 'timeout',
    });
    expect(requests).toEqual([JSON.stringify(request)]);
  });

  it('refuses an answer longer than the limit, with or without its newline', async () => {
    const { path } = await fake((connection) => {
      connection.write(`{"ok":false,"error":{"code":"x","message":"${'m'.repeat(2000)}"}}\n`);
    });
    await expect(
      sendControlRequest(path, { op: 'status' }, { maxResponseBytes: 1000 }),
    ).rejects.toMatchObject({
      failure: 'too_large',
    });
    const endless = await fake((connection) => connection.write('x'.repeat(5000)));
    await expect(
      sendControlRequest(endless.path, { op: 'status' }, { maxResponseBytes: 1000 }),
    ).rejects.toMatchObject({ failure: 'too_large' });
  });

  it('fails on a partial answer: the connection closes before the line is whole', async () => {
    const { path } = await fake((connection) => connection.end('{"ok":true,"pau'));
    const error = await sendControlRequest(path, { op: 'status' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ControlTransportError);
    expect(error).toMatchObject({ failure: 'invalid_response' });
  });

  it('fails on a line that is not a control response', async () => {
    const { path } = await fake((connection) => connection.end('{"ok":"maybe"}\n'));
    await expect(sendControlRequest(path, { op: 'status' })).rejects.toMatchObject({
      failure: 'invalid_response',
    });
  });

  it('fails as unreachable when no socket is there', async () => {
    await expect(sendControlRequest(socketPath(), { op: 'status' })).rejects.toMatchObject({
      failure: 'unreachable',
    });
  });

  it('has the relay exit 1 and print nothing on stdout when the answer is lost, never sending twice', async () => {
    const { path, requests } = await fake((connection) => connection.end('{"ok":true,"pau'));
    const result = await relay(path, '{"op":"release_claim","releaseId":"rel_1","previousCommit":null}\n');
    expect(result).toMatchObject({ code: RELAY_EXIT.transport, stdout: '' });
    expect(result.stderr).toContain('invalid_response');
    expect(requests).toHaveLength(1);
  });
});
