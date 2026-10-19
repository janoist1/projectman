/** The longest Unix socket path in bytes: macOS 103 (104 with the NUL), Linux 107. Node says EINVAL to a longer one. */
const SOCKET_PATH_LIMIT = process.platform === 'darwin' ? 103 : 107;

/**
 * The path itself, after checking that a Unix socket can bind or connect there. A path that is too long is a
 * failure of the test setup (a temporary directory that is too deep), never an accepted refusal: it would
 * otherwise look like the sandbox's own denial, and every socket test would fail with an error that says nothing.
 */
export function socketPathThatFits(path: string): string {
  const bytes = Buffer.byteLength(path, 'utf8');
  if (bytes > SOCKET_PATH_LIMIT)
    throw new Error(
      `test setup: the socket path is ${bytes} bytes, over the ${SOCKET_PATH_LIMIT} allowed: ${path}`,
    );
  return path;
}
