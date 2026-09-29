import clsx from 'clsx';
import type { MemberStatus } from '@projectman/shared';
import { t } from '../i18n/t';
import { iconFor, initialsFor, toneFor } from '../lib/members';
import type { MemberLike } from '../lib/members';
import { Icon } from './Icon';
import styles from './Avatar.module.css';

export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'xxl';

const pixelSize: Record<AvatarSize, number> = { xs: 20, sm: 24, md: 28, lg: 38, xl: 44, xxl: 52 };
const iconSize: Record<AvatarSize, number> = { xs: 11, sm: 13, md: 15, lg: 20, xl: 22, xxl: 26 };

interface AvatarProps {
  member: MemberLike | null | undefined;
  /** Shown when the member is unknown. */
  handle?: string;
  isMe?: boolean;
  size?: AvatarSize;
  /** AI members show their role icon by default; stacks use initials. */
  variant?: 'icon' | 'initials';
  status?: MemberStatus | 'needs_you' | 'exited' | 'failed' | null;
  /** Border in the page colour, for overlapping stacks. */
  ring?: boolean;
  /** Accessible name; without it the avatar is decorative. */
  label?: string;
  className?: string;
}

/** Humans are round with initials; AI members are rounded squares (role icon or initials). */
export function Avatar({
  member,
  handle,
  isMe = false,
  size = 'md',
  variant = 'icon',
  status,
  ring = false,
  label,
  className,
}: AvatarProps) {
  const isAi = member?.kind === 'ai';
  const tone = member
    ? toneFor(isMe && member.kind === 'human' ? { ...member, role: 'owner' } : member)
    : 'system';
  const showIcon = isAi && variant === 'icon';
  const px = pixelSize[size];
  return (
    <span
      className={clsx(
        styles.avatar,
        styles[size],
        isAi ? styles.square : styles.round,
        ring && styles.ring,
        className,
      )}
      data-tone={tone}
      style={{ width: px, height: px }}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      title={label}
    >
      {showIcon ? (
        <Icon name={iconFor(member)} size={iconSize[size]} strokeWidth={2} />
      ) : (
        <span className={styles.initials}>{initialsFor(member, isMe, handle)}</span>
      )}
      {status ? (
        <span
          className={clsx(styles.dot, status === 'working' && 'pulse')}
          data-status={status}
          aria-hidden="true"
        />
      ) : null}
    </span>
  );
}

interface AvatarStackProps {
  members: ReadonlyArray<{ member: MemberLike | null | undefined; handle: string; isMe?: boolean }>;
  max?: number;
  size?: AvatarSize;
  label?: string;
}

/** Overlapping avatars of a mixed human/AI group, with "+N" overflow. */
export function AvatarStack({ members, max = 6, size = 'md', label }: AvatarStackProps) {
  const shown = members.slice(0, max);
  const rest = members.length - shown.length;
  return (
    <span className={styles.stack} role={label ? 'img' : undefined} aria-label={label} title={label}>
      {shown.map((entry) => (
        <Avatar
          key={entry.handle}
          member={entry.member}
          handle={entry.handle}
          isMe={entry.isMe}
          size={size}
          variant="initials"
          ring
        />
      ))}
      {rest > 0 ? (
        <span
          className={clsx(styles.avatar, styles.round, styles.ring, styles.more, styles[size])}
          style={{ height: pixelSize[size], minWidth: pixelSize[size] }}
          aria-hidden="true"
        >
          {t('common.moreCount', { count: rest })}
        </span>
      ) : null}
    </span>
  );
}
