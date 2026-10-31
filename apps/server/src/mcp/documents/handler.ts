import { documentOutline, documentSection, memberOf, parseDocumentRef } from '@projectman/shared';
import type { DocumentSummary, DocumentVersion, DocumentViewer } from '@projectman/shared';
import { TeamToolError } from '../../contracts';
import type {
  DocumentToolsHandler,
  DocumentWriter,
  ReadDocumentArgs,
  ReadDocumentResult,
  ToolContext,
  WriteDocumentArgs,
} from '../../contracts';
import type { DocumentService } from '../../core/documents';
import { DomainError } from '../../kernel';
import type { ToolCaller } from '../caller';

type Documents = Pick<DocumentService, 'list' | 'get' | 'create' | 'update' | 'history'>;

/** The agent reads the code: a refusal says what to do (read it again for a conflict, with the current version). */
function asToolError(err: unknown): unknown {
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

/** The project's living documents for AI members (PM-149): the same service and permission rules as the page. */
export class DocumentTools implements DocumentToolsHandler {
  private readonly calls: ToolCaller;
  private readonly documents: Documents;

  constructor(deps: { calls: ToolCaller; documents: Documents }) {
    this.calls = deps.calls;
    this.documents = deps.documents;
  }

  private viewer(ctx: ToolContext): DocumentViewer {
    return { access: 'ai', handle: ctx.member };
  }

  /** Runs a document call as the member, with the service's refusals as tool errors. */
  private async run<T>(
    ctx: ToolContext,
    tool: string,
    call: (who: { viewer: DocumentViewer; by: DocumentWriter }) => Promise<T>,
  ): Promise<T> {
    return this.calls.guard(async () => {
      const config = await this.calls.caller(ctx, tool);
      const member = memberOf(config, ctx.member);
      const by: DocumentWriter = {
        name: member?.displayName ?? ctx.member,
        email: `${ctx.member}@projectman.local`,
        actor: { kind: 'ai', handle: ctx.member },
      };
      try {
        return await call({ viewer: this.viewer(ctx), by });
      } catch (err) {
        throw asToolError(err);
      }
    });
  }

  listDocuments(ctx: ToolContext): Promise<DocumentSummary[]> {
    return this.run(ctx, 'list_documents', ({ viewer }) => this.documents.list(ctx.projectKey, viewer));
  }

  readDocument(ctx: ToolContext, args: ReadDocumentArgs): Promise<ReadDocumentResult> {
    return this.run(ctx, 'read_document', async ({ viewer }) => {
      const ref = parseDocumentRef(args.ref);
      const sectionRef = args.section ?? ref.section;
      const { content, ...document } = await this.documents.get(
        ctx.projectKey,
        ref.slug,
        viewer,
        args.version,
      );
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
    });
  }

  writeDocument(
    ctx: ToolContext,
    args: WriteDocumentArgs,
  ): Promise<{ document: DocumentSummary; created: boolean }> {
    return this.run(ctx, 'write_document', async ({ viewer, by }) => {
      const { message } = args;
      if (args.slug === undefined) {
        if (args.title === undefined || args.content === undefined)
          throw new TeamToolError('invalid', 'A new document needs a title and its markdown (content).');
        const created = await this.documents.create(
          ctx.projectKey,
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
      const updated = await this.documents.update(
        ctx.projectKey,
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
    });
  }

  documentHistory(ctx: ToolContext, args: { slug: string; limit?: number }): Promise<DocumentVersion[]> {
    return this.run(ctx, 'document_history', ({ viewer }) =>
      this.documents.history(ctx.projectKey, args.slug, viewer, args.limit),
    );
  }
}
