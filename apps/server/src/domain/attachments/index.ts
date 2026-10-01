import type { AttachmentStorage } from '../../contracts';
import { FileAttachmentStorage } from './storage';

export { AttachmentService } from './service';
export { contentDisposition, sanitizeFileName } from './file-name';
export { sniffMediaType } from './media-type';
export { openWorkspaceFile, WorkspaceFileRefusal } from './workspace-file';
export type { WorkspaceFile, WorkspaceFileHooks, WorkspaceFileRefusalReason } from './workspace-file';

/** The attachments' files under `rootDir` (PROJECTMAN_HOME/attachments). */
export function createAttachmentStorage(rootDir: string): AttachmentStorage {
  return new FileAttachmentStorage(rootDir);
}
