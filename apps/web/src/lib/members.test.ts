import { describe, expect, it } from 'vitest';
import type { MemberView } from '@projectman/shared';
import { members as fixtureMembers } from '../mocks/fixtures';
import { t } from '../i18n/t';
import { indexMembers, memberStatusView, nameOf, renamedTo } from './members';

const member = (handle: string): MemberView => fixtureMembers.find((entry) => entry.handle === handle)!;

describe('memberStatusView with a pause', () => {
  const working = member('be-1');

  it('shows the plain status when no pause is open', () => {
    expect(memberStatusView(working, [], 'owner')).toEqual({
      status: 'working',
      label: t('memberStatus.working'),
    });
  });

  it('reads "paused" for an AI member once its sessions stopped, or when nothing was running', () => {
    const stopped = [{ member: 'be-1', point: 'after_tool' as const }];
    expect(memberStatusView(working, [], 'owner', stopped)).toEqual({
      status: 'paused',
      label: t('memberStatus.paused'),
    });
    expect(memberStatusView(working, [], 'owner', [])).toEqual({
      status: 'paused',
      label: t('memberStatus.paused'),
    });
  });

  it('reads "pausing" while one of its sessions has not stopped', () => {
    const rows = [
      { member: 'be-1', point: null },
      { member: 'fe-1', point: 'idle' as const },
    ];
    expect(memberStatusView(working, [], 'owner', rows).label).toBe(t('memberStatus.pausing'));
    expect(memberStatusView(member('fe-1'), [], 'owner', rows).label).toBe(t('memberStatus.paused'));
  });

  it('leaves a human member and a member on leave as they are', () => {
    expect(memberStatusView(member('owner'), [], 'owner', []).status).toBe(member('owner').status);
    const away: MemberView = { ...working, status: 'offline' };
    expect(memberStatusView(away, [], 'owner', []).status).toBe('offline');
  });
});

describe('indexMembers with former handles (PM-1026)', () => {
  const renamed = {
    ...fixtureMembers.find((m) => m.handle === 'qa')!,
    handle: 'tester',
    formerHandles: ['qa'],
  };

  it('gives the member its name under a former handle too', () => {
    expect(nameOf('qa', indexMembers([renamed]), 'owner')).toBe(renamed.displayName);
  });

  it('lets a current handle win over the same former handle of another member', () => {
    const other = { ...fixtureMembers.find((m) => m.handle === 'devops')!, handle: 'qa' };
    expect(indexMembers([renamed, other]).get('qa')).toBe(other);
    expect(indexMembers([other, renamed]).get('qa')).toBe(other);
  });

  it('points a former handle at the current one, and a current handle nowhere', () => {
    const index = indexMembers([renamed]);
    expect(renamedTo('qa', index)).toBe('tester');
    expect(renamedTo('tester', index)).toBeNull();
    expect(renamedTo('unknown', index)).toBeNull();
  });
});

describe('nameOf', () => {
  it('names the sender of the messages projectman writes itself as the system (PM-421)', () => {
    expect(nameOf('system', indexMembers([]), 'owner')).toBe(t('common.system'));
    expect(nameOf(null, indexMembers([]), 'owner')).toBe(t('common.system'));
  });
});
