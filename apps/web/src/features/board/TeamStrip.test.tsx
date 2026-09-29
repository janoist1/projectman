import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { t } from '../../i18n/t';
import { mockProject } from '../../test/mockProject';
import { TeamStrip } from './TeamStrip';

describe('member card provider badges', () => {
  it('shows each standing AI member provider', () => {
    const project = mockProject();
    project.backend.findMember('qa')!.provider = 'codex';
    project.render(<TeamStrip members={project.backend.members} inbox={[]} activeTaskCount={0} />);
    const card = screen.getByRole('link', {
      name: new RegExp(project.backend.findMember('qa')!.displayName),
    });
    expect(within(card).getByText(t('providers.codex'))).toBeTruthy();
    expect(screen.getAllByText(t('providers.claude')).length).toBeGreaterThan(0);
  });
});
