import { execFile } from 'node:child_process';

/** Same resolver for cloud and engine. Environment is read only by the caller in index.ts. */
export async function resolveAppVersion(installDir: string | null, override?: string): Promise<string> {
  const explicit = override?.trim();
  if (explicit && /^[A-Za-z0-9._+-]{1,64}$/.test(explicit)) return explicit;
  if (installDir === null) return 'dev';
  try {
    const head = await new Promise<string>((resolve, reject) => {
      execFile(
        'git',
        ['-C', installDir, 'rev-parse', '--verify', '-q', 'HEAD'],
        {
          encoding: 'utf8',
          timeout: 5000,
        },
        (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
      );
    });
    return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head) ? head : 'dev';
  } catch {
    return 'dev';
  }
}
