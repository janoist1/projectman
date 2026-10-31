import { canDeleteDocument, canEditDocuments, canReadDocuments } from '@projectman/shared';
import { useProject } from '../../app/contexts';

/**
 * What the viewer may do with the project's documents. The rules are the shared ones the server checks too
 * (`@projectman/shared`); an integrator login reads and edits but never deletes.
 */
export function useDocumentAccess(): { read: boolean; edit: boolean; del: boolean } {
  const { me, key, myHandle } = useProject();
  const access = me.projects.find((project) => project.key === key)?.access;
  if (!access) return { read: false, edit: false, del: false };
  const viewer = { access, handle: myHandle ?? '', delegated: me.via === 'integrator' };
  return {
    read: canReadDocuments(viewer),
    edit: canEditDocuments(viewer),
    del: canDeleteDocument(viewer),
  };
}
