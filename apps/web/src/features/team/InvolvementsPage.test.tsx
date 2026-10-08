import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { mockProject } from '../../test/mockProject';
import { InvolvementsPage } from './InvolvementsPage';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));
describe('involvement overview', () => {
  it('applies URL filters to the request and shows the initiator and reason', async () => {
    const project = mockProject();
    project.backend.timeline.push({
      id: 'evt_involvement',
      projectKey: 'AC',
      taskKey: 'AC-21',
      sessionId: 'ses_ac21_fe1',
      actor: { kind: 'ai', handle: 'fe-1' },
      type: 'session_started',
      data: {
        member: 'fe-1',
        resumed: false,
        cause: {
          kind: 'message',
          quote: 'Please review.',
          by: { kind: 'human', handle: 'owner', via: 'integrator' },
        },
      },
      createdAt: new Date().toISOString(),
    });
    project.render(
      <Routes>
        <Route path="/p/AC/sessions" element={<InvolvementsPage />} />
      </Routes>,
      '/p/AC/sessions?by=integrator',
    );
    expect(await screen.findByText(/Please review\./)).toBeTruthy();
    expect(screen.getByRole('heading', { name: t('involvement.title') })).toBeTruthy();
    fireEvent.change(screen.getByLabelText(t('involvement.member')), { target: { value: 'fe-1' } });
    await waitFor(() =>
      expect(
        project.requests.some(
          (request) => request.path.includes('member=fe-1') && request.path.includes('by=integrator'),
        ),
      ).toBe(true),
    );
    fireEvent.change(screen.getByLabelText(t('involvement.kind')), { target: { value: 'stopped' } });
    expect(await screen.findByText(t('involvement.noResults'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('involvement.clear') }));
    await waitFor(() =>
      expect((screen.getByLabelText(t('involvement.member')) as HTMLSelectElement).value).toBe(''),
    );
  });
  it('shows the first-use state', async () => {
    const project = mockProject();
    project.backend.timeline = [];
    project.render(<InvolvementsPage />);
    expect(await screen.findByText(t('involvement.noResults'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('involvement.anytime') }));
    expect(await screen.findByText(t('involvement.empty'))).toBeTruthy();
  });
});
