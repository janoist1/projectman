import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import { claudeToolRules } from '../contracts';
import type { ProcessRecord, ScopeProcessSource, StartSessionSpec } from '../contracts';

/**
 * The private launch files of the sessions (PM-156). Everything that holds a session's token
 * (Claude Code's settings and MCP configuration, the hook forwarder's target URL) is written here,
 * never put on a command line or in an environment variable, where `ps` shows it to every process of
 * the same user. The root (`<app home>/run`) holds one folder per process start, named
 * `<session id>.<random>`: folders are 0700 and files 0600, created without following symlinks.
 * The runner removes a folder when its session ends; at start-up it sweeps the folders whose owner
 * is provably gone. The folder is closed to the sessions' own commands and file tools by the
 * sandbox rules (`SESSION_CONFIG_DIR` in `sensitivePaths`).
 *
 * Errors carry fixed texts: never a URL, a file's content or a token.
 */

const SESSION_ID = /^[A-Za-z0-9_-]+$/;
const DIR_NAME = /^([A-Za-z0-9_-]+)\.([0-9a-f]{16})$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const OWNER_FILE = 'owner.json';
const MAX_OWNER_BYTES = 4096;
/** Printable ASCII without the space, the double quote and the backslash. */
const SAFE_URL = /^[\x21\x23-\x5b\x5d-\x7e]+$/;
/** A process older than the folder by more than this cannot be a part of its session. */
const STARTED_BEFORE_MARGIN_MS = 5_000;
const PROBE_TIMEOUT_MS = 5_000;

export class SessionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionConfigError';
  }
}

const OwnerRecord = z
  .object({
    version: z.literal(1),
    sessionId: z.string().regex(SESSION_ID),
    instanceTag: z.string().nullable(),
    runnerPid: z.number().int().min(2),
    runnerStartedAt: z.number().int().nonnegative().nullable(),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();
export type OwnerRecord = z.infer<typeof OwnerRecord>;

export type HookConfigEvent = 'PreInvocation' | 'PreToolUse' | 'PostToolUse' | 'Stop';

function fileError(): SessionConfigError {
  return new SessionConfigError('Cannot write a private session file; refusing to start.');
}

/** The URL if the forwarder's target file can hold it as it is, else a refusal that does not quote it. */
function validatedHookUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SessionConfigError('The hook URL is not valid; refusing to start.');
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username ||
    parsed.password ||
    url.includes('#') ||
    !SAFE_URL.test(url)
  )
    throw new SessionConfigError('The hook URL is not valid; refusing to start.');
  return url;
}

/** Creates a file in `directory` with mode 0600: exclusively, never following a symlink. */
export async function writeSessionFile(directory: string, name: string, content: string): Promise<string> {
  if (!path.isAbsolute(directory) || !FILE_NAME.test(name)) throw fileError();
  const target = path.join(directory, name);
  try {
    const handle = await open(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      // The umask can only narrow the mode; this makes it exact.
      await handle.chmod(0o600);
      await handle.writeFile(content, 'utf8');
    } finally {
      await handle.close();
    }
  } catch {
    throw fileError();
  }
  return target;
}

/**
 * Writes the target of a hook forwarder: `hook.curl` for `hookUrl` as it is, or, with an event,
 * `hook-<event>.curl` for `<hookUrl>/<event>`. The file is one curl configuration line,
 * `url = "<url>"`, which the Node fallback of the forwarder reads as well. Returns its path.
 */
export async function writeHookConfig(
  directory: string,
  hookUrl: string,
  event?: HookConfigEvent,
): Promise<string> {
  const url = validatedHookUrl(event ? `${hookUrl.replace(/\/+$/, '')}/${event}` : hookUrl);
  return writeSessionFile(
    directory,
    event ? `hook-${event}.curl` : 'hook.curl',
    `url = ${JSON.stringify(url)}\n`,
  );
}

/** A session's private folder. */
export interface SessionConfigDir {
  readonly sessionId: string;
  readonly path: string;
  /** Removes the folder with its files; safe to call again, never throws. */
  remove(): Promise<void>;
}

export interface SweepResult {
  removed: string[];
  kept: string[];
}

export interface SessionConfigStore {
  /** The root as the sessions' rules must name it: its canonical path. */
  prepare(): Promise<string>;
  allocate(sessionId: string): Promise<SessionConfigDir>;
  /** Removes the folders left by runners that are gone; keeps everything it cannot prove orphaned. */
  sweep(): Promise<SweepResult>;
}

