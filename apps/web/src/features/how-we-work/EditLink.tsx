import type { ReactNode } from 'react';
import { ButtonLink } from '../../components/Button';
import { useMapView } from './MapContext';
import styles from './HowWeWork.module.css';

/** Where the thing on show is changed: a part of the settings page, or a selected element of a section. */
type EditTarget = { hash: string } | { section: string; show: string };

/** A link to the part of the settings where the thing on show is changed; only for those who may change it. */
export function EditLink({
  children,
  inFoot = true,
  ...target
}: EditTarget & {
  children: ReactNode;
  inFoot?: boolean;
}) {
  const { canEdit, projectKey } = useMapView();
  if (!canEdit) return null;
  const link = (
    <ButtonLink
      to={
        'hash' in target
          ? { pathname: `/p/${projectKey}/settings`, hash: `#${target.hash}` }
          : {
              pathname: `/p/${projectKey}/settings/${target.section}`,
              search: `?show=${target.show}&from=how-we-work`,
            }
      }
      variant="secondary"
      size="sm"
      icon="settings"
    >
      {children}
    </ButtonLink>
  );
  return inFoot ? <div className={styles.dFoot}>{link}</div> : link;
}
