import { useProject } from '../../app/contexts';
import { documentAccessOf } from '../../app/documents';

/** What the viewer may do with the project's documents (the rule is `documentAccessOf`). */
export function useDocumentAccess(): { read: boolean; edit: boolean; del: boolean } {
  return documentAccessOf(useProject());
}