export interface SessionConfigStoreOptions {
  root: string;
  logger: FastifyBaseLogger;
  instanceTag?: string;
  /** The machine's processes (this runner's, and the sessions' CLIs). Absent: nothing is provably orphaned. */
  processes?: ScopeProcessSource;
  uid?: number | null;
  now?: () => number;
}

export function createSessionConfigStore(opts: SessionConfigStoreOptions): SessionConfigStore {
  const log = opts.logger;
  const now = opts.now ?? Date.now;
  const uid = opts.uid === undefined ? (process.getuid?.() ?? null) : opts.uid;
  const live = new Set<string>();
  let canonicalRoot: string | null = null;
  let runnerStartedAt: Promise<number | null> | null = null;

  async function prepare(): Promise<string> {
    if (canonicalRoot) return canonicalRoot;
    if (!path.isAbsolute(opts.root))
      throw new SessionConfigError('The session configuration root must be an absolute path.');
    const parent = path.dirname(opts.root);
    try {
      await mkdir(parent, { recursive: true });
      // The app home may be reached through a symlink; the root itself may not be one.
      const root = path.join(await realpath(parent), path.basename(opts.root));
      await mkdir(root, { mode: 0o700 }).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'EEXIST') throw err;
      });
      const info = await lstat(root);
      if (!info.isDirectory() || (uid !== null && info.uid !== uid) || (info.mode & 0o777) !== 0o700)
        throw new Error('not private');
      canonicalRoot = root;
      return root;
    } catch {
      throw new SessionConfigError(
        'The session configuration root is not a private directory; refusing to start.',
      );
    }
  }

  async function timed<T>(job: () => Promise<T>): Promise<T | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        job(),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), PROBE_TIMEOUT_MS);
        }),
      ]);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  function ownStartTime(): Promise<number | null> {
    runnerStartedAt ??= timed(async () => {
      const records = await opts.processes?.processes();
      return records?.find((record) => record.pid === process.pid)?.startedAt ?? null;
    });
    return runnerStartedAt;
  }

  async function allocate(sessionId: string): Promise<SessionConfigDir> {
    if (!SESSION_ID.test(sessionId))
      throw new SessionConfigError('The session id cannot name a private directory; refusing to start.');
    const root = await prepare();
    const startedAt = await ownStartTime();
    const dir = path.join(root, `${sessionId}.${randomBytes(8).toString('hex')}`);
    let removal: Promise<void> | null = null;
    const handle: SessionConfigDir = {
      sessionId,
      path: dir,
      remove() {
        removal ??= removeOwnDirectory(dir).then(() => undefined);
        return removal;
      },
    };
    live.add(dir);
    try {
      await mkdir(dir, { mode: 0o700 });
      const record: OwnerRecord = {
        version: 1,
        sessionId,
        instanceTag: opts.instanceTag ?? null,
        runnerPid: process.pid,
        runnerStartedAt: startedAt,
        createdAt: now(),
      };
      await writeSessionFile(dir, OWNER_FILE, JSON.stringify(record));
    } catch (err) {
      await handle.remove();
      if (err instanceof SessionConfigError) throw err;
      throw new SessionConfigError('Cannot create the private session directory; refusing to start.');
    }
    return handle;
  }

  /** Whether the directory is gone afterwards. */
  async function removeOwnDirectory(dir: string): Promise<boolean> {
    try {
      const info = await lstat(dir).catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return null;
        throw err;
      });
      // `rm` does not follow symlinks below; one at the top is not ours.
      if (info?.isDirectory()) await rm(dir, { recursive: true, force: true });
      else if (info) {
        log.warn({ dir }, 'a session configuration entry is not a directory; left in place');
        return false;
      }
      return true;
    } catch (err) {
      log.warn(
        { dir, code: (err as NodeJS.ErrnoException).code },
        'could not remove a session configuration directory',
      );
      return false;
    } finally {
      live.delete(dir);
    }
  }

  async function readOwner(dir: string): Promise<OwnerRecord | 'missing' | 'invalid'> {
    const file = path.join(dir, OWNER_FILE);
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.size > MAX_OWNER_BYTES) return 'invalid';
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const parsed = OwnerRecord.safeParse(JSON.parse(await handle.readFile('utf8')));
        return parsed.success ? parsed.data : 'invalid';
      } finally {
        await handle.close();
      }
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'invalid';
    }
  }

  async function sweep(): Promise<SweepResult> {
    const result: SweepResult = { removed: [], kept: [] };
    let root: string;
    let entries;
    try {
      root = await prepare();
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      log.warn('could not read the session configuration root; nothing swept');
      return result;
    }
    // Read lazily, once: only when a folder passes the checks that need no probe.
    let observed: ProcessRecord[] | null | undefined;
    const observe = async () => {
      observed ??= await timed(async () => (await opts.processes?.processes()) ?? null);
      return observed;
    };
    const keep = (name: string, why: string) => {
      result.kept.push(name);
      log.warn({ directory: name, why }, 'kept a session configuration directory');
    };

    for (const entry of entries) {
      const dir = path.join(root, entry.name);
      if (live.has(dir)) {
        result.kept.push(entry.name);
        continue;
      }
      if (!entry.isDirectory()) {
        keep(entry.name, 'not a directory');
        continue;
      }
      const owner = await readOwner(dir);
      if (owner === 'missing' || owner === 'invalid') {
        // No marker proves nothing; only an empty leftover goes, and without recursion.
        const contents = await readdir(dir).catch(() => null);
        if (contents?.length === 0) {
          try {
            await rmdir(dir);
            result.removed.push(entry.name);
          } catch {
            keep(entry.name, 'could not remove an empty directory');
          }
        } else keep(entry.name, owner === 'missing' ? 'no owner record' : 'invalid owner record');
        continue;
      }
      const named = DIR_NAME.exec(entry.name);
      if (!named || named[1] !== owner.sessionId) {
        keep(entry.name, 'owner record does not match the name');
        continue;
      }
      const view = await observe();
      if (!view || uid === null) {
        keep(entry.name, 'processes cannot be observed');
        continue;
      }
      const alive = view.some(
        (p) =>
          p.pid === owner.runnerPid &&
          (owner.runnerStartedAt === null || p.startedAt === owner.runnerStartedAt),
      );
      if (alive) {
        keep(entry.name, 'its runner is alive');
        continue;
      }
      // A CLI or a child that outlived its runner still reads the folder: its command line names it,
      // or its environment carries the session's mark.
      const mine = view.filter(
        (p) => p.uid === uid && p.pid > 1 && p.startedAt >= owner.createdAt - STARTED_BEFORE_MARGIN_MS,
      );
      if (mine.some((p) => p.args.includes(dir))) {
        keep(entry.name, 'a process names the directory');
        continue;
      }
      let marks: Map<number, Record<string, string>> | null = null;
      if (mine.length > 0 && opts.processes) {
        const source = opts.processes;
        marks = await timed(() =>
          source.envValues(
            mine.map((p) => p.pid),
            ['PROJECTMAN_SESSION_ID'],
          ),
        );
        if (!marks || marks.size === 0) {
          keep(entry.name, 'process environments cannot be observed');
          continue;
        }
      }
      if ([...(marks?.values() ?? [])].some((m) => m.PROJECTMAN_SESSION_ID === owner.sessionId)) {
        keep(entry.name, 'a process of the session is left');
        continue;
      }
      if (await removeOwnDirectory(dir)) result.removed.push(entry.name);
      else result.kept.push(entry.name);
    }
    return result;
  }

  return { prepare, allocate, sweep };
}

