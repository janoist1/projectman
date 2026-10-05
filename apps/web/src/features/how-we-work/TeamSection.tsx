import type { MemberConfig } from '@projectman/shared';
import { Avatar } from '../../components/Avatar';
import { rich } from '../../i18n/rich';
import { joinNames, t } from '../../i18n/t';
import { memberLike, useMapView, useShowProps } from './MapContext';
import styles from './HowWeWork.module.css';

/** The members, people first and then the AI members, each a tile that opens their details. */
export function TeamSection() {
  const { map } = useMapView();
  const people = map.members.filter((entry) => entry.member.kind === 'human');
  const ai = map.members.filter((entry) => entry.member.kind === 'ai');
  return (
    <>
      <Group
        title={t('howWeWork.member.people', { count: people.length })}
        members={people.map((entry) => entry.member)}
      />
      <Group
        title={t('howWeWork.member.ai', { count: ai.length })}
        members={ai.map((entry) => entry.member)}
      />
    </>
  );
}

function Group({ title, members }: { title: string; members: MemberConfig[] }) {
  if (members.length === 0) return null;
  return (
    <div className={styles.memberGroup}>
      <p className={styles.groupTitle}>{title}</p>
      <div className={styles.members}>
        {members.map((member) => (
          <MemberTile key={member.handle} member={member} />
        ))}
      </div>
    </div>
  );
}

function MemberTile({ member }: { member: MemberConfig }) {
  const { map, roleName } = useMapView();
  const props = useShowProps({ kind: 'member', id: member.handle });
  const roles = map.members.find((entry) => entry.member.handle === member.handle)?.roles ?? [];
  const handle = <span className={styles.handle}>{member.handle}</span>;
  return (
    <button type="button" className={styles.member} {...props}>
      <Avatar member={memberLike(member)} size="md" />
      <span className={styles.memberText}>
        <span className={styles.mName}>{member.displayName}</span>
        <span className={styles.mMeta}>
          {roles.length > 0
            ? rich('howWeWork.member.tileRoles', { roles: joinNames(roles.map(roleName)), handle })
            : rich('howWeWork.member.tileHandle', { handle })}
        </span>
      </span>
    </button>
  );
}
