import { execFileSync } from 'node:child_process';

/** Same resolver for cloud and engine. Environment is read only by the caller in index.ts. */
export function resolveAppVersion(installDir: string, override?: string): string {
  if (override !== undefined) {
    if (!/^[A-Za-z0-9._+-]{1,64}$/.test(override)) throw new Error('Invalid PROJECTMAN_VERSION');
    return override;
  }
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: installDir,
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return /^[a-f0-9]{40,64}$/.test(head) ? head : 'dev';
  } catch {
    return 'dev';
  }
}