/**
 * A copy of the spec that keeps the session's file tools and shell out of the private folders
 * (`roots`: the root as configured and as canonical): the policy's denied paths and the sandbox's
 * `denyRead`/`denyWrite`, and for a legacy spec without a policy the matching Claude deny rules. The
 * CLI reads its own settings and the hook forwarder its target file outside both.
 */
export function denySessionConfigRoots(spec: StartSessionSpec, roots: readonly string[]): StartSessionSpec {
  const add = (list: readonly string[] | undefined): string[] => [...new Set([...(list ?? []), ...roots])];
  const sandbox = spec.sandbox
    ? {
        sandbox: {
          ...spec.sandbox,
          denyRead: add(spec.sandbox.denyRead),
          denyWrite: add(spec.sandbox.denyWrite),
        },
      }
    : {};
  if (spec.policy) {
    const filesystem = { ...spec.policy.filesystem, deniedPaths: add(spec.policy.filesystem.deniedPaths) };
    return { ...spec, ...sandbox, policy: { ...spec.policy, filesystem } };
  }
  const { deny } = claudeToolRules({
    tools: { team: { all: false, names: [] }, files: [], shell: [] },
    deniedOperations: [],
    filesystem: { deniedPaths: [...roots] },
  });
  return { ...spec, ...sandbox, deniedTools: [...new Set([...(spec.deniedTools ?? []), ...deny])] };
}
