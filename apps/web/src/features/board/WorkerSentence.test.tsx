import { useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import { act } from 'react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import type { Session, WorkDoing } from '@projectman/shared';
import { applyServerEvent } from '../../api/cache';
import { setFetchImplementation } from '../../api/client';
import { ProjectContext } from '../../app/contexts';
import { t } from '../../i18n/t';
import { mockProject } from '../../test/mockProject';
import { renderUi } from '../../test/render';
import { AttachmentUploadsProvider } from './attachmentUploads';
import { BoardPage } from './BoardPage';
import { TaskDrawer } from './TaskDrawer';

/**
 * What the board card and the drawer show of the sentence a member gives about their work on a card
 * (PM-239), against the fake backend; the live update arrives as a `session_upserted` event.
 */
afterEach(() => {
  setFetchImplementation((input, init) => globalThis.fetch(input, init));
});

const developer = 'Backend fejlesztő';
const gateway: WorkDoing = {
  summary: 'A mentések visszaállítási próbája fut a tesztadatbázison, utána a riasztás jön',
  detail: 'A visszaállítás a tegnap esti mentésből indul, a sorok számát az élesével vetem össze.',
};

let client: QueryClient;
function CaptureClient() {
  client = useQueryClient();
  return null;
}

type Project = ReturnType<typeof mockProject>;

/** The board with the drawer of AC-20 open on it. */
function renderBoardWithDrawer(project: Project) {
  renderUi(
    <ProjectContext.Provider value={project.context}>
      <AttachmentUploadsProvider>
        <CaptureClient />
        <Routes>
          <Route path="/p/:key" element={<BoardPage />}>
            <Route path="tasks/:taskKey" element={<TaskDrawer />} />
          </Route>
        </Routes>
      </AttachmentUploadsProvider>
    </ProjectContext.Provider>,
    { route: '/p/AC/tasks/AC-20' },
  );
}

const ses = (project: Project, id: string) => project.backend.sessions.find((session) => session.id === id)!;
/** The card of AC-20 on the board: the link with a phase (the drawer has no such link to it). */
const cardOf = async () => {
  const card = await waitFor(() => {
    const found = document.querySelector<HTMLElement>('a[href="/p/AC/tasks/AC-20"][data-phase]');
    if (!found) throw new Error('no card yet');
    return found;
  });
  return card;
};

/** The second worker on AC-20: the QA member, working in a session of their own. */
function addQa(project: Project, doing?: WorkDoing): Session {
  const first = ses(project, 'ses_ac20_be1');
  const session: Session = {
    ...first,
    id: 'ses_ac20_qa',
    member: 'qa',
    startedAt: first.startedAt,
    ...(doing ? { doing } : { doing: undefined }),
  };
  project.backend.sessions.push(session);
  return session;
}

describe('the sentence of a worker on the card and in the drawer (PM-239)', () => {
  it('shows the summary next to the name on the card, and the summary with its detail in the drawer', async () => {
    const project = mockProject();
    ses(project, 'ses_ac20_be1').doing = gateway;
    renderBoardWithDrawer(project);

    const card = await cardOf();
    expect(within(card).getByText(gateway.summary)).toBeTruthy();
    expect(within(card).getByText(`${developer}: ${gateway.summary}`)).toBeTruthy();
    expect(within(card).queryByText(t('taskStatus.worker.working', { name: developer }))).toBeNull();
    // The longer text is for the drawer only.
    expect(card.textContent).not.toContain(gateway.detail);

    // In the drawer: the same line, in full, and the longer text under it.
    const detail = await screen.findByText(gateway.detail!);
    expect(detail.closest('[data-phase]')!.textContent).toContain(gateway.summary);
    // A screen reader reads the longer text: nothing around it is hidden from it.
    expect(detail.closest('[aria-hidden="true"]')).toBeNull();
    expect(screen.getAllByText(`${developer}: ${gateway.summary}`)).toHaveLength(2);
    expect(document.body.textContent).not.toContain('restore-drill');
  });

  it('keeps the line of the capacity where the member gave no sentence', async () => {
    const project = mockProject();
    renderBoardWithDrawer(project);

    const card = await cardOf();
    expect(within(card).getByText(t('taskStatus.worker.working', { name: developer }))).toBeTruthy();
    // Two places say it: the card and the head of the drawer.
    expect(await screen.findAllByText(t('taskStatus.worker.working', { name: developer }))).toHaveLength(2);
  });

  it('shows each of several workers with their own sentence in the drawer, and the card names both', async () => {
    const project = mockProject();
    addQa(project, { summary: 'A kosár tesztjei futnak', detail: 'Mobilon és asztalon is.' });
    renderBoardWithDrawer(project);

    const qa = project.backend.findMember('qa')!.displayName;
    const list = await screen.findByRole('list', {
      name: t('taskStatus.workersTwo', { names: `${developer}${t('common.and')}${qa}` }),
    });
    const rows = within(list).getAllByRole('listitem');
    // The first has no sentence and reads as before; the second has its summary and detail.
    expect(rows[0]!.textContent).toContain(t('taskStatus.worker.working', { name: developer }));
    expect(rows[1]!.textContent).toContain(`${qa}: A kosár tesztjei futnak`);
    expect(rows[1]!.textContent).toContain('Mobilon és asztalon is.');

    const card = await cardOf();
    expect(within(card).getByText(t('taskStatus.worker.working', { name: developer }))).toBeTruthy();
    expect(within(card).getByText(`${qa}: A kosár tesztjei futnak`)).toBeTruthy();
    expect(card.textContent).not.toContain('Mobilon és asztalon is.');
  });

  it('changes the card and the drawer when a session_upserted brings a new sentence, and back when it goes', async () => {
    const project = mockProject();
    ses(project, 'ses_ac20_be1').doing = gateway;
    renderBoardWithDrawer(project);
    const card = await cardOf();
    await within(card).findByText(gateway.summary);

    const first = ses(project, 'ses_ac20_be1');
    const upsert = (session: Session) =>
      act(() => applyServerEvent(client, { type: 'session_upserted', projectKey: 'AC', session }));

    upsert({ ...first, doing: { summary: 'A riasztás küszöbét hangolom', detail: 'Egy perc után szól.' } });
    await waitFor(() => expect(within(card).getByText('A riasztás küszöbét hangolom')).toBeTruthy());
    expect(within(card).queryByText(gateway.summary)).toBeNull();
    expect(await screen.findByText('Egy perc után szól.')).toBeTruthy();
    expect(screen.queryByText(gateway.detail!)).toBeNull();

    // The round ended: the server cleared the sentence, and the line of the capacity is back.
    const { doing: _gone, ...without } = first;
    upsert(without);
    await waitFor(() =>
      expect(within(card).getByText(t('taskStatus.worker.working', { name: developer }))).toBeTruthy(),
    );
    expect(screen.queryByText('Egy perc után szól.')).toBeNull();
  });
});
