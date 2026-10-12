import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Route, Routes, useLocation } from 'react-router';
import { setFetchImplementation } from '../../api/client';
import { ToastProvider } from '../../components/Toast';
import { t } from '../../i18n/t';
import { createMockFetch, mockProject } from '../../test/mockProject';
import { FeedbackPage } from './FeedbackPage';

afterEach(() => {
  vi.restoreAllMocks();
  setFetchImplementation((input, init) => globalThis.fetch(input, init));
});

function Where() {
  const location = useLocation();
  return <output data-testid="where">{`${location.pathname}${location.search}`}</output>;
}

function Pages() {
  return (
    <>
      <Routes>
        <Route path="/p/:projectKey/feedback" element={<FeedbackPage />} />
        <Route path="/p/:projectKey/feedback/:markId" element={<FeedbackPage />} />
        <Route path="/p/:projectKey/tasks/:taskKey" element={<p>card page</p>} />
      </Routes>
      <Where />
    </>
  );
}

const where = () => screen.getByTestId('where').textContent;

function phone(mobile: boolean) {
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
    matches: mobile,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  }));
}

type Project = ReturnType<typeof mockProject>;

function seeded() {
  const p = mockProject();
  p.backend.feedback.seedSample();
  return p;
}

/** Kata is a client of the project: a member who reads the marks but processes none. */
function asClient(p: Project) {
  p.backend.viewerHandle = 'kata';
  const me = { ...p.context.me, projects: [{ ...p.context.me.projects[0]!, access: 'client' as const }] };
  return {
    me,
    myHandle: 'kata',
    isOwner: false,
    can: { createTasks: false, manageTeam: false, workInSessions: false },
  };
}

const POSTS = (p: Project, suffix: string) =>
  p.requests.filter((r) => r.method === 'POST' && r.path.endsWith(suffix));

const rowOf = (text: string | RegExp) => screen.getByText(text).closest('a')!;

describe('the mark list', () => {
  it('lists the marks to do first, with the counts on the filters', async () => {
    const p = seeded();
    p.render(<Pages />, '/p/AC/feedback');
    const list = await screen.findByRole('list', { name: t('feedback.list.label') });
    expect(within(list).getByText(/A kupon mező kitakarja/)).toBeTruthy();
    expect(within(list).getByText(/Az üres kosár szövegében/)).toBeTruthy();
    // The handled and closed marks are not "to do".
    expect(within(list).queryByText(/A „Vissza a bolthoz” gomb/)).toBeNull();
    const filters = screen.getByRole('group', { name: t('feedback.filters.label') });
    expect(within(filters).getByRole('button', { name: new RegExp(t('feedback.filters.all')) })).toBeTruthy();
    expect(
      within(filters).getByRole('button', { name: new RegExp(t('feedback.filters.todo')) }),
    ).toBeTruthy();
    // Nothing picked yet on a wide screen.
    expect(screen.getByText(t('feedback.pick'))).toBeTruthy();
  });

  it('keeps the filter in the address and shows every mark under "all"', async () => {
    const p = seeded();
    p.render(<Pages />, '/p/AC/feedback');
    await screen.findByRole('list', { name: t('feedback.list.label') });
    fireEvent.click(
      within(screen.getByRole('group', { name: t('feedback.filters.label') })).getByRole('button', {
        name: new RegExp(t('feedback.filters.all')),
      }),
    );
    await waitFor(() => expect(where()).toContain('f=all'));
    expect(screen.getByText(/A „Vissza a bolthoz” gomb/)).toBeTruthy();
    expect(screen.getByText(/Meddig érvényes a szállítási ár/)).toBeTruthy();
  });

  it('narrows the list to one marker', async () => {
    const p = seeded();
    p.render(<Pages />, '/p/AC/feedback?f=all');
    await screen.findByRole('list', { name: t('feedback.list.label') });
    fireEvent.change(screen.getByLabelText(t('feedback.filters.marker')), { target: { value: 'bence' } });
    await waitFor(() => expect(where()).toContain('by=bence'));
    expect(screen.queryByText(/A kupon mező kitakarja/)).toBeNull();
    expect(screen.getByText(/Az üres kosár szövegében/)).toBeTruthy();
  });

  it('offers to clear the filters when nothing matches', async () => {
    const p = seeded();
    p.render(<Pages />, '/p/AC/feedback?f=closed&by=bence');
    expect(await screen.findByText(t('feedback.filters.empty'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('feedback.filters.clear') }));
    await waitFor(() => expect(where()).toBe('/p/AC/feedback?f=all'));
    expect(screen.getByRole('list', { name: t('feedback.list.label') })).toBeTruthy();
  });

  it('opens a mark beside the list', async () => {
    const p = seeded();
    p.render(<Pages />, '/p/AC/feedback');
    await screen.findByRole('list', { name: t('feedback.list.label') });
    fireEvent.click(rowOf(/A kupon mező kitakarja/));
    const detail = await screen.findByRole('region', { name: t('feedback.detail.label') });
    expect(within(detail).getByRole('heading', { name: /A kupon mező kitakarja/ })).toBeTruthy();
    expect(where()).toMatch(/^\/p\/AC\/feedback\/fbm_/);
    // The processor sees what the browser reported, and the owner opened it, so it is read.
    expect(within(detail).getByText(t('feedback.details.title'))).toBeTruthy();
    await waitFor(() => expect(POSTS(p, '/read')).toHaveLength(1));
  });
});

