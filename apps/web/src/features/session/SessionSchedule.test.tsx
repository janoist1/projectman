import { screen } from '@testing-library/react';
import { Routes, Route } from 'react-router';
import { afterEach, expect, it } from 'vitest';
import { setFetchImplementation } from '../../api/client';
import { mockProject } from '../../test/mockProject';
import { SessionPage } from './SessionPage';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));
it('labels a scheduled session with its project-local time', async () => {
  const p = mockProject();
  const session = p.backend.sessions[0]!;
  session.workItem = { type: 'schedule', runId: 'run_fictional' };
  session.startedAt = '2026-09-30T08:30:00.000Z';
  p.backend.config.project.timezone = 'Europe/Budapest';
  p.backend.scheduleRuns.push({
    id: 'run_fictional',
    projectKey: 'AC',
    member: session.member,
    scheduledFor: session.startedAt,
    startedAt: session.startedAt,
    sessionId: session.id,
    status: 'started',
    reason: null,
  });
  p.render(
    <Routes>
      <Route path="/sessions/:sessionId" element={<SessionPage />} />
    </Routes>,
    `/sessions/${session.id}`,
  );
  const heading = await screen.findByRole('heading', { level: 1, name: /Ütemezett futás/ });
  expect(heading.textContent).toContain('10:30');
  expect(heading.textContent).toContain('Europe/Budapest');
});
