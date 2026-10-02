import { Readable } from 'node:stream';
import fastifyMultipart from '@fastify/multipart';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyInstance } from 'fastify';
import { MAX_ATTACHMENT_BYTES, routes } from '@projectman/shared';
import type {
  AttachmentListResponse,
  DeleteAttachmentResponse,
  UploadAttachmentResponse,
} from '@projectman/shared';
import type { AuthService } from '../auth';
import type { Domain } from '../domain';
import { contentDisposition, DomainError, invalid } from '../domain';
import { actorOf, requireAccess } from './context';

/** What a multipart request may carry on top of the file: boundaries and part headers. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

type TaskParams = { Params: { key: string; taskKey: string } };
type AttachmentParams = { Params: { key: string; taskKey: string; id: string } };

/**
 * CSP of every attachment response: nothing loads, no script runs, the document is a unique
 * origin. A PDF is sandboxed too (the viewer needs no more than the file itself).
 */
// Replaces the auth hook's header on these responses, so it repeats the frame-ancestors directive.
const CONTENT_SECURITY_POLICY = "default-src 'none'; sandbox; frame-ancestors 'none'";

const tooLarge = () =>
  new DomainError('attachment_too_large', `an attachment is at most ${MAX_ATTACHMENT_BYTES} bytes`, {
    status: 413,
    details: { maxBytes: MAX_ATTACHMENT_BYTES },
  });

/**
 * Task attachments over REST. Everything sits behind the login and the project membership of the
 * other /api routes (cookie, same-origin check for changes, no-store); the attachments service
 * judges the member against the task. Uploads are streamed: the file limit applies to the route
 * only (the JSON body limit stays), and the request is never buffered.
 */
export function registerAttachmentRoutes(
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

    scope.get<TaskParams>(
      routes.taskAttachments(':key', ':taskKey'),
      async (request): Promise<AttachmentListResponse> => {
        const { key, taskKey } = request.params;
        const access = await requireAccess(domain, request, key);
        return { attachments: await domain.attachments.list(key, taskKey, actorOf(access)) };
      },
    );

    scope.post<TaskParams>(routes.taskAttachments(':key', ':taskKey'), async (request, reply) => {
      const { key, taskKey } = request.params;
      try {
        const access = await requireAccess(domain, request, key);
        const actor = actorOf(access);
        await domain.attachments.assertCanUpload(key, taskKey, actor);
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
        const attachment = await domain.attachments.upload({
          projectKey: key,
          taskKey,
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
        return reply.code(201).send({ attachment } satisfies UploadAttachmentResponse);
      } catch (err) {
        // The rest of a refused body is not worth reading: close the connection after the answer.
        reply.header('connection', 'close');
        throw err;
      }
    });

    scope.get<AttachmentParams>(routes.attachmentContent(':key', ':taskKey', ':id'), (request, reply) =>
      sendContent(request, reply, false),
    );
    scope.get<AttachmentParams>(routes.attachmentDownload(':key', ':taskKey', ':id'), (request, reply) =>
      sendContent(request, reply, true),
    );

    scope.get<AttachmentParams>(
      routes.attachmentThumbnail(':key', ':taskKey', ':id'),
      async (request, reply) => {
        const { key, taskKey, id } = request.params;
        const access = await requireAccess(domain, request, key);
        const { stream, size } = await domain.attachments.thumbnail(key, taskKey, id, actorOf(access));
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
      },
    );

    scope.delete<AttachmentParams>(
      routes.taskAttachment(':key', ':taskKey', ':id'),
      async (request): Promise<DeleteAttachmentResponse> => {
        const { key, taskKey, id } = request.params;
        const access = await requireAccess(domain, request, key);
        await domain.attachments.delete(key, taskKey, id, actorOf(access));
        return { id, deleted: true };
      },
    );
  });

  /**
   * The bytes of an attachment. Only a supported raster image or PDF, proven by its content, is
   * shown inline (and only on the content route); anything else, and every download, is an
   * attachment of type application/octet-stream. HEAD takes the same path and the same checks.
   */
  async function sendContent(
    request: FastifyRequest<AttachmentParams>,
    reply: FastifyReply,
    download: boolean,
  ): Promise<FastifyReply> {
    const { key, taskKey, id } = request.params;
    const access = await requireAccess(domain, request, key);
    const { attachment, stream } = await domain.attachments.open(key, taskKey, id, actorOf(access));
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
