import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { focusManager } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MachineView } from '@projectman/shared';
import { setFetchImplementation } from '../../api/client';
import { MockBackend } from '../../mocks/backend';
import { createMockFetch, mockProject } from '../../test/mockProject';
import { ToastContext } from '../../components/toastContext';
import { formatDuration, formatMemory } from '../../i18n/format';
import { MachineIndicator } from './MachineIndicator';

afterEach(() => {
  vi.useRealTimers();
  focusManager.setFocused(undefined);
  setFetchImplementation((path, init) => globalThis.fetch(path, init));
});

function setup() {
  const backend = new MockBackend();
  backend.machine = MachineView.parse(backend.handle('GET', '/api/machine', undefined).body);
  const project = mockProject(backend);
  return { ...project, sample: backend.machine };
}
async function open() {
  fireEvent.click(await screen.findByRole('button', { name: /Gép: processzor/ }));
  return screen.findByRole('dialog', { name: 'Gép és munkamenetek' });
}

describe('machine display', () => {
  it('polls every 15 seconds closed and 5 seconds open, with no background polling', async () => {
    vi.useFakeTimers();
    focusManager.setFocused(true);
    const project = setup();
    const view = project.render(<MachineIndicator />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    const count = () => project.requests.filter((row) => row.path.startsWith('/api/machine')).length;
    expect(count()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });
    expect(count()).toBe(2);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Gép: processzor/ }));
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(count()).toBe(3);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(count()).toBe(4);
    focusManager.setFocused(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000);
    });
    expect(count()).toBe(4);
    view.unmount();
    view.client.clear();
  });

  it('shows pending session stop and leaves the row available after a network failure', async () => {
    const project = setup();
    const fetch = createMockFetch(project.backend, project.requests);
    let resolve: ((response: Response) => void) | undefined;
    setFetchImplementation((path, init) =>
      path.endsWith('/stop')
        ? new Promise<Response>((done) => {
            resolve = done;
          })
        : fetch(path, init),
    );
    project.render(<MachineIndicator />);
    const dialog = await open();
    fireEvent.click(within(dialog).getAllByRole('button', { name: /^Leállítás:/ })[0]!);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Leállítás' }));
    expect(await within(dialog).findByText('Leáll…')).toBeTruthy();
    await act(async () => {
      resolve!(new Response('{}', { status: 500 }));
    });
    expect(await within(dialog).findByText('Nem sikerült leállítani. Próbáld újra.')).toBeTruthy();
    expect(within(dialog).getAllByRole('button', { name: /^Leállítás:/ }).length).toBe(
      project.sample.sessions.length,
    );
  });

  it('reports a partial bulk stop and keeps refused and failed rows', async () => {
    const project = setup();
    const show = vi.fn();
    project.sample.orphans = [1, 2, 3].map((pid) => ({
      pid,
      startedAt: project.sample.sampledAt!,
      name: `vitest-${pid}`,
      command: 'vitest run',
      cpuPercent: 5,
      memoryBytes: 1024 ** 3,
      processCount: 2,
      origin: null,
    }));
    project.backend.orphanStopOutcomes = { 2: 'refused', 3: 'failed' };
    project.render(
      <ToastContext.Provider value={{ show }}>
        <MachineIndicator />
      </ToastContext.Provider>,
    );
    const dialog = await open();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mind leállítása' }));
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Mind leállítása' }).at(-1)!);
    expect(await within(dialog).findByText('1 folyamat leállt, 2 nem.')).toBeTruthy();
    await waitFor(() => expect(within(dialog).queryByText('vitest-1')).toBeNull());
    expect(within(dialog).getByText('vitest-2')).toBeTruthy();
    expect(within(dialog).getByText('vitest-3')).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Leállítás: vitest-2, Gazdátlan' })).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Leállítás: vitest-3, Gazdátlan' })).toBeTruthy();
    expect(show).toHaveBeenCalledWith('1 folyamat leállt, 2 nem.', 'error');
  });

  it('does not request or render machine data for a non-owner', async () => {
    const project = setup();
    project.backend.viewerHandle = 'be-1';
    project.render(<MachineIndicator />);
    await waitFor(() => expect(project.requests.some((row) => row.path === '/api/me')).toBe(true));
    expect(screen.queryByRole('button', { name: /Gép:/ })).toBeNull();
    expect(project.requests.some((row) => row.path.startsWith('/api/machine'))).toBe(false);
    expect(project.backend.handle('GET', '/api/machine', undefined).status).toBe(403);
  });

  it.each([
    ['warn', 'high', 'Magas'],
    ['critical', 'critical', 'Kritikus'],
  ] as const)('uses shared pressure levels for %s and changes the icon', async (pressure, level, label) => {
    const project = setup();
    project.sample.summary.memoryPressure = pressure;
    project.render(<MachineIndicator />);
    const button = await screen.findByRole('button', { name: new RegExp(`${label} terhelés`) });
    expect(button.getAttribute('data-level')).toBe(level);
    expect(button.querySelector('circle')).toBeTruthy();
  });

  it('requests panel=1 at opening and preserves ordering while list focus is inside', async () => {
    const project = setup();
    const first = project.sample.sessions[0]!;
    const second = project.sample.sessions[1]!;
    first.memoryBytes = 1024 ** 3;
    second.memoryBytes = 2 * 1024 ** 3;
    project.sample.sessions = [first, second];
    const view = project.render(<MachineIndicator />);
    const dialog = await open();
    await waitFor(() =>
      expect(project.requests.some((row) => row.path === '/api/machine?panel=1')).toBe(true),
    );
    const ids = () =>
      [...dialog.querySelectorAll('[data-session-id]')].map((row) => row.getAttribute('data-session-id'));
    expect(ids()).toEqual([second.sessionId, first.sessionId]);
    const button = within(dialog).getAllByRole('button', { name: /Folyamatok:/ })[0]!;
    act(() => button.focus());
    first.memoryBytes = 3 * 1024 ** 3;
    await act(async () => {
      await view.client.invalidateQueries({ queryKey: ['machine'] });
    });
    expect(ids()).toEqual([second.sessionId, first.sessionId]);
    act(() => screen.getByRole('button', { name: /Gép: processzor/ }).focus());
    await waitFor(() => expect(ids()).toEqual([first.sessionId, second.sessionId]));
    expect(dialog.querySelector('th[aria-sort="descending"]')?.textContent).toContain('Memória');
    fireEvent.click(within(dialog).getByRole('button', { name: /Processzor/ }));
    expect(dialog.querySelector('th[aria-sort="descending"]')?.textContent).toContain('Processzor');
  });

  it('cancels confirmation with Escape before closing the panel, restoring row focus', async () => {
    const project = setup();
    project.render(<MachineIndicator />);
    const dialog = await open();
    const button = within(dialog).getAllByRole('button', { name: /^Leállítás:/ })[0]!;
    fireEvent.click(button);
    const cancel = within(dialog).getByRole('button', { name: 'Mégse' });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(cancel, { key: 'Escape' });
    expect(screen.queryByText(/Leállítod:/)).toBeNull();
    expect(document.activeElement?.getAttribute('aria-label')).toBe(button.getAttribute('aria-label'));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement?.getAttribute('aria-haspopup')).toBe('dialog');
  });

  it('stops a session through the existing endpoint and updates the closed count', async () => {
    const project = setup();
    const row = project.sample.sessions.at(-1)!;
    const count = project.sample.closedSessions;
    const show = vi.fn();
    project.render(
      <ToastContext.Provider value={{ show }}>
        <MachineIndicator />
      </ToastContext.Provider>,
    );
    const dialog = await open();
    fireEvent.click(within(dialog).getAllByRole('button', { name: /^Leállítás:/ })[0]!);
    expect(project.requests.some((row) => row.path.endsWith('/stop'))).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Leállítás' }));
    await waitFor(() => expect(dialog.querySelector(`[data-session-id="${row.sessionId}"]`)).toBeNull());
    expect(
      project.requests.some(
        (request) =>
          request.method === 'POST' &&
          request.path === `/api/projects/${row.projectKey}/sessions/${row.sessionId}/stop`,
      ),
    ).toBe(true);
    expect(await screen.findByText(new RegExp(`Lezárva: ${count + 1} munkamenet`))).toBeTruthy();
    expect(show).toHaveBeenCalledWith('A munkamenet leállt.', 'ok');
  });

  it('stops all orphans in a single identity-checked request, treating gone as success', async () => {
    const project = setup();
    const show = vi.fn();
    project.sample.orphans = [1, 2, 3].map((pid) => ({
      pid,
      startedAt: project.sample.sampledAt!,
      name: `vitest-${pid}`,
      command: 'vitest run',
      cpuPercent: 5,
      memoryBytes: 1024 ** 3,
      processCount: 2,
      origin: null,
    }));
    project.backend.orphanStopOutcomes[2] = 'gone';
    project.render(
      <ToastContext.Provider value={{ show }}>
        <MachineIndicator />
      </ToastContext.Provider>,
    );
    const dialog = await open();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mind leállítása' }));
    expect(within(dialog).getByText('Mind a 3 leáll?')).toBeTruthy();
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Mind leállítása' }).at(-1)!);
    expect(await within(dialog).findByText('3 folyamat leállt.')).toBeTruthy();
    const requests = project.requests.filter(
      (row) => row.method === 'POST' && row.path === '/api/machine/orphans/stop',
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toEqual({
      orphans: [1, 2, 3].map((pid) => ({ pid, startedAt: project.backend.machine!.sampledAt })),
    });
    expect(show).toHaveBeenCalledWith('3 folyamat leállt.', 'ok');
  });

  it.each(['gone', 'refused', 'failed'] as const)('shows individual orphan outcome %s', async (outcome) => {
    const project = setup();
    const show = vi.fn();
    project.sample.orphans = [
      {
        pid: 123,
        startedAt: project.sample.sampledAt!,
        name: 'vitest',
        command: 'vitest run',
        cpuPercent: null,
        memoryBytes: null,
        processCount: 1,
        origin: null,
      },
    ];
    project.backend.orphanStopOutcomes[123] = outcome;
    project.render(
      <ToastContext.Provider value={{ show }}>
        <MachineIndicator />
      </ToastContext.Provider>,
    );
    const dialog = await open();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Leállítás: vitest, Gazdátlan' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Leállítás' }));
    await waitFor(() => expect(show).toHaveBeenCalled());
    if (outcome === 'gone') {
      expect(show).toHaveBeenCalledWith('A folyamat közben már leállt.', 'ok');
      await waitFor(() => expect(within(dialog).queryByText('vitest')).toBeNull());
    }
    if (outcome === 'refused')
      expect(within(dialog).queryByRole('button', { name: 'Leállítás: vitest, Gazdátlan' })).toBeNull();
    if (outcome === 'failed')
      expect(within(dialog).getByRole('button', { name: 'Leállítás: vitest, Gazdátlan' })).toBeTruthy();
  });

  it('shows delayed neutral measurements, unavailable lists and the empty state', async () => {
    const project = setup();
    project.sample.sampledAt = null;
    project.sample.sessions = [];
    project.sample.orphans = null;
    project.sample.others = null;
    project.sample.rest = null;
    project.sample.closedSessions = 0;
    project.render(<MachineIndicator />);
    const dialog = await open();
    expect(within(dialog).getByText(/A mérés késik/)).toBeTruthy();
    expect(within(dialog).getByText('Most nem fut AI-munkamenet.')).toBeTruthy();
    expect(within(dialog).getAllByText('A folyamatlista most nem érhető el.')).toHaveLength(2);
    expect(within(dialog).queryByText(/Lezárva:/)).toBeNull();
    expect(
      screen.getByRole('button', { name: /Gép: processzor n. a./ }).getAttribute('data-level'),
    ).toBeNull();
  });

  it('offers retry after a failed GET and uses a neutral indicator', async () => {
    const project = setup();
    const fetch = createMockFetch(project.backend, project.requests);
    let fails = true;
    setFetchImplementation((path, init) =>
      path.startsWith('/api/machine') && fails
        ? Promise.resolve(new Response('{}', { status: 500 }))
        : fetch(path, init),
    );
    project.render(<MachineIndicator />);
    const dialog = await open();
    expect(await within(dialog).findByText('Nem sikerült betölteni a gép adatait.')).toBeTruthy();
    fails = false;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Újra' }));
    expect(await within(dialog).findByText('Gazdátlan folyamatok')).toBeTruthy();
  });

  it('uses the native full-screen Dialog and sorting control on phones', async () => {
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
      matches: /max-width/.test(query),
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => true,
    }));
    const project = setup();
    project.render(<MachineIndicator phone />);
    const dialog = await open();
    expect(dialog.tagName).toBe('DIALOG');
    expect(within(dialog).getByRole('group', { name: 'Rendezés' })).toBeTruthy();
    fireEvent.click(within(dialog).getAllByRole('button', { name: /^Leállítás:/ })[0]!);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Bezárás' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

it('formats binary memory and compact duration', () => {
  expect(formatMemory(16 * 1024 ** 3)).toBe('16 GB');
  expect(formatMemory(1.4 * 1024 ** 3)).toBe('1,4 GB');
  expect(formatMemory(640 * 1024 ** 2)).toBe('640 MB');
  expect(formatDuration(12 * 60000)).toBe('12 p');
  expect(formatDuration(192 * 60000)).toBe('3 ó 12 p');
  expect(formatDuration(48 * 3600000)).toBe('2 nap');
});