describe('the states of the page', () => {
  it('tells the owner where to set the tool up when there is no surface and no mark', async () => {
    const p = mockProject();
    p.render(<Pages />, '/p/AC/feedback');
    expect(await screen.findByText(t('feedback.notConfigured.ownerTitle'))).toBeTruthy();
    const link = screen.getByRole('link', { name: t('feedback.notConfigured.setUp') });
    expect(link.getAttribute('href')).toBe('/p/AC/settings/feedback');
    // A line of zero counts says nothing before anything is set up.
    expect(screen.queryByText(t('feedback.summary.processor', { fresh: 0, waiting: 0 }))).toBeNull();
  });

  it('tells a client it is not switched on, without a way to set it up', async () => {
    const p = mockProject();
    const overrides = asClient(p);
    p.render(<Pages />, '/p/AC/feedback', overrides);
    expect(await screen.findByText(t('feedback.notConfigured.title'))).toBeTruthy();
    expect(screen.queryByRole('link', { name: t('feedback.notConfigured.setUp') })).toBeNull();
  });

  it('says there is no mark yet when a surface is set up', async () => {
    const p = mockProject();
    p.backend.feedback.addSurface({ id: 'a1b2c3d4', name: 'Webshop', origin: 'https://acme.test' });
    p.render(<Pages />, '/p/AC/feedback');
    expect(await screen.findByText(t('feedback.empty.title'))).toBeTruthy();
    expect(screen.getByText(t('feedback.empty.processorBody'))).toBeTruthy();
  });

  it('shows the error with a retry when the list does not load', async () => {
    const p = seeded();
    let failing = true;
    const real = createMockFetch(p.backend, p.requests);
    setFetchImplementation(async (input, init) => {
      if (failing && String(input).endsWith('/feedback'))
        return new Response('{"error":"boom"}', { status: 500 });
      return real(String(input), init);
    });
    p.render(<Pages />, '/p/AC/feedback');
    expect(await screen.findByText(t('feedback.loadFailed'))).toBeTruthy();
    failing = false;
    fireEvent.click(screen.getByRole('button', { name: t('app.retry') }));
    expect(await screen.findByRole('list', { name: t('feedback.list.label') })).toBeTruthy();
  });
});

describe('what a client sees', () => {
  it('shows "went into a task" without the key for an internal card', async () => {
    const p = seeded();
    const overrides = asClient(p);
    p.render(<Pages />, '/p/AC/feedback?f=all', overrides);
    await screen.findByRole('list', { name: t('feedback.list.label') });
    fireEvent.click(rowOf(/A főoldali banner képe/));
    const detail = await screen.findByRole('region', { name: t('feedback.detail.label') });
    expect(within(detail).getByText(t('feedback.decision.internalCard'))).toBeTruthy();
    expect(within(detail).queryByText(/AC-24/)).toBeNull();
    expect(within(detail).queryByText(/Hibariasztás/)).toBeNull();
    // A client processes nothing: no actions, no browser details.
    expect(within(detail).queryByRole('button', { name: t('feedback.actions.create') })).toBeNull();
    expect(within(detail).queryByText(t('feedback.details.title'))).toBeNull();
    expect(
      within(screen.getByRole('list', { name: t('feedback.list.label') })).queryByText('AC-24'),
    ).toBeNull();
  });
});

