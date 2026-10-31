import {
  canDeleteDocument,
  canEditDocuments,
  canReadDocuments,
  CreateDocumentRequest,
  documentSlugOf,
  DocumentSlug,
  DocumentVersionId,
  MAX_DOCUMENT_BYTES,
  RestoreDocumentRequest,
  UpdateDocumentRequest,
  memberOf,
} from '@projectman/shared';
import type {
  DocumentChangeAuthor,
  DocumentDetail,
  DocumentSummary,
  DocumentVersion,
  DocumentViewer,
  ErrorCode,
  ProjectConfig,
  ServerEvent,
} from '@projectman/shared';
import { nowIso } from './time';

interface MockResponse {
  status: number;
  body?: unknown;
}

/** What the fake documents need from the backend that hosts it; read when used, a test may swap them. */
export interface MockDocumentsHost {
  config(): ProjectConfig;
  viewerHandle(): string;
  /** The request comes through the integrator: it reads and writes, but never deletes. */
  delegated(): boolean;
  emit(event: ServerEvent): void;
}

/** One commit of a document, as the fake keeps it. */
interface StoredVersion {
  version: string;
  at: string;
  by: DocumentChangeAuthor;
  message: string;
  title: string;
  content: string;
  deleted: boolean;
}

export interface MockDocumentSeed {
  title: string;
  content: string;
  slug?: string;
  /** Handle of the member who wrote it; the default is the viewer. */
  by?: string;
  /** Minutes ago the last change was made. */
  ageMinutes?: number;
}

const error = (status: number, code: ErrorCode, message: string, details?: unknown): MockResponse => ({
  status,
  body: { error: { code, message, ...(details === undefined ? {} : { details }) } },
});
const ok = (body: unknown, status = 200): MockResponse => ({ status, body });

const byteLength = (text: string) => new TextEncoder().encode(text).length;

/**
 * The fake of the project's documents (PM-150): the routes of `apps/server/src/api/documents.ts`, built on the
 * same shared rules (permissions, slug, outline), so the page runs against the contract the server keeps.
 * A project starts without documents; a test or a scenario fills it with `seed`.
 */
export class MockDocuments {
  /** Every document with all its commits, oldest first (a deleted one keeps its history and its slug). */
  private readonly documents = new Map<string, StoredVersion[]>();
  private counter = 0;

  private readonly host: MockDocumentsHost;

  constructor(host: MockDocumentsHost) {
    this.host = host;
  }

  /** Adds a document the way an earlier change of someone else would have; returns its slug. */
  seed(input: MockDocumentSeed): string {
    const slug = input.slug ?? documentSlugOf(input.title, new Set(this.documents.keys()));
    const versions = this.documents.get(slug) ?? [];
    versions.push(
      this.commit(
        input.title,
        input.content,
        versions.length === 0 ? `Create ${slug}` : `Update ${slug}`,
        this.authorOf(input.by ?? this.host.viewerHandle()),
        input.ageMinutes ?? 0,
      ),
    );
    this.documents.set(slug, versions);
    return slug;
  }

  /** Another member changes a document behind the viewer's back: the next save is stale. */
  changeElsewhere(slug: string, content: string, by: string): void {
    const versions = this.documents.get(slug);
    const last = versions?.at(-1);
    if (!versions || !last) return;
    versions.push(this.commit(last.title, content, `Update ${slug}`, this.authorOf(by), 0));
    this.host.emit({ type: 'documents_changed', projectKey: this.host.config().project.key, slug });
  }

  handle(method: string, rest: string, body: unknown, query: URLSearchParams): MockResponse | null {
    const viewer = this.viewer();
    if (!canReadDocuments(viewer))
      return error(403, 'insufficient_access', 'The documents are not open to this member');
    const path = /^\/([^/]+)(?:\/(history|restore))?$/.exec(rest);
    if (rest === '') {
      if (method === 'GET') return ok({ documents: this.summaries() });
      if (method === 'POST') return this.create(viewer, body);
      return null;
    }
    if (!path || !DocumentSlug.safeParse(path[1]).success) return null;
    const slug = path[1]!;
    if (!path[2]) {
      if (method === 'GET') return this.read(slug, query.get('version') ?? undefined);
      if (method === 'PATCH') return this.update(viewer, slug, body);
      if (method === 'DELETE') return this.remove(viewer, slug, query.get('baseVersion') ?? '');
    }
    if (path[2] === 'history' && method === 'GET') return this.history(slug);
    if (path[2] === 'restore' && method === 'POST') return this.restore(viewer, slug, body);
    return null;
  }

  private viewer(): DocumentViewer {
    const member = memberOf(this.host.config(), this.host.viewerHandle());
    return {
      access: member?.kind === 'human' ? member.access : member?.kind === 'ai' ? 'ai' : 'viewer',
      handle: this.host.viewerHandle(),
      delegated: this.host.delegated(),
    };
  }

  private authorOf(handle: string): DocumentChangeAuthor {
    const member = memberOf(this.host.config(), handle);
    return {
      kind: member?.kind === 'ai' ? 'ai' : 'human',
      handle,
      name: member?.displayName ?? handle,
    };
  }

  private commit(
    title: string,
    content: string,
    message: string,
    by: DocumentChangeAuthor,
    ageMinutes = 0,
    deleted = false,
  ): StoredVersion {
    this.counter += 1;
    return {
      version: this.counter.toString(16).padStart(40, '0'),
      at: new Date(Date.parse(nowIso()) - ageMinutes * 60_000).toISOString(),
      by,
      message,
      title,
      content,
      deleted,
    };
  }

  /** The current commit of a live document; a deleted or unknown slug has none. */
  private current(slug: string): StoredVersion | null {
    const last = this.documents.get(slug)?.at(-1);
    return last && !last.deleted ? last : null;
  }

