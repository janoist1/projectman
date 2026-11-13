import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import { useMessageAttachmentUploads } from '../messages/useMessageAttachmentUploads';

export type ProjectManagerUploads = ReturnType<typeof useMessageAttachmentUploads>;

const ProjectManagerUploadsContext = createContext<ProjectManagerUploads | null>(null);

/**
 * The files attached to the message being written in the project manager's panel (PM-1305). They live above the
 * panel, so closing it (on a phone it closes whenever the page changes) does not lose or abort them; the project
 * layout keys this by project, so another project starts empty.
 */
export function ProjectManagerUploadsProvider({
  projectKey,
  children,
}: {
  projectKey: string;
  children: ReactNode;
}) {
  const uploads = useMessageAttachmentUploads(projectKey);
  return (
    <ProjectManagerUploadsContext.Provider value={uploads}>{children}</ProjectManagerUploadsContext.Provider>
  );
}

export function useProjectManagerUploads(): ProjectManagerUploads {
  const value = useContext(ProjectManagerUploadsContext);
  if (!value) throw new Error('useOperatorUploads must be used inside the project layout');
  return value;
}
