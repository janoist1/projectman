import { Readable } from 'node:stream';
import fastifyMultipart from '@fastify/multipart';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyInstance } from 'fastify';
import { MAX_ATTACHMENT_BYTES, routes } from '@projectman/shared';
import type { DeleteMessageAttachmentResponse, UploadMessageAttachmentResponse } from '@projectman/shared';
import type { AuthService } from '../auth';
import type { Domain } from '../domain';
import { contentDisposition } from '../core/attachments';
import { DomainError, invalid } from '../domain';
import { CONTENT_SECURITY_POLICY, MULTIPART_OVERHEAD_BYTES, tooLarge } from './attachments';
import { actorOf, requireAccess } from './context';

type AttachmentParams = { Params: { key: string; id: string } };

/**
 * Files of team messages over REST (PM-516). The same care as the card attachments': behind the login
 * and the project membership of the other /api routes, uploads streamed (the file limit applies to
 * these routes only) and never buffered. Who may open a file is the service's to say: a sent file
 * follows its message, an unsent one belongs to its uploader.
 */
export function registerMessageAttachmentRoutes(
  app: FastifyInstance,
  deps: { domain: Domain; auth: AuthService },
): void {
  const { domain, auth } = deps;

  // A scope of its own: only these routes parse multipart bodies.
  void app.register(async (scope) => {
    await scope.register(fastifyMultipart, {
      limits: {
        // One more than the limit, so that a file that is too large is seen as such by the meter.
        fileSize: MAX_ATTACHMENT_BYTES + 1,
        files: 1,
        fields: 4,
        fieldSize: 1024,
        fieldNameSize: 100,
        parts: 8,
        headerPairs: 32,
      },
    });

    scope.post<{ Params: { key: string } }>(routes.messageAttachments(':key'), async (request, reply) => {
      const { key } = request.params;
      try {
        const access = await requireAccess(domain, request, key);
        const actor = actorOf(access);
        await domain.messageAttachments.assertCanUpload(key, actor);
        if (!request.isMultipart()) {
          throw new DomainError('unsupported_media_type', 'a file is uploaded as multipart/form-data', {
            status: 415,
          });
        }
        const declared = Number(request.headers['content-length']);
        if (Number.isFinite(declared) && declared > MAX_ATTACHMENT_BYTES + MULTIPART_OVERHEAD_BYTES) {
          throw tooLarge();
        }
        const part = await request.file();
        if (!part) throw invalid('invalid_request', 'the request carries no file');
        const attachment = await domain.messageAttachments.upload({
          projectKey: key,
          actor,
          fileName: part.filename ?? '',
          content: part.file,
          // The login may end while the bytes arrive.
          beforeCommit: () => {
            if (!request.authToken || !auth.resolve(request.authToken)) {
              throw new DomainError('unauthorized', 'login required', { status: 401 });
            }
          },
        });
        return reply.code(201).send({ attachment } satisfies UploadMessageAttachmentResponse);
      } catch (err) {
        // The rest of a refused body is not worth reading: close the connection after the answer.
        reply.header('connection', 'close');
        throw err;
      }
    });

    scope.get<AttachmentParams>(routes.messageAttachmentContent(':key', ':id'), (request, reply) =>
      sendContent(request, reply, false),
    );
    scope.get<AttachmentParams>(routes.messageAttachmentDownload(':key', ':id'), (request, reply) =>
      sendContent(request, reply, true),
    );

    scope.get<AttachmentParams>(routes.messageAttachmentThumbnail(':key', ':id'), async (request, reply) => {
      const { key, id } = request.params;
      const access = await requireAccess(domain, request, key);
      const { stream, size } = await domain.messageAttachments.thumbnail(key, id, actorOf(access));
      reply
        .header('content-type', 'image/webp')
        .header('content-length', size)
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', CONTENT_SECURITY_POLICY)
        .header('cross-origin-resource-policy', 'same-origin')
        .header('cache-control', 'private, no-store');
      if (request.method === 'HEAD') {
        stream.destroy();
        return reply.send(Readable.from([]));
      }
      return reply.send(stream);
    });

    scope.delete<AttachmentParams>(
      routes.messageAttachment(':key', ':id'),
      async (request): Promise<DeleteMessageAttachmentResponse> => {
        const { key, id } = request.params;
        const access = await requireAccess(domain, request, key);
        await domain.messageAttachments.delete(key, id, actorOf(access));
        return { id, deleted: true };
      },
    );
  });

  /**
   * The bytes of a file. Only a supported raster image or PDF, proven by its content, is shown inline
   * (and only on the content route); anything else, and every download, is an attachment of type
   * application/octet-stream. HEAD takes the same path and the same checks.
   */
  async function sendContent(
    request: FastifyRequest<AttachmentParams>,
    reply: FastifyReply,
    download: boolean,
  ): Promise<FastifyReply> {
    const { key, id } = request.params;
    const access = await requireAccess(domain, request, key);
    const { attachment, stream } = await domain.messageAttachments.open(key, id, actorOf(access));
    const inline = !download && attachment.preview !== 'none';
    reply
      // Already application/octet-stream unless the content proved a supported image or PDF.
      .header('content-type', attachment.mediaType)
      .header('content-length', attachment.size)
      .header(
        'content-disposition',
        contentDisposition(inline ? 'inline' : 'attachment', attachment.fileName),
      )
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', CONTENT_SECURITY_POLICY)
      .header('cross-origin-resource-policy', 'same-origin')
      .header('cache-control', 'private, no-store');
    if (request.method === 'HEAD') {
      // The checks above ran and the headers say what a GET would send; no bytes are read.
      stream.destroy();
      return reply.send(Readable.from([]));
    }
    return reply.send(stream);
  }
}