describe('working a mark', () => {
  async function open(p: Project, text: string | RegExp) {
    p.render(<Pages />, '/p/AC/feedback');
    await screen.findByRole('list', { name: t('feedback.list.label') });
    fireEvent.click(rowOf(text));
    return screen.findByRole('region', { name: t('feedback.detail.label') });
  }

  it('opens a card from the mark with the words of the mark in it', async () => {
    const p = seeded();
    const detail = await open(p, /A kupon mező kitakarja/);
    fireEvent.click(within(detail).getByRole('button', { name: t('feedback.actions.create') }));
    const dialog = await screen.findByRole('dialog', { name: t('feedback.create.heading') });
    fireEvent.change(within(dialog).getByLabelText(/Válasz a jelölőnek/), {
      target: { value: 'Felvettem.' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: t('feedback.create.submit') }));
    await waitFor(() => expect(POSTS(p, '/task')).toHaveLength(1));
    const body = POSTS(p, '/task')[0]!.body as Record<string, string>;
    expect(body.description).toContain('A kupon mező kitakarja');
    expect(body.description).toContain('/penztar');
    expect(body.description).toContain('Kata');
    expect(body.visibility).toBe('shared');
    expect(body.reply).toBe('Felvettem.');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // The mark now stands on the card.
    expect(await within(detail).findByText(new RegExp(t('feedback.decision.created')))).toBeTruthy();
  });

  it('links the mark to an existing card', async () => {
    const p = seeded();
    const detail = await open(p, /Az üres kosár szövegében/);
    fireEvent.click(within(detail).getByRole('button', { name: t('feedback.actions.link') }));
    const dialog = await screen.findByRole('dialog', { name: t('feedback.link.heading') });
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'AC-24' } });
    fireEvent.click(await within(dialog).findByRole('option', { name: /AC-24/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: t('feedback.link.submit') }));
    await waitFor(() => expect(POSTS(p, '/link')).toHaveLength(1));
    expect(POSTS(p, '/link')[0]!.body).toMatchObject({ taskKey: 'AC-24' });
  });

  it('answers the marker with a comment', async () => {
    const p = seeded();
    const detail = await open(p, /A kupon mező kitakarja/);
    const box = within(detail).getByPlaceholderText(t('feedback.composer.processor', { name: 'Kata' }));
    fireEvent.change(box, { target: { value: 'Köszönjük, nézzük.' } });
    fireEvent.click(within(detail).getByRole('button', { name: t('feedback.composer.send') }));
    await waitFor(() => expect(POSTS(p, '/comments')).toHaveLength(1));
    expect(POSTS(p, '/comments')[0]!.body).toEqual({ body: 'Köszönjük, nézzük.' });
    expect(await within(detail).findByText('Köszönjük, nézzük.')).toBeTruthy();
  });

  it('closes the mark with a last word and can open it again', async () => {
    const p = seeded();
    const detail = await open(p, /Az üres kosár szövegében/);
    fireEvent.click(within(detail).getByRole('button', { name: t('feedback.actions.close') }));
    const dialog = await screen.findByRole('dialog', { name: t('feedback.close.heading') });
    fireEvent.change(within(dialog).getByLabelText(/Válasz a jelölőnek/), {
      target: { value: 'Javítva.' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: t('feedback.close.submit') }));
    await waitFor(() => expect(POSTS(p, '/close')).toHaveLength(1));
    expect(POSTS(p, '/close')[0]!.body).toEqual({ reply: 'Javítva.' });
    const reopen = await within(detail).findByRole('button', { name: t('feedback.actions.reopen') });
    // The processor sees the same closing line as the marker does.
    expect(within(detail).getByText(t('feedback.composer.closed'))).toBeTruthy();
    fireEvent.click(reopen);
    await waitFor(() => expect(POSTS(p, '/reopen')).toHaveLength(1));
  });

  it('words the link button "another card" when the mark already stands on one', async () => {
    const p = seeded();
    const detail = await open(p, /Az üres kosár szövegében/);
    fireEvent.click(within(detail).getByRole('button', { name: t('feedback.actions.link') }));
    const dialog = await screen.findByRole('dialog', { name: t('feedback.link.heading') });
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'AC-24' } });
    fireEvent.click(await within(dialog).findByRole('option', { name: /AC-24/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: t('feedback.link.submit') }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(
      await within(detail).findByRole('button', { name: t('feedback.actions.linkAnother') }),
    ).toBeTruthy();
    expect(within(detail).queryByRole('button', { name: t('feedback.actions.link') })).toBeNull();
  });
});

