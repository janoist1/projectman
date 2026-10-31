import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CreateDocumentRequest,
  DocumentSlug,
  DocumentVersionId,
  RestoreDocumentRequest,
  UpdateDocumentRequest,
  routes,
} from '@projectman/shared';
import type {
  DeleteDocumentResponse,
  DocumentDetail,
  DocumentHistoryResponse,
  DocumentListResponse,
  DocumentViewer,
} from '@projectman/shared';
import type { DocumentWriter, StoredDocument } from '../contracts';
import type { ProjectAccess } from '../core/members';
import { invalid } from '../kernel';
import { parseBody } from '../http';
import { actorOf, authorOf, requireAccess } from './context';
import type { ApiDomain } from './ports';

type DocumentParams = { Params: { key: string; slug: string } };

const VersionQuery = z.object({ version: DocumentVersionId.optional() });
const BaseVersionQuery = z.object({ baseVersion: DocumentVersionId });
const HistoryQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).optional() });

/** The slug of the path; anything else is not a document and is refused before the store sees it. */
function slugOf(params: { slug: string }): string {
  const parsed = DocumentSlug.safeParse(params.slug);
  if (!parsed.success) throw invalid('invalid_request', 'the document slug is invalid');
  return parsed.data;
}

const viewerOf = (access: ProjectAccess): DocumentViewer => ({
  access: access.access,
  handle: access.handle,
  delegated: Boolean(access.via || access.superActor),
});

const detailOf = ({ content, ...document }: StoredDocument): DocumentDetail => ({ document, content });

/**
 * A project's living documents over REST (PM-147). The login, the membership and the same-origin check
 * come from the other /api routes; the documents service decides what the member may do.
 */
export function registerDocumentRoutes(app: FastifyInstance, domain: ApiDomain): void {
  const writerOf = (request: Parameters<typeof authorOf>[0], access: ProjectAccess): DocumentWriter => {
    const { name, email, via, superActor } = authorOf(request, access);
    return { name, email, via, superActor, actor: actorOf(access) };
  };

  app.get<{ Params: { key: string } }>(
    routes.documents(':key'),
    async (request): Promise<DocumentListResponse> => {
      const { key } = request.params;
      const access = await requireAccess(domain, request, key);
      return { documents: await domain.documents.list(key, viewerOf(access)) };
    },
  );

  app.post<{ Params: { key: string } }>(
    routes.documents(':key'),
    async (request, reply): Promise<DocumentDetail> => {
      const { key } = request.params;
      const access = await requireAccess(domain, request, key);
      const body = parseBody(CreateDocumentRequest, request.body);
      const created = await domain.documents.create(key, viewerOf(access), body, writerOf(request, access));
      void reply.code(201);
      return detailOf(created);
    },
  );

  app.get<DocumentParams>(routes.document(':key', ':slug'), async (request): Promise<DocumentDetail> => {
    const { key } = request.params;
    const access = await requireAccess(domain, request, key);
    const { version } = parseBody(VersionQuery, request.query);
    return detailOf(await domain.documents.get(key, slugOf(request.params), viewerOf(access), version));
  });

  app.patch<DocumentParams>(routes.document(':key', ':slug'), async (request): Promise<DocumentDetail> => {
    const { key } = request.params;
    const access = await requireAccess(domain, request, key);
    const { baseVersion, ...change } = parseBody(UpdateDocumentRequest, request.body);
    return detailOf(
      await domain.documents.update(
        key,
        slugOf(request.params),
        viewerOf(access),
        change,
        baseVersion,
        writerOf(request, access),
      ),
    );
  });

  app.delete<DocumentParams>(
    routes.document(':key', ':slug'),
    async (request): Promise<DeleteDocumentResponse> => {
      const { key } = request.params;
      const access = await requireAccess(domain, request, key);
      const { baseVersion } = parseBody(BaseVersionQuery, request.query);
      return domain.documents.remove(
        key,
        slugOf(request.params),
        viewerOf(access),
        baseVersion,
        writerOf(request, access),
      );
    },
  );

  app.get<DocumentParams>(
    routes.documentHistory(':key', ':slug'),
    async (request): Promise<DocumentHistoryResponse> => {
      const { key } = request.params;
      const access = await requireAccess(domain, request, key);
      const { limit } = parseBody(HistoryQuery, request.query);
      return {
        versions: await domain.documents.history(key, slugOf(request.params), viewerOf(access), limit),
      };
    },
  );

  app.post<DocumentParams>(
    routes.documentRestore(':key', ':slug'),
    async (request): Promise<DocumentDetail> => {
      const { key } = request.params;
      const access = await requireAccess(domain, request, key);
      const { version, baseVersion } = parseBody(RestoreDocumentRequest, request.body);
      return detailOf(
        await domain.documents.restore(
          key,
          slugOf(request.params),
          viewerOf(access),
          version,
          baseVersion,
          writerOf(request, access),
        ),
      );
    },
  );
}
