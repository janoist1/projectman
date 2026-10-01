import type { AttachmentStorage } from '../../contracts';
import { FileAttachmentStorage } from './storage';

export { AttachmentService } from './service';
export { contentDisposition, sanitizeFileName } from './file-name';
export { sniffMediaType } from './media-type';

/** The attachments' files under `rootDir` (PROJECTMAN_HOME/attachments). */
export function createAttachmentStorage(rootDir: string): AttachmentStorage {
  return new FileAttachmentStorage(rootDir);
}
