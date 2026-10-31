import { canDeleteDocument, canEditDocuments, canReadDocuments } from '@projectman/shared';
import type { ProjectContextValue } from './contexts';

/** The documents list of a project; `slug` opens one document. */
export function documentsPath(projectKey: string, slug?: string): string {
  return slug ? `/p/${projectKey}/docs/${slug}` : `/p/${projectKey}/docs`;
}

/** The reference people and AI members share: the slug, with `#anchor` for a section. */
export function documentRef(slug: string, anchor?: string): string {
  return anchor ? `${slug}#${anchor}` : slug;
}

/**
 * What the viewer may do with the project's documents; nothing outside a project. The rules are the shared ones the
 * server checks too (`@projectman/shared`); an integrator login reads and edits but never deletes.
 */
export function documentAccessOf(project: ProjectContextValue | null): {
  read: boolean;
  edit: boolean;
  del: boolean;
} {
  const access = project?.me.projects.find((entry) => entry.key === project.key)?.access;
  if (!project || !access) return { read: false, edit: false, del: false };
  const viewer = { access, handle: project.myHandle ?? '', delegated: project.me.via === 'integrator' };
  return {
    read: canReadDocuments(viewer),
    edit: canEditDocuments(viewer),
    del: canDeleteDocument(viewer),
  };
}