describe('opening the page of the product', () => {
  it('opens a tab at once and points it at the address the server gave', async () => {
    const p = seeded();
    const tab = { opener: {} as unknown, location: { href: '' }, close: vi.fn() };
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    p.render(<Pages />, '/p/AC/feedback');
    fireEvent.click(await screen.findByRole('button', { name: t('feedback.launch.button') }));
    expect(open).toHaveBeenCalledWith('', '_blank');
    await waitFor(() => expect(tab.location.href).not.toBe(''));
    expect(tab.opener).toBeNull();
    expect(POSTS(p, '/launch')[0]!.body).toEqual({ surfaceId: 'a1b2c3d4' });
  });

  it('says so when the browser refuses the new tab, and asks the server for nothing', async () => {
    const p = seeded();
    vi.spyOn(window, 'open').mockReturnValue(null);
    p.render(
      <ToastProvider>
        <Pages />
      </ToastProvider>,
      '/p/AC/feedback',
    );
    fireEvent.click(await screen.findByRole('button', { name: t('feedback.launch.button') }));
    expect(await screen.findByText(t('feedback.launch.popupBlocked'))).toBeTruthy();
    expect(POSTS(p, '/launch')).toHaveLength(0);
  });

  it('closes the empty tab and says so when the server refuses', async () => {
    const p = seeded();
    const tab = { opener: {} as unknown, location: { href: '' }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    const mock = createMockFetch(p.backend, p.requests);
    setFetchImplementation((input, init) =>
      input.endsWith('/launch') ? Promise.resolve(new Response('{}', { status: 500 })) : mock(input, init),
    );
    p.render(
      <ToastProvider>
        <Pages />
      </ToastProvider>,
      '/p/AC/feedback',
    );
    fireEvent.click(await screen.findByRole('button', { name: t('feedback.launch.button') }));
    expect(await screen.findByText(t('feedback.launch.failed'))).toBeTruthy();
    expect(tab.close).toHaveBeenCalled();
    expect(tab.location.href).toBe('');
  });
});

describe('a viewer of the project', () => {
  it('reads the thread but gets no box to write in', async () => {
    const p = seeded();
    const kata = p.backend.config.team.members.find((member) => member.handle === 'kata');
    if (kata?.kind === 'human') kata.access = 'viewer';
    const client = asClient(p);
    p.render(<Pages />, '/p/AC/feedback?f=all', client);
    fireEvent.click(await screen.findByText(/A kupon mező kitakarja/));
    const detail = await screen.findByRole('region', { name: t('feedback.detail.label') });
    expect(await within(detail).findByText(t('feedback.composer.viewer'))).toBeTruthy();
    expect(within(detail).queryByRole('button', { name: t('feedback.composer.send') })).toBeNull();
  });
});

describe('a mark that does not exist', () => {
  it('offers the way back to the list', async () => {
    const p = seeded();
    p.render(<Pages />, '/p/AC/feedback/fbm_nonexistent');
    expect(await screen.findByText(t('feedback.detail.notFound'))).toBeTruthy();
    expect(
      screen.getByRole('link', { name: t('feedback.detail.backToList') }).getAttribute('href'),
    ).toContain('/p/AC/feedback');
  });
});

describe('on a phone', () => {
  it('shows the list, then the mark with a way back', async () => {
    phone(true);
    const p = seeded();
    p.render(<Pages />, '/p/AC/feedback');
    await screen.findByRole('list', { name: t('feedback.list.label') });
    expect(screen.queryByRole('region', { name: t('feedback.detail.label') })).toBeNull();
    fireEvent.click(rowOf(/A kupon mező kitakarja/));
    await screen.findByRole('region', { name: t('feedback.detail.label') });
    expect(screen.queryByRole('list', { name: t('feedback.list.label') })).toBeNull();
    fireEvent.click(screen.getByRole('link', { name: t('feedback.detail.back') }));
    expect(await screen.findByRole('list', { name: t('feedback.list.label') })).toBeTruthy();
  });
});
