import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { ZodType } from 'zod';
import {
  DEFAULT_OPERATOR_PREFERENCE,
  MemberHandle,
  OperatorKnowledgeDocument,
  OperatorPreferenceDocument,
  ProjectConfig,
} from '@projectman/shared';
import type { OperatorKnowledgeStore } from '../contracts';
import { DomainError, KeyedMutex } from '../kernel';

// Store instances in the same server process share target-file locks.
const writes = new KeyedMutex();
const projectKeySchema = ProjectConfig.shape.project.shape.key;
const invalid = () =>
  new DomainError('operator_knowledge_invalid', 'Invalid operator knowledge data or file', { status: 409 });
const stale = () =>
  new DomainError('operator_knowledge_stale', 'Operator knowledge revision changed', { status: 409 });
const limit = () =>
  new DomainError('operator_knowledge_limit', 'Operator proposal marker limit reached', { status: 409 });
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** The server owns the private root. Callers supply keys, never paths or access decisions. */
export function createOperatorKnowledgeStore(opts: { rootDir: string }): OperatorKnowledgeStore {
  const root = resolve(opts.rootDir);
  function target(projectKey: string, handle?: string): string {
    if (!projectKeySchema.safeParse(projectKey).success) throw invalid();
    return handle === undefined
      ? join(root, projectKey, 'knowledge.json')
      : join(root, projectKey, 'preferences', `${handle}.json`);
  }
  // `_instance` is not a valid project key, so it never collides with a project's directory.
  const instanceTarget = () => join(root, '_instance', 'knowledge.json');
  function preferenceTarget(projectKey: string, handle: string): string {
    if (!MemberHandle.safeParse(handle).success) throw invalid();
    return target(projectKey, handle);
  }
  async function directories(file: string, create: boolean): Promise<boolean> {
    let dir = root;
    for (const part of ['', ...relative(root, dirname(file)).split(sep)]) {
      if (part) dir = join(dir, part);
      if (create) {
        try {
          await mkdir(dir, { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      }
      let info;
      try {
        info = await lstat(dir);
      } catch (error) {
        if (!create && missing(error)) return false;
        throw error;
      }
      if (!info.isDirectory() || info.isSymbolicLink()) throw invalid();
      if (create) {
        const fd = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try {
          await fd.chmod(0o700);
        } finally {
          await fd.close();
        }
      }
    }
    return true;
  }
  async function guarded<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof DomainError) throw error;
      if (['ELOOP', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw invalid();
      throw new DomainError('operator_knowledge_unavailable', 'Operator knowledge storage unavailable', {
        status: 503,
      });
    }
  }
  async function read<T>(file: string, schema: ZodType<T>, empty: () => T): Promise<T> {
    if (!(await directories(file, false))) return empty();
    let info;
    try {
      info = await lstat(file);
    } catch (error) {
      if (missing(error)) return empty();
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw invalid();
    const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const actual = await fd.stat();
      if (!actual.isFile() || actual.nlink !== 1) throw invalid();
      let value: unknown;
      try {
        value = JSON.parse(await fd.readFile('utf8'));
      } catch (error) {
        if (error instanceof SyntaxError) throw invalid();
        throw error;
      }
      const parsed = schema.safeParse(value);
      if (!parsed.success) throw invalid();
      return parsed.data;
    } finally {
      await fd.close();
    }
  }
  async function write(file: string, data: unknown): Promise<void> {
    await directories(file, true);
    const temporary = join(dirname(file), `.operator-${randomUUID()}.tmp`);
    try {
      const fd = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await fd.chmod(0o600);
        await fd.writeFile(`${JSON.stringify(data)}\n`, 'utf8');
        await fd.sync();
      } finally {
        await fd.close();
      }
      if (!(await directories(file, false))) throw invalid();
      await rename(temporary, file);
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if (!missing(error)) throw error;
      });
    }
  }
  function emptyKnowledge(): OperatorKnowledgeDocument {
    return { schemaVersion: 1, revision: 0, agreement: null, principles: [], appliedProposalIds: [] };
  }
  function emptyPreference(): OperatorPreferenceDocument {
    return { schemaVersion: 1, revision: 0, data: { ...DEFAULT_OPERATOR_PREFERENCE }, updatedAt: null };
  }
  async function cas<T extends { revision: number }>(
    file: string,
    expectedRevision: number,
    next: T,
    schema: ZodType<T>,
    empty: () => T,
    check?: (previous: T, next: T) => void,
  ): Promise<T> {
    // Zod clones the document before waiting, preventing caller mutation of queued writes.
    const parsed = schema.safeParse(next);
    if (
      !parsed.success ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      parsed.data.revision !== expectedRevision + 1
    )
      throw invalid();
    return writes.run(file, async () => {
      const previous = await read(file, schema, empty);
      if (previous.revision !== expectedRevision) throw stale();
      check?.(previous, parsed.data);
      await write(file, parsed.data);
      return parsed.data;
    });
  }
  function checkedKnowledgeCas(file: string, revision: number, next: OperatorKnowledgeDocument) {
    if (Array.isArray(next?.appliedProposalIds) && next.appliedProposalIds.length > 512) throw limit();
    return cas(file, revision, next, OperatorKnowledgeDocument, emptyKnowledge, (previous, proposed) => {
      if (previous.appliedProposalIds.some((id) => !proposed.appliedProposalIds.includes(id)))
        throw invalid();
    });
  }
  return {
    readKnowledge: (key) => guarded(() => read(target(key), OperatorKnowledgeDocument, emptyKnowledge)),
    readInstanceKnowledge: () =>
      guarded(() => read(instanceTarget(), OperatorKnowledgeDocument, emptyKnowledge)),
    compareAndSwapInstanceKnowledge: (revision, next) =>
      guarded(async () => checkedKnowledgeCas(instanceTarget(), revision, next)),
    readPreference: (key, handle) =>
      guarded(() => read(preferenceTarget(key, handle), OperatorPreferenceDocument, emptyPreference)),
    compareAndSwapKnowledge: (key, revision, next) =>
      guarded(async () => checkedKnowledgeCas(target(key), revision, next)),
    compareAndSwapPreference: (key, handle, revision, next) =>
      guarded(() =>
        cas(preferenceTarget(key, handle), revision, next, OperatorPreferenceDocument, emptyPreference),
      ),
  };
}
