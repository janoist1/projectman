import { memberOf } from '@projectman/shared';
import type { DocumentSummary, DocumentVersion, DocumentViewer } from '@projectman/shared';
import type {
  DocumentToolsHandler,
  DocumentWriter,
  ReadDocumentArgs,
  ReadDocumentResult,
  ToolContext,
  WriteDocumentArgs,
} from '../../contracts';
import type { ToolCaller } from '../caller';
import { documentToolError, readDocumentCall, writeDocumentCall } from './calls';
import type { Documents } from './calls';

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
        throw documentToolError(err);
      }
    });
  }

  listDocuments(ctx: ToolContext): Promise<DocumentSummary[]> {
    return this.run(ctx, 'list_documents', ({ viewer }) => this.documents.list(ctx.projectKey, viewer));
  }

  readDocument(ctx: ToolContext, args: ReadDocumentArgs): Promise<ReadDocumentResult> {
    return this.run(ctx, 'read_document', ({ viewer }) =>
      readDocumentCall(this.documents, ctx.projectKey, viewer, args),
    );
  }

  writeDocument(
    ctx: ToolContext,
    args: WriteDocumentArgs,
  ): Promise<{ document: DocumentSummary; created: boolean }> {
    return this.run(ctx, 'write_document', ({ viewer, by }) =>
      writeDocumentCall(this.documents, ctx.projectKey, viewer, by, args),
    );
  }

  documentHistory(ctx: ToolContext, args: { slug: string; limit?: number }): Promise<DocumentVersion[]> {
    return this.run(ctx, 'document_history', ({ viewer }) =>
      this.documents.history(ctx.projectKey, args.slug, viewer, args.limit),
    );
  }
}
