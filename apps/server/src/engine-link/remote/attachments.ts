import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { EngineId } from '@projectman/shared';
import { conflict } from '../../domain/errors';
import { ENGINE_UPLOAD_MAX_BYTES } from '../protocol';
import type { RemoteHub } from './hub';
import type { FileTransfers } from './transfers';

/**
 * An attachment a session reads (`read_attachment`, PM-315): the session runs on the engine, so the file
 * goes there first. The cloud hashes the stored file, gives the engine a single-use download token, and
 * the engine fetches it into its attachments cache (`files.materialize`) after checking size and checksum;
 * the tool then names that path. The engine's cache directory of a card is the one the session's read
 * rules grant (`attachmentDirectory`).
 */

export interface AttachmentMaterializer {
  /** The path of the attachment on the engine. Rejects with `engine_offline` when the engine is not reachable. */
  materialize(
    engineId: EngineId,
    input: { projectKey: string; taskKey: string; id: string; fileName: string; storedPath: string },
  ): Promise<string>;
  /** The engine's cache directory of a card's attachments; null when the engine's home is not known. */
  directory(engineId: EngineId, projectKey: string, taskKey: string): string | null;
}

/** The name an attachment has in the cache: the id keeps two files of the same name apart. */
export function cachedName(id: string, fileName: string): string {
  return `${id}-${fileName}`.slice(0, 255);
}

async function sha256Of(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export function createAttachmentMaterializer(options: {
  hub: RemoteHub;
  transfers: FileTransfers;
}): AttachmentMaterializer {
  const { hub, transfers } = options;
  const directory: AttachmentMaterializer['directory'] = (engineId, projectKey, taskKey) => {
    const home = hub.mirror(engineId).hello?.paths.home;
    return home ? path.join(home, 'attachments-cache', projectKey, taskKey) : null;
  };
  return {
    directory,
    async materialize(engineId, input) {
      if (!hub.available(engineId))
        throw conflict('engine_offline', `engine ${engineId} is not connected`, { engine: engineId });
      const { size } = await stat(input.storedPath);
      if (size > ENGINE_UPLOAD_MAX_BYTES.file)
        throw conflict('attachment_too_large', 'The attachment is too large to give to the engine');
      const sha256 = await sha256Of(input.storedPath);
      const downloadToken = transfers.issueDownload(engineId, { path: input.storedPath, size, sha256 });
      const result = await hub.call(engineId, 'files.materialize', {
        downloadToken,
        projectKey: input.projectKey,
        taskKey: input.taskKey,
        name: cachedName(input.id, input.fileName),
        sha256,
        size,
      });
      return result.path;
    },
  };
}
