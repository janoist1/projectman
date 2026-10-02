import { cleanup, screen, within } from '@testing-library/react';
import type { MemberView } from '@projectman/shared';
import { describe, expect, it } from 'vitest';
import { t } from '../../i18n/t';
import { mockProject } from '../../test/mockProject';
import { TeamStrip } from './TeamStrip';

describe('the card a standing member is on (PM-237)', () => {
  const titles = new Map([
    ['AC-20', 'Napi mentés'],
    ['AC-21', 'E-mail'],
    ['AC-22', 'Analitika'],
  ]);

  function strip(patch: Partial<MemberView>) {
    const project = mockProject();
    const qa = project.backend.findMember('qa')!;
    Object.assign(qa, { activity: 'Bash: npm test', ...patch });
    project.render(
      <TeamStrip members={project.backend.members} inbox={[]} activeTaskCount={0} titles={titles} />,
    );
    return {
      link: screen.getByRole('link', { name: new RegExp(qa.displayName) }),
      text: document.body.textContent ?? '',
    };
  }

  it('shows the key and title of the one card, never the command', () => {
    const { link, text } = strip({ currentTaskKeys: ['AC-21'] });
    expect(within(link).getByText('AC-21 E-mail')).toBeTruthy();
    expect(text).not.toContain('Bash');
  });

  it('shows two cards by key, and from three the first two and a count', () => {
    expect(
      within(strip({ currentTaskKeys: ['AC-20', 'AC-21'] }).link).getByText('AC-20, AC-21'),
    ).toBeTruthy();
    cleanup();
    expect(
      within(strip({ currentTaskKeys: ['AC-20', 'AC-21', 'AC-22'] }).link).getByText('AC-20, AC-21 +1'),
    ).toBeTruthy();
  });

  it('puts the card they work on first', () => {
    const work = {
      sessionId: 'ses_x',
      taskKey: 'AC-22',
      activity: 'Bash: npm test',
      since: new Date().toISOString(),
    };
    const { link } = strip({ currentTaskKeys: ['AC-20', 'AC-22'], taskWork: [work] });
    expect(within(link).getByText('AC-22, AC-20')).toBeTruthy();
  });

  it('says "no task" without one', () => {
    expect(within(strip({ currentTaskKeys: [] }).link).getByText(t('team.noTask'))).toBeTruthy();
  });
});

describe('member card provider badges', () => {
  it('shows each standing AI member provider', () => {
    const project = mockProject();
    project.backend.findMember('qa')!.provider = 'codex';
    project.render(
      <TeamStrip members={project.backend.members} inbox={[]} activeTaskCount={0} titles={new Map()} />,
    );
    const card = screen.getByRole('link', {
      name: new RegExp(project.backend.findMember('qa')!.displayName),
    });
    expect(within(card).getByText(t('providers.codex'))).toBeTruthy();
    expect(screen.getAllByText(t('providers.claude')).length).toBeGreaterThan(0);
  });
});
