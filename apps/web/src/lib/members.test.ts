import { describe, expect, it } from 'vitest';
import type { MemberView } from '@projectman/shared';
import { members as fixtureMembers } from '../mocks/fixtures';
import { t } from '../i18n/t';
import { memberStatusView } from './members';

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
