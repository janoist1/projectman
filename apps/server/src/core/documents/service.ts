import { canDeleteDocument, canEditDocuments, canReadDocuments } from '@projectman/shared';
import type {
  DeleteDocumentResponse,
  DocumentSummary,
  DocumentVersion,
  DocumentViewer,
} from '@projectman/shared';
import { DocumentStoreError } from '../../config';
import type { DocumentStore, DocumentWriter, StoredDocument } from '../../contracts';
import { DomainError, forbidden } from '../../kernel';
import type { DomainContext } from '../base';

export interface DocumentServiceDeps {
  ctx: DomainContext;
  store: DocumentStore;
}

/** The store's refusals as the API's: 404, 409 with the current version, 413, and 400 for a bad slug or title. */
function domainError(err: unknown): unknown {
  if (!(err instanceof DocumentStoreError)) return err;
  switch (err.code) {
    case 'not_found':
      return new DomainError('document_not_found', err.message, { status: 404 });
    case 'conflict':
      return new DomainError('document_conflict', err.message, { status: 409, details: err.details });
    case 'too_large':
      return new DomainError('document_too_large', err.message, { status: 413, details: err.details });
    case 'message_required':
      return new DomainError('document_message_required', err.message, { status: 400 });
    default:
      return new DomainError('invalid_request', err.message, { status: 400 });
  }
}

/**
 * A project's living documents (PM-147). The permission rules live in `@projectman/shared`
 * (`canReadDocuments`, `canEditDocuments`, `canDeleteDocument`); the storage in the documents
 * store. This service checks the viewer, maps the store's errors and tells the clients a document
 * changed (the slug only, never the text).
 */
export class DocumentService {
  private readonly ctx: DomainContext;
  private readonly store: DocumentStore;

  constructor(deps: DocumentServiceDeps) {
    this.ctx = deps.ctx;
    this.store = deps.store;
  }

  list(projectKey: string, viewer: DocumentViewer): Promise<DocumentSummary[]> {
    return this.guard(this.read(viewer), () => this.store.list(projectKey));
  }

  get(projectKey: string, slug: string, viewer: DocumentViewer, version?: string): Promise<StoredDocument> {
    return this.guard(this.read(viewer), () => this.store.read(projectKey, slug, version));
  }

  history(
    projectKey: string,
    slug: string,
    viewer: DocumentViewer,
    limit?: number,
  ): Promise<DocumentVersion[]> {
    return this.guard(this.read(viewer), () => this.store.history(projectKey, slug, limit));
  }

  create(
    projectKey: string,
    viewer: DocumentViewer,
    input: { title: string; content: string; message: string },
    by: DocumentWriter,
  ): Promise<StoredDocument> {
    return this.changed(
      projectKey,
      this.edit(viewer),
      () => this.store.create(projectKey, input, by),
      (document) => document.slug,
    );
  }

  update(
    projectKey: string,
    slug: string,
    viewer: DocumentViewer,
    change: { title?: string; content?: string; message: string },
    baseVersion: string,
    by: DocumentWriter,
  ): Promise<StoredDocument> {
    return this.changed(
      projectKey,
      this.edit(viewer),
      () => this.store.update(projectKey, slug, change, baseVersion, by),
      () => slug,
    );
  }

  restore(
    projectKey: string,
    slug: string,
    viewer: DocumentViewer,
    version: string,
    baseVersion: string,
    message: string,
    by: DocumentWriter,
  ): Promise<StoredDocument> {
    return this.changed(
      projectKey,
      this.edit(viewer),
      () => this.store.restore(projectKey, slug, version, baseVersion, message, by),
      () => slug,
    );
  }

  /** Only a human owner or admin with their own login deletes; the history stays. */
  async remove(
    projectKey: string,
    slug: string,
    viewer: DocumentViewer,
    baseVersion: string,
    message: string,
    by: DocumentWriter,
  ): Promise<DeleteDocumentResponse> {
    const denied = canDeleteDocument(viewer)
      ? null
      : forbidden(
          'insufficient_access',
          'Only an owner or an admin, with their own login, deletes a document',
        );
    const { version } = await this.changed(
      projectKey,
      denied,
      () => this.store.remove(projectKey, slug, baseVersion, message, by),
      () => slug,
    );
    return { slug, deleted: true, version };
  }

  private read(viewer: DocumentViewer): DomainError | null {
    return canReadDocuments(viewer)
      ? null
      : forbidden('insufficient_access', 'The documents are not open to this member');
  }

  private edit(viewer: DocumentViewer): DomainError | null {
    return (
      this.read(viewer) ??
      (canEditDocuments(viewer)
        ? null
        : forbidden('insufficient_access', 'This member may only read the documents'))
    );
  }

  private async guard<T>(denied: DomainError | null, run: () => Promise<T>): Promise<T> {
    if (denied) throw denied;
    try {
      return await run();
    } catch (err) {
      throw domainError(err);
    }
  }

  private async changed<T>(
    projectKey: string,
    denied: DomainError | null,
    run: () => Promise<T>,
    slugOf: (result: T) => string,
  ): Promise<T> {
    const result = await this.guard(denied, run);
    this.ctx.bus.publish({ type: 'documents_changed', projectKey, slug: slugOf(result) });
    return result;
  }
}
