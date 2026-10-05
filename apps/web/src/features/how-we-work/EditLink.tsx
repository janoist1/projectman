import type { ReactNode } from 'react';
import { ButtonLink } from '../../components/Button';
import { useMapView } from './MapContext';
import styles from './HowWeWork.module.css';

/** A link to the part of the settings where the thing on show is changed; only for those who may change it. */
export function EditLink({
  hash,
  children,
  inFoot = true,
}: {
  hash: string;
  children: ReactNode;
  inFoot?: boolean;
}) {
  const { canEdit, projectKey } = useMapView();
  if (!canEdit) return null;
  const link = (
    <ButtonLink
      to={{ pathname: `/p/${projectKey}/settings`, hash: `#${hash}` }}
      variant="secondary"
      size="sm"
      icon="settings"
    >
      {children}
    </ButtonLink>
  );
  return inFoot ? <div className={styles.dFoot}>{link}</div> : link;
}
