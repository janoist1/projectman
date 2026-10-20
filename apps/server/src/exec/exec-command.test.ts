import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExecCommand, ExecCommandError } from './exec-command';

const execCommand = createExecCommand({ killGraceMs: 200 });
const env = {};

afterEach(() => vi.unstubAllEnvs());

describe('execCommand', () => {
  it('returns both streams and preserves final newlines without interpreting shell syntax', async () => {
    const result = await execCommand(
      process.execPath,
      ['-e', 'process.stdout.write(process.argv[1]); process.stderr.write("error\\n")', '$(echo hi)\n'],
      { env },
    );
    expect(result).toEqual({ stdout: '$(echo hi)\n', stderr: 'error\n', exitCode: 0 });
  });

  it('rejects an unaccepted exit code with its output', async () => {
    await expect(
      execCommand(process.execPath, ['-e', 'console.error("failed"); process.exitCode = 3'], { env }),
    ).rejects.toMatchObject({
      name: 'ExecCommandError',
      reason: 'exit_code',
      exitCode: 3,
      stderr: 'failed\n',
    });
  });

  it('accepts an explicitly allowed nonzero exit code', async () => {
    await expect(
      execCommand(process.execPath, ['-e', 'process.exitCode = 3'], { env, okExitCodes: [3] }),
    ).resolves.toMatchObject({ exitCode: 3 });
  });

  it('accepts any numeric exit code when requested', async () => {
    await expect(
      execCommand(process.execPath, ['-e', 'process.exitCode = 7'], { env, okExitCodes: 'any' }),
    ).resolves.toMatchObject({ exitCode: 7 });
  });

  it('waits for SIGKILL after a timed-out child ignores SIGTERM', async () => {
    const error: unknown = await execCommand(
      process.execPath,
      [
        '-e',
        'process.on("SIGTERM", () => console.log("term")); console.log(process.pid); setInterval(() => {}, 1000)',
      ],
      { env, timeoutMs: 1000 },
    ).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ExecCommandError);
    const failure = error as ExecCommandError;
    expect(failure).toMatchObject({ reason: 'timeout', signal: 'SIGKILL', exitCode: null });
    expect(failure.stdout).toContain('\nterm\n');
    const pid = Number(failure.stdout.toString().split('\n')[0]);
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }));
  });

  it('limits output by bytes rather than decoded characters', async () => {
    await expect(
      execCommand(process.execPath, ['-e', 'process.stdout.write("é".repeat(600))'], {
        env,
        maxOutputBytes: 1024,
      }),
    ).rejects.toMatchObject({ reason: 'output_too_large', exitCode: null });
  });

  it('reports a missing executable as a spawn failure', async () => {
    await expect(execCommand('/nonexistent/projectman-test/command', [], { env })).rejects.toMatchObject({
      reason: 'spawn_failed',
      code: 'ENOENT',
      exitCode: null,
    });
  });

  it('passes the supplied environment without restoring removed parent variables', async () => {
    vi.stubEnv('PM903_PARENT_ONLY', '1');
    const result = await execCommand(process.execPath, ['-e', 'console.log(JSON.stringify(process.env))'], {
      env: { PM903_GIVEN: '1' },
    });
    const childEnv = JSON.parse(result.stdout);
    expect(childEnv.PM903_GIVEN).toBe('1');
    expect(childEnv.PM903_PARENT_ONLY).toBeUndefined();
  });

  it('classifies cancellation separately from timeout', async () => {
    const controller = new AbortController();
    const pending = execCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      env,
      cancelSignal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ reason: 'canceled', exitCode: null });
  });

  it('keeps non-UTF8 bytes intact in buffer mode', async () => {
    const result = await execCommand(
      process.execPath,
      ['-e', 'process.stdout.write(Buffer.from([255, 0, 10]))'],
      {
        env,
        encoding: 'buffer',
      },
    );
    expect(result.stdout).toEqual(Buffer.from([255, 0, 10]));
  });

  it('writes input to stdin and closes it', async () => {
    const result = await execCommand(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], {
      env,
      input: 'input\n',
    });
    expect(result.stdout).toBe('input\n');
  });

  it('reports an external signal even when any exit code is accepted', async () => {
    await expect(
      execCommand(process.execPath, ['-e', 'process.kill(process.pid, "SIGTERM")'], {
        env,
        okExitCodes: 'any',
      }),
    ).rejects.toMatchObject({ reason: 'signal', signal: 'SIGTERM', exitCode: null });
  });

  it('runs from an ESM engine bundle with execa kept as a production dependency', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pm-exec-bundle-'));
    try {
      const result = await build({
        entryPoints: [fileURLToPath(new URL('./index.ts', import.meta.url))],
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node22',
        external: ['execa'],
        write: false,
      });
      const file = join(dir, 'exec.mjs');
      await writeFile(file, result.outputFiles![0]!.contents);
      await symlink(
        dirname(dirname(createRequire(import.meta.url).resolve('execa'))),
        join(dir, 'node_modules'),
        'dir',
      );
      const script = `
        const { execCommand } = await import(process.argv[1]);
        const result = await execCommand(process.execPath, ['-e', 'console.log("bundled")'], { env: {} });
        process.stdout.write(JSON.stringify(result));
      `;
      const run = await execCommand(
        process.execPath,
        ['--input-type=module', '-e', script, pathToFileURL(file).href],
        { env },
      );
      expect(JSON.parse(run.stdout)).toEqual({ stdout: 'bundled\n', stderr: '', exitCode: 0 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
