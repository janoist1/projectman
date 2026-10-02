import { screen, within } from '@testing-library/react';
import type { MemberView } from '@projectman/shared';
import { describe, expect, it } from 'vitest';
import { t } from '../../i18n/t';
import { mockProject } from '../../test/mockProject';
import { TeamStrip } from './TeamStrip';

const titles = new Map([
  ['AC-20', 'Napi mentés'],
  ['AC-21', 'E-mail'],
  ['AC-22', 'Analitika'],
  ['AC-23', 'Egy nagyon hosszú feladatcím, amely biztosan rövidülni fog'],
]);

const work = (handle: string, taskKey: string) => ({
  sessionId: `ses_${handle}_${taskKey}`,
  taskKey,
  activity: 'Bash: npm test',
  since: '2026-10-02T10:00:00.000Z',
});

/** The mock team with nobody working, then the given members working on the given cards. */
function strip(onCards: Record<string, string[]> = {}, patch: Record<string, Partial<MemberView>> = {}) {
  const project = mockProject();
  const members = project.backend.members.map((member): MemberView => ({
    ...member,
    activity: 'Bash: npm test',
    taskWork: (onCards[member.handle] ?? []).map((taskKey) => work(member.handle, taskKey)),
    ...patch[member.handle],
  }));
  project.render(<TeamStrip members={members} titles={titles} />);
  return { members, names: members.map((member) => member.displayName) };
}

const chips = () => screen.queryAllByRole('listitem').map((item) => within(item).getByRole('link'));

describe('who the board team strip shows (PM-241)', () => {
  it('lists only the AI members with a running card session, in the team order', () => {
    strip({ qa: ['AC-21'], 'fe-1': ['AC-20'], 'code-review': ['AC-22'] });
    // The team order (code review, QA, frontend), not the order the sessions started in.
    const shown = chips().map((link) => link.getAttribute('href'));
    expect(shown).toEqual(['/p/AC/tasks/AC-22', '/p/AC/tasks/AC-21', '/p/AC/tasks/AC-20']);
  });

  it('leaves out resting members, humans, and members who only wait', () => {
    strip(
      { qa: ['AC-21'] },
      {
        devops: { status: 'idle', currentTaskKeys: ['AC-20'] },
        'be-1': { status: 'waiting_for_human', currentTaskKeys: ['AC-22'] },
        // A human has no session, whatever the data says.
        kata: { taskWork: [work('kata', 'AC-18')] },
      },
    );
    expect(chips()).toHaveLength(1);
    expect(chips()[0]!.textContent).toContain('QA');
  });

  it('shows a member with a working and a waiting session by the working card', () => {
    strip({ qa: ['AC-21'] }, { qa: { status: 'working', currentTaskKeys: ['AC-21', 'AC-22'] } });
    expect(chips()[0]!.getAttribute('href')).toBe('/p/AC/tasks/AC-21');
  });
});

describe('what a chip says', () => {
  it('names the member, the card key and its title, and links the card', () => {
    strip({ qa: ['AC-21'] });
    const link = chips()[0]!;
    expect(link.getAttribute('href')).toBe('/p/AC/tasks/AC-21');
    expect(link.getAttribute('aria-label')).toBe(
      t('board.workingChip', { name: 'QA', cards: 'AC-21 E-mail' }),
    );
    expect(within(link).getByText('AC-21')).toBeTruthy();
    expect(within(link).getByText('E-mail')).toBeTruthy();
    expect(link.getAttribute('title')).toBe('AC-21 E-mail');
  });

  it('keeps the whole title in the tooltip when it shortens', () => {
    strip({ qa: ['AC-23'] });
    expect(chips()[0]!.getAttribute('title')).toBe(`AC-23 ${titles.get('AC-23')}`);
  });

  it('shows two cards by key and from three the first two and a count, linking the profile', () => {
    strip({ qa: ['AC-20', 'AC-21'], 'fe-1': ['AC-20', 'AC-21', 'AC-22'] });
    const [two, three] = chips();
    expect(two!.getAttribute('href')).toBe('/p/AC/team/qa');
    expect(within(two!).getByText('AC-20, AC-21')).toBeTruthy();
    expect(three!.getAttribute('href')).toBe('/p/AC/team/fe-1');
    expect(within(three!).getByText('AC-20, AC-21 +1')).toBeTruthy();
    expect(within(two!).queryByText('Napi mentés')).toBeNull();
  });

  it('counts a card once however many sessions work on it', () => {
    strip({ qa: ['AC-20', 'AC-20'] });
    expect(chips()[0]!.getAttribute('href')).toBe('/p/AC/tasks/AC-20');
  });

  it('shows no command, provider label or status word', () => {
    strip({ qa: ['AC-21'], 'fe-1': ['AC-20'] });
    const text = document.body.textContent ?? '';
    expect(text).not.toContain('Bash');
    expect(text).not.toContain(t('providers.claude'));
    expect(text).not.toContain(t('memberStatus.working'));
    expect(text).not.toContain(t('team.noTask'));
  });

  it('is a labelled list', () => {
    strip({ qa: ['AC-21'] });
    const region = screen.getByRole('region', { name: t('board.workingNow') });
    expect(within(region).getByRole('list')).toBeTruthy();
  });
});

describe('when nobody works', () => {
  it('says so and points to the Team page, without chips', () => {
    strip({}, { qa: { status: 'idle' } });
    expect(screen.getByText(new RegExp(t('board.nobodyWorking')))).toBeTruthy();
    expect(screen.getByRole('link', { name: t('board.teamLink') }).getAttribute('href')).toBe('/p/AC/team');
    expect(chips()).toHaveLength(0);
  });

  it('does not show the strip in a team without AI members', () => {
    const project = mockProject();
    const humans = project.backend.members.filter((member) => member.kind === 'human');
    project.render(<TeamStrip members={humans} titles={titles} />);
    expect(screen.queryByRole('region')).toBeNull();
    expect(document.body.textContent).not.toContain(t('board.nobodyWorking'));
  });
});
