import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { FAKE_CLAUDE, FAKE_CODEX, freePort, tempDirs } from '../src/runner/test-helpers';

const dirs = tempDirs();
afterEach(() => dirs.cleanup());

/** Starts the real entry point with one PROJECTMAN_MEMORY_LOG_SECONDS value; resolves with its exit and output. */
async function startWith(
  mode: 'single' | 'cloud',
  seconds: string,
  waitFor: 'exit' | 'ready',
): Promise<{ code: number | null; output: string }> {
  const home = await dirs.make();
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env,
      HOME: home,
      PROJECTMAN_HOME: path.join(home, 'data'),
      PROJECTMAN_MODE: mode,
      PROJECTMAN_TERMINAL: 'pipe',
      PROJECTMAN_SHUTDOWN_PAUSE_MS: '0',
      PROJECTMAN_MEMORY_LOG_SECONDS: seconds,
      CLAUDE_BIN: FAKE_CLAUDE,
      CODEX_BIN: FAKE_CODEX,
      PORT: String(await freePort()),
      HOST: '127.0.0.1',
      LOG_LEVEL: 'info',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const collect = (data: Buffer) => {
    output += data.toString();
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const closed = once(child, 'close');
  if (waitFor === 'ready') {
    const deadline = Date.now() + 60_000;
    while (!output.includes('projectman server ready') && child.exitCode === null && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 100));
    child.kill('SIGTERM');
  }
  await closed;
  return { code: child.exitCode, output };
}

describe('PROJECTMAN_MEMORY_LOG_SECONDS at startup (PM-775)', () => {
  it.each(['59', '86401', 'abc'])('stops the start on %j with a projectman: message', async (value) => {
    const { code, output } = await startWith('single', value, 'exit');
    expect(code).toBe(1);
    expect(output).toContain('projectman: invalid PROJECTMAN_MEMORY_LOG_SECONDS');
    expect(output).not.toContain('projectman server ready');
  });

  it.each([
    ['single', '0'],
    ['single', '60'],
    ['cloud', '60'],
  ] as const)('starts in %s mode with %j', async (mode, value) => {
    const { output } = await startWith(mode, value, 'ready');
    expect(output).toContain('projectman server ready');
    expect(output).not.toContain('invalid PROJECTMAN_MEMORY_LOG_SECONDS');
  });
});
