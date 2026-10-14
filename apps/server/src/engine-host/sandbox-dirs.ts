import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { MEMBER_SANDBOX_DIRS, SANDBOX_GIT_CONFIG, SANDBOX_GIT_CONFIG_FILE } from '../contracts';

/**
 * The member's sandbox directory with its npm cache and development data, made if missing (PM-193).
 * Two small local directories and a file; the git settings are written at every call, so the
 * commands' git settings are always the current ones (PM-216). Rejects with the disk's own error.
 */
export async function prepareMemberSandboxDir(dir: string): Promise<void> {
  for (const sub of MEMBER_SANDBOX_DIRS)
    await mkdir(path.join(dir, sub.name), { recursive: true, mode: 0o700 });
  await writeFile(path.join(dir, SANDBOX_GIT_CONFIG_FILE), SANDBOX_GIT_CONFIG, { mode: 0o600 });
}

/**
 * The writable paths a CLI with a sandbox of its own takes from ours (`AgentSandbox.portable`,
 * PM-346), made so it gets an existing path. A failure is logged, never thrown: the start goes on.
 */
export async function preparePortablePaths(
  paths: readonly string[],
  logger: FastifyBaseLogger,
): Promise<void> {
  for (const dir of paths) {
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
    } catch (err) {
      logger.warn({ path: dir, err }, 'could not make a writable path of the session sandbox');
    }
  }
}
