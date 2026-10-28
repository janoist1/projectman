import { useCallback, useMemo } from 'react';
import {
  contactHandles,
  hasRecipientLimit,
  isContactRestricted,
  projectManagerOf,
  viewerRecipientsOf,
  writableRecipientHandles,
} from '@projectman/shared';
import { useConfig } from '../../api/queries';
import { useProject } from '../../app/contexts';

export interface ContactView {
  /** Whether the viewer may write only to some of the members: a client or a read-only viewer (PM-985, PM-1102). */
  restricted: boolean;
  /** What limits them: the project's contacts, or the project manager alone; `null` when nothing does. */
  limit: 'contacts' | 'project_manager' | null;
  /** The project's contacts' handles; empty until the configuration is loaded. */
  contacts: string[];
  /** Whom the viewer may write to by the limit; empty until the configuration is loaded. */
  recipients: string[];
  /** The project manager's handle, if the project has one; null until the configuration is loaded. */
  manager: string | null;
  /** Whether the configuration is known, so an empty list really means "no one to write to". */
  ready: boolean;
  /** Whether the viewer may start a message to the member. */
  canWriteTo: (handle: string) => boolean;
}

/** Who the viewer may write to: everyone, or for a client or a read-only viewer the members the project allows. */
export function useContacts(): ContactView {
  const { key, me } = useProject();
  const access = me.projects.find((project) => project.key === key)?.access;
  const restricted = hasRecipientLimit(access);
  const config = useConfig(key, access !== undefined).data?.config;
  const contacts = useMemo(() => (config ? contactHandles(config) : []), [config]);
  const recipients = useMemo(
    () => (config ? (writableRecipientHandles(config, access) ?? []) : []),
    [config, access],
  );
  const manager = config ? (projectManagerOf(config)?.handle ?? null) : null;
  const limit = !restricted
    ? null
    : isContactRestricted(access) || (config && viewerRecipientsOf(config) === 'contacts')
      ? 'contacts'
      : 'project_manager';
  const canWriteTo = useCallback(
    (handle: string) => !restricted || recipients.includes(handle),
    [restricted, recipients],
  );
  return { restricted, limit, contacts, recipients, manager, ready: config !== undefined, canWriteTo };
}
