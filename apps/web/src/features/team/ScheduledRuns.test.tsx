import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { setFetchImplementation } from '../../api/client';
import { mockProject } from '../../test/mockProject';
import { TeamPage } from './TeamPage';

function project() {
  const project = mockProject();
  project.backend.sessions = [];
  project.backend.tasks = [];
  project.backend.planUsage.fiveHourPercent = 0;
  project.backend.planUsage.weeklyPercent = 0;
  const member = project.backend.config.team.members.find((m) => m.kind === 'ai')!;
  if (member.kind === 'ai')
    member.schedule = { cron: '0 9 * * *', prompt: 'Inspect fictional maintenance opportunities.' };
  return project;
}
afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));
it('shows the next run, starts now, links recent sessions and explains refusals', async () => {
  const p = project();
  p.render(<TeamPage />);
  expect(await screen.findByText(/Következő futás:/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Futtasd most' }));
  await waitFor(() => expect(p.backend.scheduleRuns).toHaveLength(1));
  const sessionId = p.backend.scheduleRuns[0]!.sessionId!;
  await waitFor(() => expect(document.querySelector(`a[href="/p/AC/sessions/${sessionId}"]`)).toBeTruthy());
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Futtasd most' }).hasAttribute('disabled')).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Futtasd most' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Az előző ütemezett futás még él.');
  expect(await screen.findByText('Kihagyva')).toBeTruthy();
});
it('allows non-admins to see schedules without a run-now control', async () => {
  const p = project();
  p.render(<TeamPage />, '/', { can: { createTasks: false, manageTeam: false, workInSessions: false } });
  expect(await screen.findByText(/Következő futás:/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Futtasd most' })).toBeNull();
});
