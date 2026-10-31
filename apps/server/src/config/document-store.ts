import { existsSync } from 'node:fs';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import {
  documentSlugOf,
  DocumentSlug,
  DocumentSummary,
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENT_TITLE_LENGTH,
  MemberHandle,
} from '@projectman/shared';
import type { DocumentChangeAuthor, DocumentVersion } from '@projectman/shared';
import type { DocumentStore, DocumentWriter, StoredDocument } from '../contracts';
import { attributedMessage, cleanIdentity } from './customization-repo';
import type { CustomizationRepo } from './customization-repo';
import { DocumentStoreError } from './errors';

interface DocumentStoreOptions {
  /** The customization repository (and its serial queue) shared with the configuration store. */
  repo: CustomizationRepo;
}

const PROJECT_KEY_RE = /^[A-Z][A-Z0-9]{0,9}$/;
const HEX_RE = /^[0-9a-f]{4,64}$/i;
const SLUG_FILE_RE = /^([a-z0-9][a-z0-9-]{0,63})\.md$/;
const FORBIDDEN_TITLE_CHARS = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_LIMIT = 200;
const MAX_MESSAGE_LENGTH = 200;
const LOG_FORMAT = '%H%x1f%an%x1f%aI%x1f%B%x1e';

interface LogRecord {
  version: string;
  name: string;
  at: string;
  body: string;
}

interface ParsedFile {
  title: string;
  content: string;
}

/** The file of a document: a front matter with the title, then the markdown exactly as written. */
function fileText(title: string, content: string): string {
  return `---\ntitle: ${JSON.stringify(title)}\n---\n${content}`;
}

function parseFile(text: string, slug: string): ParsedFile {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!match) return { title: slug, content: text };
  let title: unknown;
  try {
    title = (parse(match[1] ?? '') as { title?: unknown } | null)?.title;
  } catch {
    title = undefined;
  }
  return {
    title:
      typeof title === 'string' && title.trim() ? title.trim().slice(0, MAX_DOCUMENT_TITLE_LENGTH) : slug,
    content: match[2] ?? '',
  };
}

function actorTrailer(writer: DocumentWriter): string {
  return `Projectman-Actor: ${writer.actor.kind}:${writer.actor.handle ?? ''}`;
}

/** The change author of a commit: the `Projectman-Actor` trailer of its last paragraph, else system. */
function authorOf(record: LogRecord): DocumentChangeAuthor {
  const ending = record.body.split(/\n\n/).at(-1) ?? '';
  const line = ending.split('\n').find((entry) => entry.startsWith('Projectman-Actor:'));
  const match = line ? /^Projectman-Actor: (human|ai|system):(.*)$/.exec(line.trim()) : null;
  const handle = match ? MemberHandle.safeParse(match[2]) : null;
  return {
    kind: match ? (match[1] as DocumentChangeAuthor['kind']) : 'system',
    handle: handle?.success ? handle.data : null,
    name: record.name,
  };
}

function subjectOf(record: LogRecord): string {
  return record.body.split('\n')[0]?.trim() ?? '';
}

function parseLog(stdout: string): LogRecord[] {
  return stdout
    .split('\x1e')
    .map((record) => record.replace(/^\n/, ''))
    .filter((record) => record.trim())
    .map((record) => {
      const [version = '', name = '', at = '', ...rest] = record.split('\x1f');
      return { version, name, at, body: rest.join('\x1f').trim() };
    });
}

function validTitle(title: string | undefined): string {
  const trimmed = title?.trim() ?? '';
  if (!trimmed) throw new DocumentStoreError('invalid_title', 'the title is empty');
  if (trimmed.length > MAX_DOCUMENT_TITLE_LENGTH || FORBIDDEN_TITLE_CHARS.test(trimmed)) {
    throw new DocumentStoreError('invalid_title', 'the title is too long or has control characters');
  }
  return trimmed;
}

function validContent(content: string): string {
  if (Buffer.byteLength(content, 'utf8') > MAX_DOCUMENT_BYTES) {
    throw new DocumentStoreError('too_large', 'the document is too large', {
      limitBytes: MAX_DOCUMENT_BYTES,
    });
  }
  return content;
}

function validSlug(slug: string): string {
  if (!DocumentSlug.safeParse(slug).success) throw new DocumentStoreError('invalid_slug', 'invalid slug');
  return slug;
}

