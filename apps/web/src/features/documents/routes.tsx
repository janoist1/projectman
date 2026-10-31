import type { ReactNode } from 'react';
import { Navigate } from 'react-router';
import { useProject } from '../../app/contexts';
import { useDocumentAccess } from './access';
import { DocumentPage } from './DocumentPage';
import { DocumentsPage } from './DocumentsPage';

/** A member who may not read the documents (a client) goes to the project's home; the server refuses them too. */
function Guarded({ children }: { children: ReactNode }) {
  const { key } = useProject();
  const { read } = useDocumentAccess();
  return read ? children : <Navigate to={`/p/${key}`} replace />;
}

export function DocumentsRoute() {
  return (
    <Guarded>
      <DocumentsPage />
    </Guarded>
  );
}

export function DocumentRoute() {
  return (
    <Guarded>
      <DocumentPage />
    </Guarded>
  );
}
