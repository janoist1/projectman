import clsx from 'clsx';
import type { FeedbackPerson } from '@projectman/shared';
import { Avatar } from '../../components/Avatar';
import type { AvatarSize } from '../../components/Avatar';
import type { MemberLike } from '../../lib/members';
import { markerInitials } from './feedbackModel';
import styles from './MarkerAvatar.module.css';

/** A person in the marks: a human in their marker colour (the colour stays the same in the widget), an AI member as everywhere. */
export function MarkerAvatar({
  person,
  member,
  size = 'lg',
}: {
  person: FeedbackPerson;
  member?: MemberLike | null;
  size?: Extract<AvatarSize, 'sm' | 'md' | 'lg'>;
}) {
  if (person.kind === 'ai') {
    return (
      <Avatar
        member={
          member ?? { handle: person.handle, displayName: person.name, kind: 'ai', role: 'project_manager' }
        }
        size={size}
      />
    );
  }
  const slot = ((person.color ?? 0) % 8) + 1;
  return (
    <span
      className={clsx(styles.avatar, styles[size])}
      style={{ background: `var(--c-marker-${slot})` }}
      aria-hidden="true"
    >
      {markerInitials(person.name)}
    </span>
  );
}
