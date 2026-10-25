import { useCallback, useMemo } from 'react';
import { contactHandles, isContactRestricted } from '@projectman/shared';
import { useConfig } from '../../api/queries';
import { useProject } from '../../app/contexts';

export interface ContactView {
  /** Whether the viewer may write only to the project's contacts (PM-985). */
  restricted: boolean;
  /** The contacts' handles; empty until the configuration is loaded. */
  contacts: string[];
  /** Whether the configuration is known, so an empty list really means "no contacts". */
  ready: boolean;
  /** Whether the viewer may start a message to the member. */
  canWriteTo: (handle: string) => boolean;
}

/** Who the viewer may write to: everyone, or for a member of restricted access the contacts only. */
export function useContacts(): ContactView {
  const { key, me } = useProject();
  const access = me.projects.find((project) => project.key === key)?.access;
  const restricted = isContactRestricted(access);
  const config = useConfig(key, access !== undefined).data?.config;
  const contacts = useMemo(() => (config ? contactHandles(config) : []), [config]);
  const canWriteTo = useCallback(
    (handle: string) => !restricted || contacts.includes(handle),
    [restricted, contacts],
  );
  return { restricted, contacts, ready: config !== undefined, canWriteTo };
}
