import { readFile, stat } from 'node:fs/promises';

/**
 * Reads the publishing identity's token from a file the owner installed (PM-142). The file is the
 * only place the token lives on the machine: owned by root or the service, readable by the service
 * alone. A file that group or others can read is refused, because a worker that could read it would
 * hold a wider credential than the publishing gate (decision 26). The token is read at every use, so a
 * rotation is a file replacement; it is never logged, and the error names the path, not the content.
 */
export function createTokenFileReader(path: string): () => Promise<string> {
  return async () => {
    let mode: number;
    try {
      mode = (await stat(path)).mode;
    } catch {
      throw new Error(`the GitHub publishing token file cannot be read: ${path}`);
    }
    if ((mode & 0o077) !== 0)
      throw new Error(
        `the GitHub publishing token file must be readable by its owner alone (chmod 600): ${path}`,
      );
    const token = (await readFile(path, 'utf8')).trim();
    if (!token) throw new Error(`the GitHub publishing token file is empty: ${path}`);
    return token;
  };
}
