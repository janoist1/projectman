import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { CreateProjectRequest, ProjectPreview } from '@projectman/shared';
import { setFetchImplementation } from '../../api/client';
import { MeContext } from '../../app/contexts';
import { t } from '../../i18n/t';
import { issueMessage } from '../../lib/configIssues';
import { createMockFetch, mockProject } from '../../test/mockProject';
import { CreateProjectPage } from './CreateProjectPage';

/** The new-project wizard (PM-439): the steps, the summary that checks it works, and a refused create. */

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

function renderWizard() {
  const project = mockProject();
  project.render(
    <MeContext.Provider value={project.context.me}>
      <CreateProjectPage />
    </MeContext.Provider>,
    '/projects/new',
  );
  return project;
}

const next = () => fireEvent.click(screen.getByRole('button', { name: t('projects.create.next') }));
const heading = (name: string) => screen.findByRole('heading', { name });
const requestsTo = (project: ReturnType<typeof mockProject>, method: string, path: string) =>
  project.requests.filter((request) => request.method === method && request.path === path);

/** Fills the first three steps and arrives at the code step. */
async function toCodeStep() {
  fireEvent.change(await screen.findByLabelText(t('projects.create.name')), {
    target: { value: 'Acme Web' },
  });
  next();
  await heading(t('projects.create.kindTitle'));
  await screen.findAllByRole('radio');
  next();
  await heading(t('projects.create.moverTitle'));
  next();
  await heading(t('projects.create.codeTitle'));
  fireEvent.change(screen.getByLabelText(t('projects.create.workspace')), {
    target: { value: '/work/acme' },
  });
}

describe('the new project wizard (PM-439)', () => {
  it('goes through the steps and creates the project with the chosen card mover', async () => {
    const project = renderWizard();
    fireEvent.change(await screen.findByLabelText(t('projects.create.name')), {
      target: { value: 'Acme Web' },
    });
    expect((screen.getByLabelText(t('projects.create.key')) as HTMLInputElement).value).toBe('AW');
    next();
    await heading(t('projects.create.kindTitle'));
    await screen.findAllByRole('radio');
    next();
    await heading(t('projects.create.moverTitle'));
    const worker = screen.getByRole('radio', { name: new RegExp(t('settings.team.mover.worker.title')) });
    expect((worker as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(t('settings.team.mover.human.title')) }));
    expect(screen.getByText(t('settings.team.mover.youMove'))).toBeTruthy();
    next();
    await heading(t('projects.create.codeTitle'));
    fireEvent.change(screen.getByLabelText(t('projects.create.workspace')), {
      target: { value: '/work/acme' },
    });
    next();

    await heading(t('projects.create.summaryTitle'));
    expect(await screen.findByRole('status')).toBeTruthy();
    const submit = screen.getByRole('button', { name: t('projects.create.submit') });
    expect(submit.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(submit);

    await waitFor(() => expect(requestsTo(project, 'POST', '/api/projects')).toHaveLength(1));
    const body = requestsTo(project, 'POST', '/api/projects')[0]!.body as CreateProjectRequest;
    expect(body).toMatchObject({
      key: 'AW',
      name: 'Acme Web',
      workspacePath: '/work/acme',
      cardMover: 'creator',
    });
    // The summary came from the server's preview of the same request.
    expect(requestsTo(project, 'POST', '/api/projects/preview').at(-1)?.body).toMatchObject({
      key: 'AW',
      cardMover: 'creator',
    });
  });

  it('asks for the name and the key before the next step, and for the workspace before the summary', async () => {
    renderWizard();
    await screen.findByLabelText(t('projects.create.name'));
    next();
    expect(await screen.findByText(t('projects.validation.nameRequired'))).toBeTruthy();
    expect(screen.queryByRole('heading', { name: t('projects.create.kindTitle') })).toBeNull();
    fireEvent.change(screen.getByLabelText(t('projects.create.name')), { target: { value: 'Acme' } });
    next();
    await heading(t('projects.create.kindTitle'));
    await screen.findAllByRole('radio');
    next();
    await heading(t('projects.create.moverTitle'));
    next();
    await heading(t('projects.create.codeTitle'));
    next();
    expect(await screen.findByText(t('projects.validation.workspaceRequired'))).toBeTruthy();
    expect(screen.queryByRole('heading', { name: t('projects.create.summaryTitle') })).toBeNull();
  });

  it('shows what does not work in the summary, with a way to fix it, and does not create', async () => {
    const project = renderWizard();
    const base = createMockFetch(project.backend, project.requests);
    const issue = { code: 'work_stage_without_worker', path: 'pipeline.stages[2]' } as const;
    setFetchImplementation(async (path, init) => {
      const response = await base(path, init);
      if (path !== '/api/projects/preview') return response;
      const preview = (await response.json()) as ProjectPreview;
      return new Response(JSON.stringify({ ...preview, issues: [issue] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    await toCodeStep();
    next();
    await heading(t('projects.create.summaryTitle'));

    const bad = await screen.findByRole('alert');
    expect(within(bad).getByText(t('projects.create.checkBad'))).toBeTruthy();
    expect(bad.textContent).toContain(issueMessage(issue));
    expect(screen.getByText(t('projects.create.cannotSubmit'))).toBeTruthy();
    const submit = screen.getByRole('button', { name: t('projects.create.submit') });
    expect(submit.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(submit);
    expect(requestsTo(project, 'POST', '/api/projects')).toHaveLength(0);

    // The fix link goes to the step the issue is about.
    fireEvent.click(within(bad).getByRole('button', { name: t('projects.create.fixKind') }));
    await heading(t('projects.create.kindTitle'));
  });

  it('shows the reason of a refused create and keeps what was entered', async () => {
    const project = renderWizard();
    const base = createMockFetch(project.backend, project.requests);
    const issue = { code: 'work_stage_without_worker', path: 'pipeline.stages[2]' } as const;
    setFetchImplementation(async (path, init) => {
      if (path === '/api/projects' && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            error: { code: 'invalid_config', message: 'invalid', details: { issues: [issue] } },
          }),
          { status: 422, headers: { 'content-type': 'application/json' } },
        );
      }
      return base(path, init);
    });
    await toCodeStep();
    next();
    await heading(t('projects.create.summaryTitle'));
    fireEvent.click(await screen.findByRole('button', { name: t('projects.create.submit') }));

    expect(
      await screen.findByText(t('projects.create.rejected', { reason: issueMessage(issue) })),
    ).toBeTruthy();
    // Back at the first step the name is still there.
    fireEvent.click(
      screen.getByRole('button', {
        name: t('projects.create.stepButton', {
          n: 1,
          total: 5,
          name: t('projects.create.stepsNames.name'),
        }),
      }),
    );
    expect((await screen.findByLabelText(t('projects.create.name'))) as HTMLInputElement).toHaveProperty(
      'value',
      'Acme Web',
    );
  });
});
