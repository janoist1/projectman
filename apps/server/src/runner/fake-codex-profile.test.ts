import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveCommand } from './cli';
import { FAKE_CODEX, tempDirs } from './test-helpers';

const dirs = tempDirs();
afterEach(() => dirs.cleanup());

describe('fake Codex permission profiles', () => {
  it.each([
    { writes: false, legacy: [], expected: 'read-only' },
    { writes: true, legacy: [], expected: 'workspace-write' },
    { writes: true, legacy: ['--sandbox', 'read-only'], expected: 'read-only' },
    { writes: false, legacy: ['-c', 'sandbox_mode="danger-full-access"'], expected: 'danger-full-access' },
    {
      writes: false,
      legacy: ['-c', 'sandbox_workspace_write.writable_roots=["/fictional"]'],
      expected: 'workspace-write',
    },
  ])('records the effective profile and legacy precedence %#', async ({ writes, legacy, expected }) => {
    const cwd = await dirs.make();
    const home = await dirs.make();
    const profile = `{extends=":read-only",filesystem={":root"="read"${writes ? ',":workspace_roots"={"."="write"}' : ''}}}`;
    const command = resolveCommand(FAKE_CODEX, [
      '--no-alt-screen',
      '--ask-for-approval',
      'never',
      '-c',
      'default_permissions="projectman"',
      '-c',
      `permissions.projectman=${profile}`,
      '-c',
      `projects={${JSON.stringify(cwd)}={trust_level="trusted"}}`,
      ...legacy,
      '--',
      'Fictional profile probe',
    ]);
    const child = spawn(command.file, command.args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        CODEX_HOME: home,
        FAKE_CODEX_STARTUP_DELAY_MS: '0',
        FAKE_CODEX_WORK_DELAY_MS: '0',
      },
    });
    const closed = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', () => resolve());
    });
    let stderr = '';
    child.stdout.resume();
    child.stderr.on('data', (data) => {
      stderr += String(data);
    });
    try {
      let policy: unknown;
      await vi.waitFor(
        async () => {
          const files = await readdir(home, { recursive: true });
          const rollout = files.find((file) => file.endsWith('.jsonl'));
          expect(rollout).toBeDefined();
          const lines = (await readFile(path.join(home, rollout!), 'utf8')).trim().split('\n');
          for (const line of lines) {
            const row = JSON.parse(line) as { type: string; payload: { sandbox_policy?: unknown } };
            if (row.type === 'turn_context') policy = row.payload.sandbox_policy;
          }
          expect(policy).toBeDefined();
        },
        { timeout: 5_000, interval: 20 },
      );
      expect(policy).toEqual({ type: expected, profile: 'projectman' });
      expect(stderr.includes('legacy sandbox settings override')).toBe(legacy.length > 0);
    } finally {
      child.kill('SIGTERM');
      await closed;
    }
  });
});