  private summaryOf({ version, at, by, title }: StoredVersion, slug: string): DocumentSummary {
    return { slug, title, version, updatedAt: at, updatedBy: by };
  }

  private summaries(): DocumentSummary[] {
    return [...this.documents.keys()]
      .map((slug) => ({ slug, last: this.current(slug) }))
      .flatMap(({ slug, last }) => (last ? [this.summaryOf(last, slug)] : []))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private detailOf(version: StoredVersion, slug: string): DocumentDetail {
    return { document: this.summaryOf(version, slug), content: version.content };
  }

  private changed(slug: string): void {
    this.host.emit({ type: 'documents_changed', projectKey: this.host.config().project.key, slug });
  }

  private tooLarge(content: string): MockResponse | null {
    return byteLength(content) > MAX_DOCUMENT_BYTES
      ? error(413, 'document_too_large', 'The document is too large', { limitBytes: MAX_DOCUMENT_BYTES })
      : null;
  }

  private notEditor(viewer: DocumentViewer): MockResponse | null {
    return canEditDocuments(viewer)
      ? null
      : error(403, 'insufficient_access', 'This member may only read the documents');
  }

  /** The stored commit the request builds on; a stale one is a conflict that names the current version. */
  private base(slug: string, baseVersion: string): StoredVersion | MockResponse {
    const last = this.current(slug);
    if (!last) return error(404, 'document_not_found', 'No such document');
    if (!DocumentVersionId.safeParse(baseVersion).success)
      return error(400, 'invalid_request', 'Invalid base version');
    if (last.version !== baseVersion)
      return error(409, 'document_conflict', 'The document changed meanwhile', {
        currentVersion: last.version,
      });
    return last;
  }

  private read(slug: string, version?: string): MockResponse {
    if (version) {
      const old = this.documents.get(slug)?.find((entry) => entry.version === version);
      return old && !old.deleted
        ? ok(this.detailOf(old, slug))
        : error(404, 'document_not_found', 'No such document');
    }
    const last = this.current(slug);
    return last ? ok(this.detailOf(last, slug)) : error(404, 'document_not_found', 'No such document');
  }

  private create(viewer: DocumentViewer, body: unknown): MockResponse {
    const denied = this.notEditor(viewer);
    if (denied) return denied;
    const parsed = CreateDocumentRequest.safeParse(body);
    if (!parsed.success) return error(400, 'invalid_request', 'Invalid document');
    const large = this.tooLarge(parsed.data.content);
    if (large) return large;
    const slug = documentSlugOf(parsed.data.title, new Set(this.documents.keys()));
    const made = this.commit(
      parsed.data.title,
      parsed.data.content,
      parsed.data.message ?? `Create ${slug}`,
      this.authorOf(viewer.handle),
    );
    this.documents.set(slug, [made]);
    this.changed(slug);
    return ok(this.detailOf(made, slug), 201);
  }

  private update(viewer: DocumentViewer, slug: string, body: unknown): MockResponse {
    const denied = this.notEditor(viewer);
    if (denied) return denied;
    const parsed = UpdateDocumentRequest.safeParse(body);
    if (!parsed.success) return error(400, 'invalid_request', 'Invalid change');
    const last = this.base(slug, parsed.data.baseVersion);
    if ('status' in last) return last;
    const content = parsed.data.content ?? last.content;
    const large = this.tooLarge(content);
    if (large) return large;
    const title = parsed.data.title ?? last.title;
    const made = this.commit(
      title,
      content,
      parsed.data.message ??
        `${title !== last.title && content === last.content ? 'Rename' : 'Update'} ${slug}`,
      this.authorOf(viewer.handle),
    );
    this.documents.get(slug)!.push(made);
    this.changed(slug);
    return ok(this.detailOf(made, slug));
  }

  private restore(viewer: DocumentViewer, slug: string, body: unknown): MockResponse {
    const denied = this.notEditor(viewer);
    if (denied) return denied;
    const parsed = RestoreDocumentRequest.safeParse(body);
    if (!parsed.success) return error(400, 'invalid_request', 'Invalid restore');
    const last = this.base(slug, parsed.data.baseVersion);
    if ('status' in last) return last;
    const old = this.documents.get(slug)?.find((entry) => entry.version === parsed.data.version);
    if (!old || old.deleted) return error(404, 'document_not_found', 'No such version');
    const made = this.commit(
      old.title,
      old.content,
      `Restore ${slug} to ${old.version.slice(0, 12)}`,
      this.authorOf(viewer.handle),
    );
    this.documents.get(slug)!.push(made);
    this.changed(slug);
    return ok(this.detailOf(made, slug));
  }

  private remove(viewer: DocumentViewer, slug: string, baseVersion: string): MockResponse {
    if (!canDeleteDocument(viewer))
      return error(
        403,
        'insufficient_access',
        'Only an owner or an admin, with their own login, deletes a document',
      );
    const last = this.base(slug, baseVersion);
    if ('status' in last) return last;
    const made = this.commit(last.title, '', `Delete ${slug}`, this.authorOf(viewer.handle), 0, true);
    this.documents.get(slug)!.push(made);
    this.changed(slug);
    return ok({ slug, deleted: true, version: made.version });
  }

  private history(slug: string): MockResponse {
    const versions = this.documents.get(slug);
    // A deleted document keeps its history, like the server's.
    if (!versions) return error(404, 'document_not_found', 'No such document');
    const rows: DocumentVersion[] = [...versions].reverse().map((entry) => ({
      version: entry.version,
      at: entry.at,
      by: entry.by,
      message: entry.message,
      title: entry.title,
      deleted: entry.deleted,
    }));
    return ok({ versions: rows });
  }
}
