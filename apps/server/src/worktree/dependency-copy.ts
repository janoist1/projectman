import { execFile } from 'node:child_process';
import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';

/** Copies the root and at most two workspace levels, preserving relative package links (PM-580). */
export async function copyDependencyTrees(input: {
  source: string;
  target: string;
  platform: NodeJS.Platform;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<string[]> {
  const deadline = Date.now() + (input.timeoutMs ?? 300_000);
  const check = () => {
    input.signal?.throwIfAborted();
    if (Date.now() >= deadline) throw new Error('copying the dependencies timed out');
  };
  const source = await realpath(input.source);
  const target = await realpath(input.target);
  if ((await lstat(input.source)).isSymbolicLink() || (await lstat(input.target)).isSymbolicLink())
    throw new Error('dependency copy roots must not be symbolic links');
  const realDirectory = async (dir: string) => {
    const info = await lstat(dir).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
      throw err;
    });
    return info?.isDirectory() && !info.isSymbolicLink();
  };
  const parents: string[] = [];
  const walk = async (relative: string, depth: number): Promise<void> => {
    check();
    if (await realDirectory(path.join(source, relative, 'node_modules'))) parents.push(relative);
    if (depth === 2) return;
    const entries = await readdir(path.join(source, relative), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      await walk(path.join(relative, entry.name), depth + 1);
    }
  };
  await walk('', 0);

  const copy = (from: string, to: string, clone: boolean): Promise<void> => {
    check();
    return new Promise((resolve, reject) => {
      // Do not use execFile's signal option: it rejects before the child has actually stopped.
      const child = execFile(
        'cp',
        [...(clone ? ['-c'] : []), '-R', '-P', from, to],
        { env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, windowsHide: true },
        (error) => {
          clearTimeout(timer);
          input.signal?.removeEventListener('abort', stop);
          try {
            check();
            if (error) reject(error);
            else resolve();
          } catch (err) {
            reject(err);
          }
        },
      );
      const stop = () => {
        child.kill('SIGKILL');
      };
      const timer = setTimeout(stop, Math.max(1, deadline - Date.now()));
      input.signal?.addEventListener('abort', stop, { once: true });
      if (input.signal?.aborted) stop();
    });
  };
  const copied: string[] = [];
  for (const parent of parents) {
    check();
    const holder = path.join(target, parent);
    // The merged source may have removed the workspace or replaced any parent with a link.
    if (!(await realDirectory(holder)) || (await realpath(holder)) !== holder) continue;
    const dest = path.join(holder, 'node_modules');
    const existing = await lstat(dest).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (existing) continue;
    const from = path.join(source, parent, 'node_modules');
    if (!(await realDirectory(from)) || (await realpath(from)) !== from)
      throw new Error('dependency copy source changed');
    if (input.platform === 'darwin') {
      try {
        await copy(from, dest, true);
      } catch (err) {
        check();
        if ((await realpath(holder)) !== holder) throw err;
        await rm(dest, { recursive: true, force: true });
        if (!(await realDirectory(from)) || (await realpath(from)) !== from) throw err;
        await copy(from, dest, false);
      }
    } else await copy(from, dest, false);
    check();
    if ((await realpath(holder)) !== holder) throw new Error('dependency copy parent changed');
    for (const cache of ['.vite', '.vite-temp', '.cache']) {
      if (!(await realDirectory(dest)) || (await realpath(dest)) !== dest)
        throw new Error('dependency copy target changed');
      await rm(path.join(dest, cache), { recursive: true, force: true });
    }
    copied.push(path.posix.join(parent.split(path.sep).join('/'), 'node_modules'));
  }
  check();
  return copied;
}
