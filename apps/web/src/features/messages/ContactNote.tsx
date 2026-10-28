import { Fragment } from 'react';
import { Link } from 'react-router';
import { useProject, useProjectIndexes } from '../../app/contexts';
import { t } from '../../i18n/t';
import { nameOf } from '../../lib/members';
import { useContacts } from './useContacts';

/**
 * What a member who writes only to the contacts sees where a reply box would be for someone who is
 * not a contact (PM-985): why, and links to the people they can write to.
 */
export function ContactNote({ className }: { className?: string }) {
  const { key, myHandle } = useProject();
  const { members } = useProjectIndexes(key);
  const { contacts } = useContacts();
  const reachable = contacts.filter((handle) => handle !== myHandle && members.has(handle));
  return (
    <p className={className} role="note">
      {reachable.length === 0 ? (
        t('messages.thread.notContactNoContacts')
      ) : (
        <>
          {t('messages.thread.notContact')}{' '}
          {reachable.map((handle, index) => (
            <Fragment key={handle}>
              {index === 0 ? '' : index === reachable.length - 1 ? ` ${t('messages.thread.or')} ` : ', '}
              <Link to={`/p/${key}/messages/with/${handle}`}>{nameOf(handle, members, myHandle)}</Link>
            </Fragment>
          ))}
          .
        </>
      )}
    </p>
  );
}
