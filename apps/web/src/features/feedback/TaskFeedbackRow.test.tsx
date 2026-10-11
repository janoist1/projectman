import { screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { createMockFetch, mockProject } from '../../test/mockProject';
import { TaskDrawer } from '../board/TaskDrawer';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

const drawer = (
  <Routes>
    <Route path="/p/:key/tasks/:taskKey/*" element={<TaskDrawer />} />
  </Routes>
);

describe('the "Jelölésekből" row of a card', () => {
  it('links the marks that led to the card', async () => {
    const project = mockProject();
    project.backend.feedback.seedSample();
    project.render(drawer, '/p/AC/tasks/AC-21');
    const row = await screen.findByRole('region', { name: t('task.feedback.title') });
    expect(row.textContent).toContain(t('task.feedback.count', { count: 1 }));
    const link = row.querySelector('a')!;
    expect(link.textContent).toContain('A termékoldalon a méretválasztó');
    expect(link.getAttribute('href')).toMatch(/^\/p\/AC\/feedback\/fbm_/);
  });

  it('links three marks and counts the rest', async () => {
    const project = mockProject();
    project.backend.feedback.seedSample();
    const mock = createMockFetch(project.backend, project.requests);
    setFetchImplementation(async (input, init) => {
      const response = await mock(input, init);
      if (!input.includes('/feedback?task=')) return response;
      const view = (await response.json()) as { marks: { id: string }[] };
      const marks = Array.from({ length: 5 }, (_, n) => ({ ...view.marks[0]!, id: `fbm_extra${n}` }));
      return new Response(JSON.stringify({ ...view, marks }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    project.render(drawer, '/p/AC/tasks/AC-21');
    const row = await screen.findByRole('region', { name: t('task.feedback.title') });
    expect(row.textContent).toContain(t('task.feedback.count', { count: 5 }));
    expect(row.querySelectorAll('a')).toHaveLength(3);
    expect(row.textContent).toContain(t('task.feedback.more', { count: 2 }));
  });

  it('is absent from a card without marks', async () => {
    const project = mockProject();
    project.backend.feedback.seedSample();
    project.render(drawer, '/p/AC/tasks/AC-20');
    await screen.findByRole('heading', { level: 2 });
    await waitFor(() =>
      expect(
        project.requests.some((r) => r.method === 'GET' && r.path.includes('/feedback?task=AC-20')),
      ).toBe(true),
    );
    expect(screen.queryByRole('region', { name: t('task.feedback.title') })).toBeNull();
  });
});
