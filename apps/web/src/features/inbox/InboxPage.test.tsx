import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InboxItem } from '@projectman/shared';
import { setFetchImplementation } from '../../api/client';
import { ToastProvider } from '../../components/Toast';
import { t } from '../../i18n/t';
import { plainLanguageQuestion } from '../../mocks/fixtures';
import { inboxItemDomId } from '../../lib/inbox';
import { createMockFetch, mockProject } from '../../test/mockProject';
import { TaskDrawer } from '../board/TaskDrawer';
import { InboxPage } from './InboxPage';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

/** A permission the system decided itself, as the server stores it now or stored it before. */
function automaticDecision(
  id: string,
  command: string,
  resolution: Pick<NonNullable<InboxItem['resolution']>, 'note' | 'rule'>,
  minutesAgo: number,
): InboxItem {
  const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  return {
    id,
    projectKey: 'AC',
    kind: 'permission',
    assignees: ['owner'],
    source: 'fe-1',
    sessionId: null,
    taskKey: null,
    title: `Bash: ${command}`,
    body: null,
    payload: { toolName: 'Bash', toolInput: { command }, summary: command },
    options: [],
    state: 'resolved',
    resolution: { optionId: 'deny', by: 'system', at, ...resolution },
    createdAt: at,
  };
}

describe('inbox history', () => {
  it('shows short plain headings for answered markdown questions and keeps date-led headings', async () => {
    const project = mockProject();
    const titles = [
      '**Release now?** Background.\n- First\n- Second',
      '- First\n- Second',
      '2026. október 10-ig kiadhatjuk?',
    ];
    project.backend.inbox.push(
      ...titles.map((title, index): InboxItem => ({
        ...plainLanguageQuestion(),
        id: `inb_answered_${index}`,
        title,
        state: 'resolved',
        resolution: { optionId: 'answer', by: 'owner', at: new Date().toISOString(), note: null },
      })),
    );
    project.render(<InboxPage />, '/p/AC/inbox');
    const history = await screen.findByRole('complementary');
    expect(await within(history).findByText('Release now?')).toBeTruthy();
    expect(within(history).getByText(t('inbox.question.untitled'))).toBeTruthy();
    expect(within(history).getByText(titles[2]!)).toBeTruthy();
    expect(history.textContent).not.toContain('**');
    expect(history.textContent).not.toContain('Background.');
    expect(history.textContent).not.toContain('- First');
  });

  it('names the rule of an automatic decision and shows an older decision note as a note', async () => {
    const project = mockProject();
    project.backend.inbox.push(
      automaticDecision('inb_rule', 'npm publish', { note: null, rule: 'command_policy' }, 1),
      automaticDecision('inb_note', 'git push', { note: 'Fictional note from before rules' }, 2),
    );
    project.render(<InboxPage />, '/p/AC/inbox');
    const history = await screen.findByRole('complementary');
    const rowOf = async (command: string) =>
      (await within(history).findByText(command, { selector: 'code' })).closest('li')!;
    const byRule = await rowOf('npm publish');
    const byNote = await rowOf('git push');
    expect(byRule!.textContent).toContain(t('inbox.resolutions.automatic_deny'));
    expect(byRule!.textContent).toContain(t('inbox.resolutionRules.command_policy'));
    expect(byRule!.textContent).not.toContain(t('common.system'));
    expect(within(byNote!).getByText('Fictional note from before rules')).toBeTruthy();
    expect(byNote!.textContent).toContain(t('common.system'));
  });

  it('shows who asked and for which task in one line, the whole command behind a one-line fold (PM-231)', async () => {
    const project = mockProject();
    const command = "cat <<'EOF' > notes.md\nline two\nline three\nEOF";
    project.backend.inbox.push({
      ...automaticDecision('inb_human', command, { note: null }, 3),
      taskKey: 'AC-141',
      resolution: { optionId: 'allow', by: 'owner', at: new Date().toISOString(), note: null },
    });
    project.render(<InboxPage />, '/p/AC/inbox');
    const history = await screen.findByRole('complementary');
    const row = (await within(history).findByText(/AC-141/)).closest('li')!;
    const line = within(row).getByText(/AC-141/);
    const requester = project.backend.members.find((member) => member.handle === 'fe-1')!.displayName;
    expect(line.textContent).toBe(`${t('inbox.resolutions.allow')} · ${requester} · AC-141`);
    const code = row.querySelector('code')!;
    expect(code.textContent).toBe(command);
    expect(code.style.getPropertyValue('--command-lines')).toBe('1');
  });

  it('folds what the system decided by a rule into one counted row, out of the way of real decisions (PM-231)', async () => {
    const project = mockProject();
    project.backend.inbox.push(
      automaticDecision('inb_auto_1', 'npm run build', { note: null, rule: 'command_policy' }, 1),
      automaticDecision('inb_auto_2', 'ls -la', { note: null, rule: 'command_policy' }, 2),
      automaticDecision('inb_auto_3', 'git status', { note: null, rule: 'command_policy' }, 3),
      {
        ...automaticDecision('inb_human', 'git push', { note: null }, 90),
        resolution: { optionId: 'allow', by: 'owner', at: new Date().toISOString(), note: null },
      },
    );
    project.render(<InboxPage />, '/p/AC/inbox');
    const history = await screen.findByRole('complementary');
    const fold = history.querySelector('details')!;
    expect(fold.open).toBe(false);
    expect(within(fold).getByText(t('inbox.automaticDecisions', { count: 3 }))).toBeTruthy();
    expect(within(fold).getAllByRole('listitem')).toHaveLength(3);
    // The real decision is listed outside the fold, the automatic ones are not.
    const outside = within(history)
      .getAllByRole('listitem')
      .filter((item) => !fold.contains(item));
    expect(outside.some((item) => item.textContent?.includes('git push'))).toBe(true);
    for (const item of outside)
      expect(item.textContent).not.toContain(t('inbox.resolutionRules.command_policy'));
  });

  it('has no folded row when the system decided nothing', async () => {
    const project = mockProject();
    project.backend.inbox.push({
      ...automaticDecision('inb_human', 'git push', { note: null }, 5),
      resolution: { optionId: 'allow', by: 'owner', at: new Date().toISOString(), note: null },
    });
    project.render(<InboxPage />, '/p/AC/inbox');
    const history = await screen.findByRole('complementary');
    expect(history.querySelector('details')).toBeNull();
  });
});