function commitMessage(message: string | undefined, fallback: string): string {
  const line = (message ?? '').replace(/[\r\n]+/g, ' ').trim();
  return line ? line.slice(0, MAX_MESSAGE_LENGTH) : fallback;
}

export function createDocumentStore(opts: DocumentStoreOptions): DocumentStore {
  const { repo } = opts;

  const assertKey = (key: string): string => {
    if (!PROJECT_KEY_RE.test(key)) throw new DocumentStoreError('not_found', `invalid project key: ${key}`);
    return key;
  };
  const repoDirOf = (key: string) => join(repo.rootDir, 'documents', key);
  const submodulePath = (key: string) => `documents/${key}`;
  const fileOf = (slug: string) => `${slug}.md`;
  const gitIn = (key: string, args: string[], okCodes?: number[]) => repo.git(args, okCodes, repoDirOf(key));
  const hasRepo = (key: string) => existsSync(join(repoDirOf(key), '.git'));

  async function assertNotSymlink(path: string): Promise<void> {
    const info = await lstat(path).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (info?.isSymbolicLink()) throw new DocumentStoreError('unsafe_path', 'symlinks are forbidden');
  }

  /** The text of a file as of a commit, or null when the file is not there. */
  async function showFile(key: string, commit: string, slug: string): Promise<string | null> {
    const tree = await gitIn(key, ['ls-tree', commit, '--', fileOf(slug)], [128]);
    if (tree.code !== 0 || !tree.stdout.trim()) return null;
    if (!tree.stdout.startsWith('100644 ') && !tree.stdout.startsWith('100755 ')) {
      throw new DocumentStoreError('unsafe_path', 'the document is not a regular file');
    }
    const shown = await gitIn(key, ['show', `${commit}:${fileOf(slug)}`], [128]);
    return shown.code === 0 ? shown.stdout : null;
  }

  /** The newest commit at or before `commit` (default HEAD) that touched the file. */
  async function lastRecord(key: string, slug: string, commit = 'HEAD'): Promise<LogRecord | undefined> {
    const log = await gitIn(key, ['log', '-1', `--format=${LOG_FORMAT}`, commit, '--', fileOf(slug)], [128]);
    return log.code === 0 ? parseLog(log.stdout)[0] : undefined;
  }

  function summaryOf(slug: string, record: LogRecord, title: string): DocumentSummary {
    return { slug, title, version: record.version, updatedAt: record.at, updatedBy: authorOf(record) };
  }

  /** The document as of a commit (default: the latest); null when it does not exist there. */
  async function documentAt(key: string, slug: string, commit?: string): Promise<StoredDocument | null> {
    if (!hasRepo(key)) return null;
    const record = await lastRecord(key, slug, commit);
    if (!record) return null;
    const text = await showFile(key, record.version, slug);
    if (text === null) return null;
    const parsed = parseFile(text, slug);
    return { ...summaryOf(slug, record, parsed.title), content: parsed.content };
  }

  async function resolveVersion(key: string, slug: string, version: string): Promise<string> {
    if (!HEX_RE.test(version)) throw new DocumentStoreError('not_found', `unknown version: ${version}`);
    const resolved = await gitIn(key, ['rev-parse', '--verify', '-q', `${version}^{commit}`], [1, 128]);
    const commit = resolved.stdout.trim();
    // Only a commit that changed the file is one of its versions.
    if (resolved.code !== 0 || (await lastRecord(key, slug, commit))?.version !== commit) {
      throw new DocumentStoreError('not_found', `unknown version: ${version}`);
    }
    return commit;
  }

  /** Creates the project's documents repository and registers it as a submodule; idempotent. */
  async function ensureRepo(key: string, by: DocumentWriter): Promise<void> {
    const dir = repoDirOf(key);
    await assertNotSymlink(join(repo.rootDir, 'documents'));
    await mkdir(dir, { recursive: true });
    await assertNotSymlink(dir);
    if (!hasRepo(key)) {
      const author = cleanIdentity(by);
      await gitIn(key, ['init', '-q', '-b', 'main']);
      await gitIn(key, [
        'commit',
        '-q',
        '--no-verify',
        '--allow-empty',
        '-m',
        'Initialize documents repository',
        `--author=${author.name} <${author.email}>`,
      ]);
    }
  }

  /**
   * Makes the customization repository point at the documents repository's HEAD: the `.gitmodules`
   * entry (once) and the gitlink. A commit that failed earlier is made up for by the next write.
   */
  async function syncParent(key: string, by: DocumentWriter): Promise<void> {
    const path = submodulePath(key);
    const registered =
      existsSync(join(repo.rootDir, '.gitmodules')) &&
      (await repo.git(['config', '-f', '.gitmodules', '--get', `submodule.${path}.path`], [1])).code === 0;
    if (!registered) {
      await repo.git(['config', '-f', '.gitmodules', `submodule.${path}.path`, path]);
      await repo.git(['config', '-f', '.gitmodules', `submodule.${path}.url`, `./${path}`]);
    }
    await repo.git(['add', '--', '.gitmodules', path]);
    const staged = await repo.git(['diff', '--cached', '--quiet', '--', '.gitmodules', path], [1]);
    if (staged.code !== 1) return;
    await repo.commit(registered ? `Update ${key} documents` : `Add ${key} documents repository`, by, [
      '.gitmodules',
      path,
    ]);
  }

  /** The commit in the documents repository: only the file, with the actor and the integrator trailers. */
  async function commitFile(key: string, slug: string, message: string, by: DocumentWriter): Promise<string> {
    return repo.commit(
      attributedMessage(message, by, [actorTrailer(by)]),
      by,
      [fileOf(slug)],
      repoDirOf(key),
    );
  }

  async function writeFileChecked(key: string, slug: string, title: string, content: string): Promise<void> {
    const path = join(repoDirOf(key), fileOf(slug));
    await assertNotSymlink(path);
    await writeFile(path, fileText(title, content));
    await gitIn(key, ['add', '--', fileOf(slug)]);
  }

  /** The newest commit of the file whether or not the document still exists. */
  async function latestVersion(key: string, slug: string): Promise<string | undefined> {
    return hasRepo(key) ? (await lastRecord(key, slug))?.version : undefined;
  }

  async function assertBase(key: string, slug: string, baseVersion: string): Promise<string> {
    const current = await latestVersion(key, slug);
    if (!current) throw new DocumentStoreError('not_found', `no document ${slug}`);
    if (current !== baseVersion) {
      throw new DocumentStoreError('conflict', 'the document changed meanwhile', { currentVersion: current });
    }
    return current;
  }

  async function currentOrThrow(key: string, slug: string): Promise<StoredDocument> {
    const doc = await documentAt(key, slug);
    if (!doc) throw new DocumentStoreError('not_found', `no document ${slug}`);
    return doc;
  }

  /** Every slug the repository has ever had, deleted ones included. */
  async function takenSlugs(key: string): Promise<Set<string>> {
    const log = await gitIn(key, ['log', '--diff-filter=A', '--name-only', '--format=']);
    return new Set(
      log.stdout
        .split('\n')
        .map((line) => SLUG_FILE_RE.exec(line.trim())?.[1])
        .filter((slug): slug is string => slug !== undefined),
    );
  }

  /** Runs a change in the shared queue after the customization repository exists. */
  async function write<T>(key: string, by: DocumentWriter, fn: () => Promise<T>): Promise<T> {
    assertKey(key);
    await repo.init();
    return repo.exclusive(async () => {
      await ensureRepo(key, by);
      // The gitlink is synchronised after a refused change too: a commit that failed earlier is made up for.
      const result = await fn().catch(async (err: unknown) => {
        await syncParent(key, by).catch(() => undefined);
        throw err;
      });
      await syncParent(key, by);
      return result;
    });
  }

  return {
    async list(projectKey) {
      assertKey(projectKey);
      if (!hasRepo(projectKey)) return [];
      const tree = await gitIn(projectKey, ['ls-tree', '--name-only', 'HEAD']);
      const slugs = tree.stdout
        .split('\n')
        .map((line) => SLUG_FILE_RE.exec(line.trim())?.[1])
        .filter((slug): slug is string => slug !== undefined);
      const documents = await Promise.all(
        slugs.map(async (slug): Promise<DocumentSummary | null> => {
          const doc = await documentAt(projectKey, slug).catch((err) => {
            if (err instanceof DocumentStoreError) return null;
            throw err;
          });
          return doc && DocumentSummary.parse(doc);
        }),
      );
      return documents
        .filter((doc): doc is DocumentSummary => doc !== null)
        .sort((a, b) => a.title.localeCompare(b.title, 'hu') || a.slug.localeCompare(b.slug));
    },

    async read(projectKey, slug, version) {
      assertKey(projectKey);
      validSlug(slug);
      if (version !== undefined) {
        if (!hasRepo(projectKey)) throw new DocumentStoreError('not_found', `no document ${slug}`);
        const doc = await documentAt(projectKey, slug, await resolveVersion(projectKey, slug, version));
        if (!doc) throw new DocumentStoreError('not_found', `no document ${slug} in version ${version}`);
        return doc;
      }
      return currentOrThrow(projectKey, slug);
    },

    async create(projectKey, input, by) {
      const title = validTitle(input.title);
      const content = validContent(input.content);
      return write(projectKey, by, async () => {
        const slug = documentSlugOf(title, await takenSlugs(projectKey));
        await writeFileChecked(projectKey, slug, title, content);
        await commitFile(projectKey, slug, commitMessage(input.message, `Create ${slug}`), by);
        return currentOrThrow(projectKey, slug);
      });
    },

    async update(projectKey, slug, change, baseVersion, by) {
      validSlug(slug);
      return write(projectKey, by, async () => {
        await assertBase(projectKey, slug, baseVersion);
        const current = await currentOrThrow(projectKey, slug);
        const title = change.title === undefined ? current.title : validTitle(change.title);
        const content = change.content === undefined ? current.content : validContent(change.content);
        if (title === current.title && content === current.content) return current;
        const renamedOnly = content === current.content;
        await writeFileChecked(projectKey, slug, title, content);
        await commitFile(
          projectKey,
          slug,
          commitMessage(change.message, `${renamedOnly ? 'Rename' : 'Update'} ${slug}`),
          by,
        );
        return currentOrThrow(projectKey, slug);
      });
    },

    async remove(projectKey, slug, baseVersion, by) {
      validSlug(slug);
      return write(projectKey, by, async () => {
        await assertBase(projectKey, slug, baseVersion);
        await currentOrThrow(projectKey, slug);
        await assertNotSymlink(join(repoDirOf(projectKey), fileOf(slug)));
        await gitIn(projectKey, ['rm', '-q', '-f', '--', fileOf(slug)]);
        return { version: await commitFile(projectKey, slug, `Delete ${slug}`, by) };
      });
    },

    async history(projectKey, slug, limit = DEFAULT_HISTORY_LIMIT) {
      assertKey(projectKey);
      validSlug(slug);
      if (!hasRepo(projectKey)) throw new DocumentStoreError('not_found', `no document ${slug}`);
      const n = Math.max(1, Math.min(MAX_HISTORY_LIMIT, Math.floor(limit)));
      const log = await gitIn(projectKey, ['log', `-n${n}`, `--format=${LOG_FORMAT}`, '--', fileOf(slug)]);
      const records = parseLog(log.stdout);
      if (records.length === 0) throw new DocumentStoreError('not_found', `no document ${slug}`);
      return Promise.all(
        records.map(async (record): Promise<DocumentVersion> => {
          const text = await showFile(projectKey, record.version, slug);
          // A deletion commit has no file: its title is the last one the document had.
          const shown = text ?? (await showFile(projectKey, `${record.version}^`, slug));
          return {
            version: record.version,
            at: record.at,
            by: authorOf(record),
            message: subjectOf(record),
            title: shown === null ? slug : parseFile(shown, slug).title,
            deleted: text === null,
          };
        }),
      );
    },

    async restore(projectKey, slug, version, baseVersion, by) {
      validSlug(slug);
      return write(projectKey, by, async () => {
        await assertBase(projectKey, slug, baseVersion);
        const target = await documentAt(projectKey, slug, await resolveVersion(projectKey, slug, version));
        if (!target) throw new DocumentStoreError('not_found', `no document ${slug} in version ${version}`);
        const current = await documentAt(projectKey, slug);
        if (current && current.title === target.title && current.content === target.content) return current;
        await writeFileChecked(projectKey, slug, target.title, target.content);
        await commitFile(projectKey, slug, `Restore ${slug} to ${target.version.slice(0, 12)}`, by);
        return currentOrThrow(projectKey, slug);
      });
    },
  };
}
