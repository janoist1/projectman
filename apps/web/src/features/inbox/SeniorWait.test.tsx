import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { seniorWaitDecisionOf } from '@projectman/shared';
import { ToastProvider } from '../../components/Toast';
import { t } from '../../i18n/t';
import { MockBackend } from '../../mocks/backend';
import { mockProject } from '../../test/mockProject';
import { InboxPage } from './InboxPage';

const REASON = 'Átfogó adatmigráció';

/** AC-24 is a Senior card, its only Senior (be-1) is busy, so it waits; the wait limit has passed. */
function waitingProject() {
  const backend = new MockBackend();
  backend.handle('PATCH', '/api/projects/AC/members/be-1', { senior: true });
  backend.findTask('AC-24')!.developerLevel = {
    level: 'senior',
    reason: REASON,
    setBy: 'owner',
    setAt: new Date().toISOString(),
  };
  expect(backend.handle('POST', '/api/projects/AC/tasks/AC-24/start', {}).status).toBe(200);
  backend.askSeniorWait('AC-24');
  return mockProject(backend);
}
const waitItems = (backend: MockBackend) =>
  backend.inbox.filter((item) => seniorWaitDecisionOf(item) !== null);
const render = (project: ReturnType<typeof mockProject>) =>
  project.render(
    <ToastProvider>
      <InboxPage />
    </ToastProvider>,
    '/p/AC/inbox',
  );

describe('the Senior-wait question in the inbox (PM-349)', () => {
  it('asks once, names the card, the busy Senior and the reason, and says what each answer does', async () => {
    const project = waitingProject();
    project.backend.askSeniorWait('AC-24');
    expect(waitItems(project.backend)).toHaveLength(1);
    render(project);

    const card = (await screen.findByRole('heading', { name: t('inbox.seniorWait.heading') })).closest(
      'article',
    )!;
    expect(card.textContent).toContain('AC-24');
    expect(card.textContent).toContain('Backend fejlesztő');
    expect(card.textContent).toContain(REASON);
    expect(within(card).getByText(t('inbox.seniorWait.consequence.wait_for_senior'))).toBeTruthy();
    expect(within(card).getByText(t('inbox.seniorWait.consequence.any_developer'))).toBeTruthy();
    expect(within(card).getByText(t('inbox.seniorWait.footer'))).toBeTruthy();
    expect(within(card).getByRole('button', { name: t('inbox.options.wait_for_senior') })).toBeTruthy();
    expect(within(card).getByRole('button', { name: t('inbox.options.any_developer') })).toBeTruthy();
  });

  it('"Várjon tovább" keeps the card waiting, says who decided on it, and closes the question', async () => {
    const project = waitingProject();
    const item = waitItems(project.backend)[0]!;
    render(project);
    const card = (await screen.findByRole('heading', { name: t('inbox.seniorWait.heading') })).closest(
      'article',
    )!;
    fireEvent.click(within(card).getByRole('button', { name: t('inbox.options.wait_for_senior') }));

    await waitFor(() =>
      expect(project.requests).toContainEqual({
        method: 'POST',
        path: `/api/projects/AC/inbox/${item.id}/resolve`,
        body: { optionId: 'wait_for_senior' },
      }),
    );
    expect(
      await screen.findByText(t('inbox.seniorWait.toast.wait_for_senior', { key: 'AC-24' })),
    ).toBeTruthy();
    const task = project.backend.findTask('AC-24')!;
    expect(task.startWaiting).toMatchObject({ reason: 'senior_busy', waitDecidedBy: 'owner' });
    expect(task.assignee).toBeNull();
  });

  it('"Kapja meg egy szabad fejlesztő" gives the card to a free developer', async () => {
    const project = waitingProject();
    // dev-1 has no live session: free.
    project.backend.sessions = project.backend.sessions.filter((session) => session.member !== 'dev-1');
    render(project);
    const card = (await screen.findByRole('heading', { name: t('inbox.seniorWait.heading') })).closest(
      'article',
    )!;
    fireEvent.click(within(card).getByRole('button', { name: t('inbox.options.any_developer') }));
    expect(await screen.findByText(t('inbox.seniorWait.toast.any_developer', { key: 'AC-24' }))).toBeTruthy();
    await waitFor(() => expect(project.backend.findTask('AC-24')!.assignee).toBe('dev-1'));
    expect(project.backend.findTask('AC-24')!.startWaiting).toBeUndefined();
  });

  it('closes by itself when the Senior takes the card, and the history says so', async () => {
    const project = waitingProject();
    project.backend.sessions = project.backend.sessions.filter((session) => session.member !== 'be-1');
    // Any change of the roster looks at the waiting cards again.
    project.backend.handle('PATCH', '/api/projects/AC/members/be-1', { displayName: 'Backend fejlesztő' });
    expect(project.backend.findTask('AC-24')!.assignee).toBe('be-1');
    render(project);
    await screen.findByText(t('inbox.recent'));
    expect(screen.queryByRole('heading', { name: t('inbox.seniorWait.heading') })).toBeNull();
    expect(
      screen.getByText(`${t('inbox.resolutions.senior_took')} · ${t('common.system')} · AC-24`),
    ).toBeTruthy();
    expect(screen.getByText(t('inbox.seniorWait.subject', { key: 'AC-24' }))).toBeTruthy();
  });

  it('closes by itself when the card goes another way, with its own label', async () => {
    const project = waitingProject();
    project.backend.handle('PATCH', '/api/projects/AC/tasks/AC-24', {
      developerLevel: { level: 'any', reason: null },
    });
    render(project);
    await screen.findByText(t('inbox.recent'));
    expect(screen.queryByRole('heading', { name: t('inbox.seniorWait.heading') })).toBeNull();
    expect(
      screen.getByText(`${t('inbox.resolutions.senior_wait_ended')} · ${t('common.system')} · AC-24`),
    ).toBeTruthy();
  });
});
