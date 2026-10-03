import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONTROL_SOCKET_NAME } from '@projectman/shared';
import { runControl, sendControlRequest } from '../../../scripts/control/client';
import { startControlSocket } from '../src/control';
import type { ControlSocket } from '../src/control';
import { createAppHarness } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import {
  pausedSession as session,
  pauseStatus as status,
  recordingLog as quietLog,
  ScriptedPause,
} from './helpers/control';

// The socket file itself. Named "integration" because the agent sandbox cannot bind a Unix socket, like
// it cannot open a pseudo-terminal: the config leaves these files out there (PROJECTMAN_SKIP_PTY_TESTS)
// and the integrating session runs them. The protocol is tested in control.test.ts.

describe('the control socket file', () => {
  const dirs: string[] = [];
  const sockets: ControlSocket[] = [];
  let h: AppHarness | undefined;
  afterEach(async () => {
    for (const socket of sockets.splice(0)) await socket.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    await h?.close();
    h = undefined;
  });

  async function open(pause = new ScriptedPause(), log = quietLog()) {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'pm-ctl-')));
    dirs.push(home);
    const path = join(home, CONTROL_SOCKET_NAME);
    const socket = await startControlSocket({ path, pause, log });
    sockets.push(socket);
    return { home, path, socket, log };
  }

  it('opens with mode 0600 and answers', async () => {
    const pause = new ScriptedPause();
    pause.current = status([session({ point: 'idle', waitingFor: null })]);
    const { path } = await open(pause);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(await sendControlRequest(path, { op: 'status' })).toEqual({ ok: true, pause: pause.current });
  });

  it('removes its file on close, and replaces a leftover file nobody answers on', async () => {
    const { path, socket } = await open();
    await socket.close();
    expect(existsSync(path)).toBe(false);
    // A dead server's file: a regular file where the socket was.
    writeFileSync(path, '');
    chmodSync(path, 0o600);
    sockets.push(await startControlSocket({ path, pause: new ScriptedPause(), log: quietLog() }));
    expect(await sendControlRequest(path, { op: 'status' })).toEqual({ ok: true, pause: null });
  });

  it('leaves a socket another server answers on alone, and says so', async () => {
    const first = await open();
    const log = quietLog();
    const second = await startControlSocket({ path: first.path, pause: new ScriptedPause(), log });
    expect(log.lines.some((l) => l.startsWith('error: another server answers'))).toBe(true);
    await second.close();
    expect(await sendControlRequest(first.path, { op: 'status' })).toEqual({ ok: true, pause: null });
  });

  it('is served by the app: the command pauses and resumes the instance as the control source', async () => {
    h = await createAppHarness({ app: { controlSocket: true } });
    const run = async (args: string[]) => {
      const out: string[] = [];
      const code = await runControl([...args, '--home', h!.home], {
        out: (line) => out.push(line),
        err: (line) => out.push(line),
        sleep: async () => undefined,
      });
      return { code, out: out.join('\n') };
    };
    const paused = await run(['pause', '--wait', '--force-after', '1', '--reason', 'Fictional deploy']);
    expect(paused.code).toBe(0);
    const open = h.app.projectman.repos.pauses.open();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      scope: 'instance',
      kind: 'manual',
      source: 'control',
      requestedBy: null,
      reason: 'Fictional deploy',
      forceAfterMs: 1000,
    });
    expect(h.app.projectman.domain.pauses.isPaused('AR')).toBe(true);
    expect((await run(['status', '--json'])).out).toContain('"source":"control"');
    expect((await run(['resume'])).out).toBe('No pause is open.');
    expect(h.app.projectman.repos.pauses.open()).toHaveLength(0);
    expect(h.app.projectman.domain.pauses.isPaused('AR')).toBe(false);
  });

  it('closes with the app', async () => {
    h = await createAppHarness({ app: { controlSocket: true } });
    const path = join(h.home, CONTROL_SOCKET_NAME);
    expect(existsSync(path)).toBe(true);
    const closing = h;
    h = undefined;
    await closing.close();
    expect(existsSync(path)).toBe(false);
  });
});