describe('the filter row (PM-231)', () => {
  it('shows the filter row only while something waits', async () => {
    const project = mockProject();
    project.render(<InboxPage />, '/p/AC/inbox');
    await screen.findByRole('heading', {
      name: t('inbox.permissionHeading', { tool: t('session.tools.git') }),
    });
    expect(screen.getByRole('group', { name: t('inbox.filtersLabel') })).toBeTruthy();
  });

  it('leaves out the five empty buttons when nothing is open', async () => {
    const project = mockProject();
    project.backend.inbox = project.backend.inbox.filter((item) => item.state !== 'open');
    project.render(<InboxPage />, '/p/AC/inbox');
    await screen.findByText(t('inbox.allDoneEverywhere'));
    expect(screen.queryByText(t('inbox.filters.all'))).toBeNull();
  });
});

describe('feedback and the history box (PM-97)', () => {
  it('says a decision went through, since the card disappears', async () => {
    const project = mockProject();
    project.render(
      <ToastProvider>
        <InboxPage />
      </ToastProvider>,
      '/p/AC/inbox',
    );
    const card = (
      await screen.findByRole('heading', {
        name: t('inbox.permissionHeading', { tool: t('session.tools.git') }),
      })
    ).closest('article')!;
    fireEvent.click(within(card).getByRole('button', { name: t('inbox.options.allow') }));
    expect(await screen.findByText(t('inbox.resolutions.allow'))).toBeTruthy();
  });

  it('does not show the history box before anything was decided', async () => {
    const project = mockProject();
    project.backend.inbox = project.backend.inbox.filter((item) => item.state === 'open');
    project.render(<InboxPage />, '/p/AC/inbox');
    await screen.findByRole('heading', {
      name: t('inbox.permissionHeading', { tool: t('session.tools.git') }),
    });
    expect(screen.queryByText(t('inbox.recent'))).toBeNull();
  });
});

