import type { MessageAttachmentStorage } from '../../contracts';
import { FileMessageAttachmentStorage } from './storage';

export { MessageAttachmentService } from './service';

/** The files of team messages under `rootDir` (PROJECTMAN_HOME/message-attachments). */
export function createMessageAttachmentStorage(rootDir: string): MessageAttachmentStorage {
  return new FileMessageAttachmentStorage(rootDir);
}
