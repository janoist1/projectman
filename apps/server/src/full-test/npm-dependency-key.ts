import { createHash } from 'node:crypto';
import { isRepoFilePath } from '@projectman/shared';

export interface NpmDependencyKeyInput {
  /** The bytes of the merged `package-lock.json`. */
  lock: Uint8Array;
  /** The root `package.json` and the `package.json` of every local workspace the lock lists. */
  manifests: readonly { path: string; content: Uint8Array }[];
  /** The platform, architecture and versions of the machine that runs the install. */
  platform: string;
  arch: string;
  nodeVersion: string;
  npmVersion: string;
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/**
 * The identity of an installed dependency tree (PM-681): the same key means the same lock and
 * manifests, installed by the same platform, Node and npm. It reads the bytes it is given and nothing
 * else (no files, no environment), so it is the same on every call; neither mtimes nor commit ids count.
 * Throws a `TypeError` for a manifest path that is not a relative path inside the repository, or one
 * given twice.
 */
export function npmDependencyKey(input: NpmDependencyKeyInput): string {
  const seen = new Set<string>();
  for (const { path } of input.manifests) {
    if (!isRepoFilePath(path)) throw new TypeError(`Not a path inside the repository: ${path}`);
    if (seen.has(path)) throw new TypeError(`Duplicate manifest path: ${path}`);
    seen.add(path);
  }
  // UTF-8 byte order is code point order.
  const manifests = input.manifests
    .map(({ path, content }) => ({ path, sha256: sha256(content) }))
    .sort((a, b) => Buffer.compare(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8')));
  const identity = JSON.stringify({
    version: 1,
    lock: sha256(input.lock),
    manifests,
    platform: input.platform,
    arch: input.arch,
    nodeVersion: input.nodeVersion,
    npmVersion: input.npmVersion,
  });
  return createHash('sha256').update(identity, 'utf8').digest('hex');
}
