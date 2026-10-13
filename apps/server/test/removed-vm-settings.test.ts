import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { FAKE_CLAUDE, FAKE_CODEX, freePort, tempDirs, waitFor } from '../src/runner/test-helpers';

const dirs = tempDirs();
afterEach(() => dirs.cleanup());

describe('removed VM installation settings', () => {
  it.each([false, true])('starts the server with obsolete settings present=%s', async (obsolete) => {
    const home = await dirs.make();
    const removed = {
      PROJECTMAN_BOUNDARY_CONFIG: '/nonexistent/obsolete-boundary.json',
      PROJECTMAN_EXECUTION_PROFILE: 'obsolete-invalid-profile',
      PROJECTMAN_VM_READINESS_REPORT: '/nonexistent/obsolete-report.json',
      PROJECTMAN_VM_REPORT_MAX_AGE_MINUTES: 'invalid-age',
      PROJECTMAN_GITHUB_PUBLISH_TOKEN_FILE: '/nonexistent/obsolete-token',
    };
    const env = { ...process.env };
    for (const name of Object.keys(removed)) delete env[name];
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: {
        ...env,
        ...(obsolete ? removed : {}),
        HOME: home,
        PROJECTMAN_HOME: path.join(home, 'data'),
        PROJECTMAN_MODE: 'single',
        PROJECTMAN_TERMINAL: 'pipe',
        PROJECTMAN_SHUTDOWN_PAUSE_MS: '0',
        CLAUDE_BIN: FAKE_CLAUDE,
        CODEX_BIN: FAKE_CODEX,
        PORT: String(await freePort()),
        HOST: '127.0.0.1',
        LOG_LEVEL: 'info',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data: Buffer) => {
      output += data.toString();
    });
    child.stderr.on('data', (data: Buffer) => {
      output += data.toString();
    });
    const closed = once(child, 'close');
    try {
      await waitFor(
        () => {
          if (child.exitCode !== null) throw new Error(output);
          return output.includes('projectman server ready');
        },
        { what: 'server startup' },
      );
      const warnings = output
        .split('\n')
        .filter((line) => line.includes('ignoring removed managed VM settings'));
      expect(warnings).toHaveLength(obsolete ? 1 : 0);
      if (obsolete) {
        const warning = JSON.parse(warnings[0]!);
        expect(warning.level).toBe(40);
        expect(warning.variables).toEqual(Object.keys(removed));
        for (const value of Object.values(removed)) expect(warnings[0]).not.toContain(value);
      }
    } finally {
      child.kill('SIGTERM');
      await closed;
    }
  });
});
