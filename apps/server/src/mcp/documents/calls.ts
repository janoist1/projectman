import { documentOutline, documentSection, parseDocumentRef } from '@projectman/shared';
import type { DocumentSummary, DocumentViewer } from '@projectman/shared';
import { TeamToolError } from '../../contracts';
import type {
  DocumentWriter,
  ReadDocumentArgs,
  ReadDocumentResult,
  WriteDocumentArgs,
} from '../../contracts';
import type { DocumentService } from '../../core/documents';
import { DomainError } from '../../kernel';

export type Documents = Pick<DocumentService, 'list' | 'get' | 'create' | 'update' | 'history'>;

/** The agent reads the code: a refusal says what to do (read it again for a conflict, with the current version). */
export function documentToolError(err: unknown): unknown {
  if (!(err instanceof DomainError)) return err;
  const current =
    err.code === 'document_conflict' &&
    typeof (err.details as { currentVersion?: unknown } | undefined)?.currentVersion === 'string'
      ? ` The current version is ${(err.details as { currentVersion: string }).currentVersion}: read the document again and apply your change to it.`
      : '';
  return new TeamToolError(
    err.status === 403 ? 'forbidden' : 'invalid',
    `${err.code}: ${err.message}.${current}`,
  );
}

/** read_document: the whole document or one section; an unknown section answers with the headings. */
export async function readDocumentCall(
  documents: Documents,
  projectKey: string,
  viewer: DocumentViewer,
  args: ReadDocumentArgs,
): Promise<ReadDocumentResult> {
  const ref = parseDocumentRef(args.ref);
  const sectionRef = args.section ?? ref.section;
  const { content, ...document } = await documents.get(projectKey, ref.slug, viewer, args.version);
  if (sectionRef === undefined) return { document, content };
  const found = documentSection(content, sectionRef);
  if (!found) {
    const headings = documentOutline(content)
      .map((heading) => `${'#'.repeat(heading.level)} ${heading.anchor} — ${heading.text}`)
      .join('\n');
    throw new TeamToolError(
      'invalid',
      `document_section_not_found: ${ref.slug} has no section "${sectionRef}". ` +
        `Its sections (anchor — heading):\n${headings || '(no headings)'}`,
    );
  }
  return { document, content: found.content, section: found.heading };
}

/** write_document: no slug creates, a slug edits; the arguments are checked here, the rest is the service's. */
export async function writeDocumentCall(
  documents: Documents,
  projectKey: string,
  viewer: DocumentViewer,
  by: DocumentWriter,
  args: WriteDocumentArgs,
): Promise<{ document: DocumentSummary; created: boolean }> {
  const { message } = args;
  if (args.slug === undefined) {
    if (args.title === undefined || args.content === undefined)
      throw new TeamToolError('invalid', 'A new document needs a title and its markdown (content).');
    const created = await documents.create(
      projectKey,
      viewer,
      { title: args.title, content: args.content, message },
      by,
    );
    const { content: _text, ...document } = created;
    return { document, created: true };
  }
  if (args.baseVersion === undefined)
    throw new TeamToolError(
      'invalid',
      'Editing needs base_version: the version you read (read_document / list_documents).',
    );
  if (args.title === undefined && args.content === undefined)
    throw new TeamToolError('invalid', 'Give a new title, a new content, or both.');
  const updated = await documents.update(
    projectKey,
    args.slug,
    viewer,
    {
      ...(args.title !== undefined ? { title: args.title } : {}),
      ...(args.content !== undefined ? { content: args.content } : {}),
      message,
    },
    args.baseVersion,
    by,
  );
  const { content: _text, ...document } = updated;
  return { document, created: false };
}
