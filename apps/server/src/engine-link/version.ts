import { RELEASE_TAG_PATTERN } from '@projectman/shared';
import { execCommand } from '../exec';
import { readEnginePackage } from './engine-package';

/**
 * The release tag on the installation's checked-out commit (PM-542): the first `vYYYY.M.D` tag that points at
 * HEAD. Null when git is missing, fails, takes over 2 seconds or the commit has no release tag. Never throws.
 * The release watcher tags after the switch, so only a found tag may be remembered by the caller.
 * An engine package (PM-1104) has no git: its manifest names the tag, and a manifest without one means none.
 */
export async function resolveAppTag(installDir: string): Promise<string | null> {
  const packaged = readEnginePackage(installDir);
  if (packaged) return packaged.tag !== null && RELEASE_TAG_PATTERN.test(packaged.tag) ? packaged.tag : null;
  try {
    const { stdout: out } = await execCommand('git', ['-C', installDir, 'tag', '--points-at', 'HEAD'], {
      env: { ...process.env },
      timeoutMs: 2000,
    });
    return (
      out
        .split('\n')
        .map((line) => line.trim())
        .find((line) => RELEASE_TAG_PATTERN.test(line)) ?? null
    );
  } catch {
    return null;
  }
}

/**
 * The tag reader of the running server: `resolveAppTag` of the installation, with a found tag remembered. Null
 * without asking git when `PROJECTMAN_VERSION` sets the version (a cloud package has no git checkout).
 */
export function createAppTagReader(installDir: string, override?: string): () => Promise<string | null> {
  if (versionOverride(override)) return async () => null;
  let found: string | null = null;
  return async () => {
    found ??= await resolveAppTag(installDir);
    return found;
  };
}

function versionOverride(override?: string): string | null {
  const explicit = override?.trim();
  return explicit && /^[A-Za-z0-9._+-]{1,64}$/.test(explicit) ? explicit : null;
}

/** Same resolver for cloud and engine. Environment is read only by the caller in index.ts. */
export async function resolveAppVersion(installDir: string | null, override?: string): Promise<string> {
  const explicit = versionOverride(override);
  if (explicit) return explicit;
  if (installDir === null) return 'dev';
  const packaged = readEnginePackage(installDir);
  if (packaged) return packaged.version;
  try {
    const { stdout } = await execCommand('git', ['-C', installDir, 'rev-parse', '--verify', '-q', 'HEAD'], {
      env: { ...process.env },
      timeoutMs: 5000,
    });
    const head = stdout.trim();
    return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head) ? head : 'dev';
  } catch {
    return 'dev';
  }
}
