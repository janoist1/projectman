import type { Actor, DocumentSummary, DocumentVersion } from '@projectman/shared';
import type { ConfigAuthor } from './config-store';

/**
 * The author of a document change: the commit's author and the source of its trailers, plus the
 * actor written as the `Projectman-Actor` trailer.
 */
export interface DocumentWriter extends Pick<ConfigAuthor, 'name' | 'email' | 'via' | 'superActor'> {
  actor: Actor;
}

export interface StoredDocument extends DocumentSummary {
  /** The markdown of the requested or of the latest version; `version` is that version's commit. */
  content: string;
}

/**
 * A project's living documents: markdown files in a git repository of their own, a submodule of the
 * customization repository (`documents/<KEY>/`). Every change is a commit; the history is the
 * repository's. Owned by src/config.
 */
export interface DocumentStore {
  /** The documents at HEAD by title (localeCompare, 'hu'); no repository yet → []. */
  list(projectKey: string): Promise<DocumentSummary[]>;
  /** `version`: a commit of the file; no such document or version → not_found. */
  read(projectKey: string, slug: string, version?: string): Promise<StoredDocument>;
  create(
    projectKey: string,
    input: { title: string; content: string; message: string },
    by: DocumentWriter,
  ): Promise<StoredDocument>;
  /** A stale `baseVersion` → conflict with the current version. Nothing changed → no commit. */
  update(
    projectKey: string,
    slug: string,
    change: { title?: string; content?: string; message: string },
    baseVersion: string,
    by: DocumentWriter,
  ): Promise<StoredDocument>;
  /** Removes the file in a commit (`message`: its reason); the history stays. */
  remove(
    projectKey: string,
    slug: string,
    baseVersion: string,
    message: string,
    by: DocumentWriter,
  ): Promise<{ version: string }>;
  /** Newest first; `limit` 50 by default, 200 at most; a deleted document's history can be read too. */
  history(projectKey: string, slug: string, limit?: number): Promise<DocumentVersion[]>;
  /** A new commit with the content and the title of `version`; `message`: its reason. */
  restore(
    projectKey: string,
    slug: string,
    version: string,
    baseVersion: string,
    message: string,
    by: DocumentWriter,
  ): Promise<StoredDocument>;
}
