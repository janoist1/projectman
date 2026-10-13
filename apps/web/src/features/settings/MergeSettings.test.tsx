import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { PatchConfigRequest } from '@projectman/shared';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { mockProject } from '../../test/mockProject';
import type { MockRequest } from '../../test/mockProject';
import { SettingsTestRoutes } from './testRoutes';

/** Who merges and which repositories need a merge: settings that save as they change (PM-453). */

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

function lastConfigPatch(requests: readonly MockRequest[]): PatchConfigRequest {
  const patch = requests.filter((r) => r.method === 'PATCH' && r.path === '/api/projects/AC/config').at(-1);
  if (!patch) throw new Error('No configuration PATCH was sent');
  return patch.body as PatchConfigRequest;
}

const teamSection = async () =>
  within(await screen.findByRole('region', { name: t('settings.sections.team') }));
const reposSection = async () =>
  within(await screen.findByRole('region', { name: t('settings.sections.repos') }));

describe('the merger in the settings (PM-453)', () => {
  it('shows who merges now, with the reviewer’s name, and saves a different kind at once', async () => {
    const project = mockProject();
    project.render(<SettingsTestRoutes initialSection="team" />);
    const section = await teamSection();
    const group = section.getByRole('region', { name: t('settings.team.merger.label') });
    const kind = within(group).getByLabelText(t('settings.team.merger.kindLabel')) as HTMLSelectElement;
    expect(kind.value).toBe('code_reviewer');
    expect(within(group).getByText(t('settings.team.merger.help'))).toBeTruthy();
    fireEvent.change(kind, { target: { value: 'developer' } });
    await waitFor(() => expect(project.backend.config.team.merger).toEqual({ kind: 'developer' }));
    expect(lastConfigPatch(project.requests).merger).toEqual({ kind: 'developer' });
  });

  it('offers a member picker for a named merger, and saves the handle', async () => {
    const project = mockProject();
    project.render(<SettingsTestRoutes initialSection="team" />);
    const section = await teamSection();
    const kind = section.getByLabelText(t('settings.team.merger.kindLabel')) as HTMLSelectElement;
    expect(section.queryByLabelText(t('settings.team.merger.memberLabel'))).toBeNull();
    fireEvent.change(kind, { target: { value: 'member' } });
    const member = (await section.findByLabelText(
      t('settings.team.merger.memberLabel'),
    )) as HTMLSelectElement;
    await waitFor(() => expect(project.backend.config.team.merger?.kind).toBe('member'));
    fireEvent.change(member, { target: { value: 'be-1' } });
    await waitFor(() =>
      expect(project.backend.config.team.merger).toEqual({ kind: 'member', handle: 'be-1' }),
    );
    expect(lastConfigPatch(project.requests).merger).toEqual({ kind: 'member', handle: 'be-1' });
  });

  it('shows "no one can merge" as the field’s error, in words, and keeps the saved merger', async () => {
    const project = mockProject();
    // Without a code review step the code reviewer kind has no one to resolve to.
    const config = project.backend.config;
    config.pipeline.stages = config.pipeline.stages.filter((stage) => stage.id !== 'code_review');
    project.render(<SettingsTestRoutes initialSection="team" />);
    const section = await teamSection();
    const kind = section.getByLabelText(t('settings.team.merger.kindLabel')) as HTMLSelectElement;
    fireEvent.change(kind, { target: { value: 'member' } });
    await waitFor(() => expect(project.backend.config.team.merger?.kind).toBe('member'));
    fireEvent.change(kind, { target: { value: 'code_reviewer' } });
    await waitFor(() =>
      expect(
        section.getByText(
          t('settings.issues.merger_unresolved', { ok: t('settings.issues.mergerReason.code_reviewer') }),
        ),
      ).toBeTruthy(),
    );
    expect(project.backend.config.team.merger?.kind).toBe('member');
  });

  it('only tells a member who may not manage the team who merges', async () => {
    const project = mockProject();
    project.render(<SettingsTestRoutes initialSection="team" />, '/', { can: { manageTeam: false } });
    const section = await teamSection();
    expect(section.getByRole('region', { name: t('settings.team.merger.label') })).toBeTruthy();
    expect(section.queryByLabelText(t('settings.team.merger.kindLabel'))).toBeNull();
    expect(section.getByText(t('settings.team.merger.help'))).toBeTruthy();
  });
});

describe('the merge requirement of a repository in the settings (PM-453)', () => {
  it('saves a repository’s own choice, and the default as a cleared one', async () => {
    const project = mockProject();
    project.render(<SettingsTestRoutes initialSection="repos" />);
    const section = await reposSection();
    const repo = project.backend.config.project.repos[0]!;
    const select = section.getByLabelText(
      t('settings.repos.merge.labelOf', { repo: repo.name }),
    ) as HTMLSelectElement;
    expect(select.value).toBe('default');
    fireEvent.change(select, { target: { value: 'false' } });
    await waitFor(() => expect(project.backend.config.project.repos[0]!.requireMerge).toBe(false));
    expect(lastConfigPatch(project.requests).repoMerge).toEqual([{ repo: repo.name, requireMerge: false }]);
    await waitFor(() => expect(select.getAttribute('aria-busy')).not.toBe('true'));

    fireEvent.change(select, { target: { value: 'true' } });
    await waitFor(() => expect(project.backend.config.project.repos[0]!.requireMerge).toBe(true));
    expect(lastConfigPatch(project.requests).repoMerge).toEqual([{ repo: repo.name, requireMerge: true }]);

    fireEvent.change(select, { target: { value: 'default' } });
    await waitFor(() => expect(project.backend.config.project.repos[0]!.requireMerge).toBeUndefined());
    expect(lastConfigPatch(project.requests).repoMerge).toEqual([{ repo: repo.name, requireMerge: null }]);
  });

  it('only tells a member who may not manage the team what each repository needs', async () => {
    const project = mockProject();
    project.render(<SettingsTestRoutes initialSection="repos" />, '/', { can: { manageTeam: false } });
    const section = await reposSection();
    expect(section.queryByLabelText(/Beolvasztás/)).toBeNull();
    expect(section.getAllByText(new RegExp(t('settings.repos.merge.label'))).length).toBeGreaterThan(0);
  });
});