describe('"Vidd tovább" in the inbox (PM-461)', () => {
  function handOnProject() {
    const project = mockProject();
    project.backend.inbox = project.backend.inbox.filter((item) => item.state !== 'open');
    project.backend.config.team.cardMover = { kind: 'human', handle: 'owner' };
    project.backend.moveAs('AC-20', 'code_review', 'be-1');
    return project;
  }
  const move = t('inbox.handOn.move', { stage: 'Code review' });

  it('moves the card on a click and says so, in the toast and in the history', async () => {
    const project = handOnProject();
    project.render(
      <ToastProvider>
        <InboxPage />
      </ToastProvider>,
      '/p/AC/inbox',
    );
    fireEvent.click(await screen.findByRole('button', { name: move }));
    await waitFor(() => expect(project.backend.findTask('AC-20')!.stageId).toBe('code_review'));
    expect(project.requests.find((request) => request.path.endsWith('/resolve'))?.body).toEqual({
      optionId: 'move',
    });
    expect(
      (await screen.findAllByText(t('inbox.handOn.resolvedMe', { stage: 'Code review' }))).length,
    ).toBeGreaterThan(0);
  });

  it('keeps the item and shows the gate error on the card when the move is refused', async () => {
    const project = handOnProject();
    project.backend.config.pipeline.stages.find((stage) => stage.id === 'code_review')!.gate = {
      conditions: [{ type: 'has_label', label: 'design-review-ok' }],
    };
    project.render(<InboxPage />, '/p/AC/inbox');
    fireEvent.click(await screen.findByRole('button', { name: move }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/^A kapu még nem enged tovább/);
    expect(alert.closest('article')).toBeTruthy();
    expect(project.backend.findTask('AC-20')!.stageId).toBe('dev');
    expect(screen.getByRole('button', { name: move })).toBeTruthy();
  });
});

describe('plain-language questions in the inbox', () => {
  const question = plainLanguageQuestion();

  /** The card of the open item with this heading. */
  const cardOf = async (title: string) =>
    (await screen.findByRole('heading', { name: title })).closest('article')!;

  it('shows a short date-led question as a whole heading without a list', async () => {
    const project = mockProject();
    const title = '2026. október 10-ig kiadhatjuk?';
    project.backend.inbox.push({ ...question, title });
    project.render(<InboxPage />, '/p/AC/inbox');
    const card = await cardOf(title);
    expect(card.querySelector('ol')).toBeNull();
    expect(within(card).queryByText(t('inbox.question.untitled'))).toBeNull();
  });

  it('shows the question with its recommendation, consequences and folded details, and answers it', async () => {
    const project = mockProject();
    project.backend.inbox.push(question);
    project.render(<InboxPage />, '/p/AC/inbox');

    const card = await cardOf(question.title);
    const recommended = within(card).getByRole('button', { name: 'Az űrlap alatt' }).closest('li')!;
    expect(within(recommended).getByText(t('inbox.question.recommended'))).toBeTruthy();
    expect(
      within(recommended).getByText(
        `${t('inbox.question.reasonLabel')} Telefonon is jól olvasható, és nem tűnik el magától.`,
      ),
    ).toBeTruthy();
    expect(within(card).getByText('A hibaüzenet addig látszik, amíg ki nem javítod a címet.')).toBeTruthy();
    expect(within(card).getByText('Pár másodperc múlva eltűnik, ezért könnyű lemaradni róla.')).toBeTruthy();
    const fold = card.querySelector('details')!;
    expect(fold.open).toBe(false);
    fireEvent.click(fold.querySelector('summary')!);
    expect(fold.open).toBe(true);
    expect(within(fold).getByText(/ToastProvider/)).toBeTruthy();

    fireEvent.click(within(card).getByRole('button', { name: 'Az űrlap alatt' }));
    await waitFor(() =>
      expect(project.requests).toContainEqual({
        method: 'POST',
        path: `/api/projects/AC/inbox/${question.id}/resolve`,
        body: { optionId: 'option_1' },
      }),
    );
    await waitFor(() => expect(screen.queryByRole('heading', { name: question.title })).toBeNull());
    expect(project.backend.inbox.find((item) => item.id === question.id)).toMatchObject({
      state: 'resolved',
      resolution: { optionId: 'option_1', by: 'owner' },
    });
    // The history names the answer like any other.
    expect(
      within(await screen.findByRole('complementary')).getByText(new RegExp(question.title)),
    ).toBeTruthy();
  });

  it('leaves the questions that do not use the new fields as they were, next to one that does', async () => {
    const project = mockProject();
    project.backend.inbox.push(question);
    project.render(<InboxPage />, '/p/AC/inbox');

    await cardOf(question.title);
    const old = project.backend.inbox.find((item) => item.id === 'inb_q_ga4')!;
    const card = await cardOf(old.title);
    expect(
      within(card)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Elég a süti nélküli', 'Kell GA4 is', t('inbox.options.answer')]);
    expect(within(card).queryByRole('list')).toBeNull();
    expect(within(card).queryByText(t('inbox.question.recommended'))).toBeNull();
    expect(card.querySelector('details')).toBeNull();
    // One badge on the page: the new question's.
    expect(screen.getAllByText(t('inbox.question.recommended'))).toHaveLength(1);
  });

  it('lists the options on a phone too', async () => {
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }));
    const project = mockProject();
    project.backend.inbox.push(question);
    project.render(<InboxPage />, '/p/AC/inbox');

    const card = await cardOf(question.title);
    expect(card.className).toMatch(/mobile/);
    expect(within(card).getByRole('list').className).toMatch(/mobile/);
    expect(within(card).getByText(t('inbox.question.recommended'))).toBeTruthy();
    expect(card.querySelector('details')!.open).toBe(false);
  });
});

