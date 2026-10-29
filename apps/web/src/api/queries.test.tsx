import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setFetchImplementation } from './client';
import { mockProject } from '../test/mockProject';
import { browserHash, browserSubscription, fakeBrowser, resetFakeBrowser } from '../test/pushBrowser';
import { useBoard, useLogout, useTaskDetail, useUpdateTask } from './queries';

vi.mock('../lib/pushBrowser', async () => (await import('../test/pushBrowser')).pushBrowserModule);

function BoardProbe() {
  const board = useBoard('AC');
  return <output>{board.data?.project.name}</output>;
}

function LogoutProbe() {
  const logout = useLogout();
  return (
    <button type="button" onClick={() => logout.mutate()}>
      log out
    </button>
  );
}

beforeEach(() => resetFakeBrowser());
afterEach(() => {
  vi.useRealTimers();
  setFetchImplementation((input, init) => globalThis.fetch(input, init));
});

describe('board usage subscription', () => {
  it('does not refetch the board on a 60-second usage interval', async () => {
    const project = mockProject();
    project.render(<BoardProbe />);
    await screen.findByText('Acme webshop');
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(60_001);
    expect(project.requests.filter((request) => request.path.endsWith('/board'))).toHaveLength(1);
  });
});

function TitleProbe() {
  const board = useBoard('AC');
  const detail = useTaskDetail('AC', 'AC-21');
  const update = useUpdateTask('AC');
  return (
    <>
      <output>{board.data?.tasks.find((task) => task.key === 'AC-21')?.title}</output>
      <button
        type="button"
        disabled={!detail.data}
        onClick={() => update.mutate({ taskKey: 'AC-21', body: { title: 'Fictional new title' } })}
      >
        rename
      </button>
    </>
  );
}

describe('task edit', () => {
  it('sends one change and reads back only the task detail (PM-1109)', async () => {
    const project = mockProject();
    project.render(<TitleProbe />);
    const rename = await screen.findByRole('button', { name: 'rename' });
    await waitFor(() => expect((rename as HTMLButtonElement).disabled).toBe(false));
    project.requests.length = 0;
    fireEvent.click(rename);
    await screen.findByText('Fictional new title');
    await waitFor(() =>
      expect(project.requests.filter((r) => r.method === 'GET').length).toBeLessThanOrEqual(1),
    );
    expect(project.requests.filter((r) => r.method === 'PATCH')).toHaveLength(1);
    expect(project.requests.filter((r) => r.method === 'GET').map((r) => r.path)).not.toContainEqual(
      expect.stringMatching(/\/board$/),
    );
  });
});

describe('logout', () => {
  it('takes this device off the push list before it ends the session', async () => {
    const project = mockProject();
    fakeBrowser.subscription = browserSubscription();
    project.backend.push.addDevice({ endpointHash: browserHash() });
    project.render(<LogoutProbe />);
    fireEvent.click(screen.getByRole('button', { name: 'log out' }));
    await waitFor(() => expect(project.requests.some((r) => r.path === '/api/auth/logout')).toBe(true));
    const paths = project.requests.map((r) => r.path);
    expect(paths.indexOf('/api/me/push/unsubscribe')).toBeGreaterThanOrEqual(0);
    expect(paths.indexOf('/api/me/push/unsubscribe')).toBeLessThan(paths.indexOf('/api/auth/logout'));
    expect(project.backend.push.devices).toHaveLength(0);
  });

  it('logs out as before when the browser has no push subscription', async () => {
    const project = mockProject();
    project.render(<LogoutProbe />);
    fireEvent.click(screen.getByRole('button', { name: 'log out' }));
    await waitFor(() => expect(project.requests.some((r) => r.path === '/api/auth/logout')).toBe(true));
    expect(project.requests.some((r) => r.path.startsWith('/api/me/push'))).toBe(false);
  });
});