function Where() {
  const { pathname } = useLocation();
  return <output data-testid="where">{pathname}</output>;
}

const withDrawer = (
  <>
    <Routes>
      <Route path="/p/:projectKey/inbox" element={<InboxPage />}>
        <Route path="tasks/:taskKey/*" element={<TaskDrawer />} />
      </Route>
    </Routes>
    <Where />
  </>
);
const where = () => screen.getByTestId('where').textContent;
const drawer = () => screen.findByRole('complementary', { name: t('task.drawerLabel') });

describe('the card row of an inbox item (PM-501)', () => {
  /** The first question: AC-22's, a free answer, so a started answer can be typed. */
  function ownAnswer(project: ReturnType<typeof mockProject>) {
    const base = project.backend.inbox.find((item) => item.id === 'inb_q_ga4')!;
    project.backend.inbox = project.backend.inbox.filter((item) => item.id !== 'inb_q_ga4');
    project.backend.inbox.push({ ...base, id: 'inb_q_own', options: [] });
    return project.backend.findTask('AC-22')!.title;
  }

  it('is a link `KEY title` to the card, whose drawer opens over the inbox', async () => {
    const project = mockProject();
    const title = ownAnswer(project);
    project.render(withDrawer, '/p/AC/inbox');

    const link = await screen.findByRole('link', {
      name: t('inbox.card.openLabel', { key: 'AC-22', title }),
    });
    expect(link.textContent).toBe(`AC-22 ${title}`);
    expect(link.getAttribute('href')).toBe('/p/AC/inbox/tasks/AC-22');

    fireEvent.click(link);
    await drawer();
    expect(where()).toBe('/p/AC/inbox/tasks/AC-22');
    // The inbox stays under the drawer, and the drawer's title is the document's.
    expect(document.getElementById(inboxItemDomId('inb_q_own'))).toBeTruthy();
    expect(document.title).toContain('AC-22');
  });

  it('shows the drawer title when the drawer mounts with the page (a direct link)', async () => {
    const project = mockProject();
    ownAnswer(project);
    project.render(withDrawer, '/p/AC/inbox/tasks/AC-22');

    await drawer();
    await waitFor(() => expect(document.title).toContain('AC-22'));

    fireEvent.click(within(await drawer()).getByRole('button', { name: t('common.close') }));
    await waitFor(() => expect(where()).toBe('/p/AC/inbox'));
    await waitFor(() => expect(document.title).not.toContain('AC-22'));
    expect(document.title).toContain(t('inbox.title'));
  });

  it('closes back to the inbox on ✕ and on Esc, with the focus on the link and the started answer kept', async () => {
    const project = mockProject();
    const title = ownAnswer(project);
    project.render(withDrawer, '/p/AC/inbox');
    const link = await screen.findByRole('link', {
      name: t('inbox.card.openLabel', { key: 'AC-22', title }),
    });
    const answer = screen.getByRole('textbox', { name: t('inbox.answerLabel') });
    fireEvent.change(answer, { target: { value: 'Elég a süti nélküli' } });
    const inboxTitle = document.title;

    for (const close of [
      async () => fireEvent.click(within(await drawer()).getByRole('button', { name: t('common.close') })),
      async () => {
        await drawer();
        fireEvent.keyDown(document, { key: 'Escape' });
      },
    ]) {
      fireEvent.click(link);
      await drawer();
      await close();
      await waitFor(() => expect(where()).toBe('/p/AC/inbox'));
      expect(screen.queryByRole('complementary', { name: t('task.drawerLabel') })).toBeNull();
      await waitFor(() => expect(document.activeElement).toBe(link));
      expect(
        (screen.getByRole('textbox', { name: t('inbox.answerLabel') }) as HTMLTextAreaElement).value,
      ).toBe('Elég a süti nélküli');
      expect(document.title).toBe(inboxTitle);
    }
  });

  it('has no link on the compact cards of the drawer', async () => {
    const project = mockProject();
    ownAnswer(project);
    project.render(withDrawer, '/p/AC/inbox/tasks/AC-22');
    const panel = await drawer();
    // The card's open question stands in the drawer as a compact card.
    await within(panel).findByText(project.backend.inbox.find((item) => item.id === 'inb_q_own')!.title);
    expect(panel.querySelector('[data-inbox-card-link]')).toBeNull();
    expect(within(panel).queryByRole('link', { name: /kártya megnyitása/ })).toBeNull();
  });

  it('is no link on a "Vidd tovább" item, and no row on an item without a card', async () => {
    const project = mockProject();
    project.backend.inbox = project.backend.inbox.filter((item) => item.state !== 'open');
    project.backend.config.team.cardMover = { kind: 'human', handle: 'owner' };
    project.backend.moveAs('AC-20', 'code_review', 'be-1');
    project.backend.inbox.push({
      ...project.backend.inbox[0]!,
      id: 'inb_nocard',
      kind: 'approval',
      taskKey: null,
      state: 'open',
      resolution: null,
      title: 'Levél Katának',
      assignees: ['owner'],
    });
    project.render(withDrawer, '/p/AC/inbox');
    await screen.findByRole('button', { name: t('inbox.handOn.move', { stage: 'Code review' }) });
    expect(document.querySelector('[data-inbox-card-link]')).toBeNull();
    const plain = (await screen.findByRole('heading', { name: 'Levél Katának' })).closest('article')!;
    expect(plain.querySelector('p[class*="task"]')).toBeNull();
  });

  it('is plain text for a card the board does not have, and only the key while the board loads', async () => {
    const project = mockProject();
    ownAnswer(project);
    project.backend.inbox.find((item) => item.id === 'inb_q_own')!.taskKey = 'AC-999';
    project.render(withDrawer, '/p/AC/inbox');
    await screen.findByRole('textbox', { name: t('inbox.answerLabel') });
    const row = document.getElementById(inboxItemDomId('inb_q_own'))!.querySelector('p[class*="task"]')!;
    expect(row.textContent).toBe('AC-999');
    expect(row.querySelector('a')).toBeNull();
  });

  it('shows only the key, as a link, while the board has not come yet', async () => {
    const project = mockProject();
    ownAnswer(project);
    const answer = createMockFetch(project.backend, project.requests);
    setFetchImplementation((path, init) =>
      path.endsWith('/board') ? new Promise<Response>(() => {}) : answer(path, init),
    );
    project.render(withDrawer, '/p/AC/inbox');
    const link = await screen.findByRole('link', { name: t('inbox.card.openLabelKey', { key: 'AC-22' }) });
    expect(link.textContent).toBe('AC-22');
    expect(link.getAttribute('href')).toBe('/p/AC/inbox/tasks/AC-22');
  });

  it('shows only the key on a gate decision while the board loads, not the decision title', async () => {
    const project = mockProject();
    const answer = createMockFetch(project.backend, project.requests);
    setFetchImplementation((path, init) =>
      path.endsWith('/board') ? new Promise<Response>(() => {}) : answer(path, init),
    );
    project.render(withDrawer, '/p/AC/inbox');
    const link = await screen.findByRole('link', { name: t('inbox.card.openLabelKey', { key: 'AC-17' }) });
    expect(link.textContent).toBe('AC-17');
  });
});
