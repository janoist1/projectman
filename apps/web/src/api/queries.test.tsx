import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import type { ConfigView, StartConditionMarksResponse } from '@projectman/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setFetchImplementation } from './client';
import { mockProject } from '../test/mockProject';
import { browserHash, browserSubscription, fakeBrowser, resetFakeBrowser } from '../test/pushBrowser';
import {
  useBoard,
  useCancelTask,
  useConfig,
  useLogout,
  useMemberProfile,
  usePatchConfig,
  useReopenTask,
  useStartConditionMarks,
  useTaskDetail,
  useUpdateTask,
} from './queries';
import { applyServerEvent } from './cache';
import { queryKeys } from './queryKeys';

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

function MarksProbe() {
  const marks = useStartConditionMarks('AC', true);
  return <output>{marks.data?.marks.map((mark) => mark.taskKey).join(',') ?? 'loading'}</output>;
}

describe('out-of-order server reads', () => {
  it('replaces an initial marks read when the tracker publishes before its response arrives', async () => {
    const project = mockProject();
    project.backend.config.team.startCondition = {
      priority: 'any',
      hold: [],
      combine: 'any',
      graceMinutes: 5,
    };
    const held = project.holdNextResponse('GET', '/api/projects/AC/start-condition-marks');
    const { client } = project.render(<MarksProbe />);
    await held.captured;
    const earlier = client
      .getQueryCache()
      .find({ queryKey: queryKeys.startConditionMarks('AC') })!
      .promise?.catch(() => undefined);
    try {
      const task = project.backend.findTask('AC-21')!;
      task.stageId = 'ready';
      task.priority = 'high';
      for (const other of project.backend.tasks) if (other !== task) other.priority = null;
      project.backend.emit({ type: 'task_upserted', projectKey: 'AC', task });
      act(() => applyServerEvent(client, { type: 'start_condition_marks_changed', projectKey: 'AC' }));
      await screen.findByText('AC-21');
    } finally {
      await act(async () => {
        await held.release();
        await earlier;
      });
    }
    expect(
      client
        .getQueryData<StartConditionMarksResponse>(queryKeys.startConditionMarks('AC'))
        ?.marks.map((mark) => mark.taskKey),
    ).toEqual(['AC-21']);
    expect(screen.getByText('AC-21')).toBeTruthy();
    expect(
      project.requests.filter((request) => request.path.endsWith('/start-condition-marks')),
    ).toHaveLength(2);
  });

  it('reads the final state once for overlapping invalidations in an event burst', async () => {
    const project = mockProject();
    function ProfileProbe() {
      const profile = useMemberProfile('AC', 'fe-1');
      return <output>{profile.data?.member.activity ?? 'idle'}</output>;
    }
    const { client } = project.render(<ProfileProbe />);
    await waitFor(() => expect(client.getQueryData(queryKeys.profile('AC', 'fe-1'))).toBeDefined());
    const path = '/api/projects/AC/members/fe-1/profile';
    const held = project.holdNextResponse('GET', path);
    const earlier = client.refetchQueries({ queryKey: queryKeys.profile('AC', 'fe-1') });
    await held.captured;
    try {
      act(() => {
        applyServerEvent(client, { type: 'config_changed', projectKey: 'AC', version: 'changed' });
        project.backend.findMember('fe-1')!.activity = 'Latest activity';
        applyServerEvent(client, {
          type: 'session_upserted',
          projectKey: 'AC',
          session: project.backend.findSession('ses_ac21_fe1')!,
        });
      });
      await screen.findByText('Latest activity');
    } finally {
      await act(async () => {
        await held.release();
        await earlier;
      });
    }
    expect(screen.getByText('Latest activity')).toBeTruthy();
    expect(project.requests.filter((request) => request.path === path)).toHaveLength(3);
  });

  it('keeps a saved configuration when an older GET arrives after the PATCH response', async () => {
    const project = mockProject();
    function ConfigProbe() {
      const config = useConfig('AC');
      const save = usePatchConfig('AC');
      return (
        <>
          <output>{config.data?.config.project.name}</output>
          <button
            type="button"
            onClick={() =>
              save.mutate({ baseVersion: project.backend.configVersion, project: { name: 'Saved project' } })
            }
          >
            save
          </button>
        </>
      );
    }
    const { client } = project.render(<ConfigProbe />);
    await screen.findByText('Acme webshop');
    const held = project.holdNextResponse('GET', '/api/projects/AC/config');
    const earlier = client.refetchQueries({ queryKey: queryKeys.config('AC') });
    await held.captured;
    try {
      fireEvent.click(screen.getByRole('button', { name: 'save' }));
      await screen.findByText('Saved project');
    } finally {
      await act(async () => {
        await held.release();
        await earlier;
      });
    }
    expect(client.getQueryData<ConfigView>(queryKeys.config('AC'))?.config.project.name).toBe(
      'Saved project',
    );
    expect(screen.getByText('Saved project')).toBeTruthy();
    expect(project.requests.filter((request) => request.method === 'PATCH')).toHaveLength(1);
    expect(
      project.requests.filter((request) => request.path.endsWith('/config') && request.method === 'GET'),
    ).toHaveLength(2);
  });
});

function LifecycleProbe() {
  const board = useBoard('AC');
  const detail = useTaskDetail('AC', 'AC-21');
  const cancel = useCancelTask('AC');
  const reopen = useReopenTask('AC');
  return (
    <>
      <output>{board.data?.tasks.find((task) => task.key === 'AC-21')?.status}</output>
      <button
        type="button"
        disabled={!detail.data}
        onClick={() => cancel.mutate({ taskKey: 'AC-21', body: {} })}
      >
        cancel
      </button>
      <button type="button" disabled={!detail.data} onClick={() => reopen.mutate('AC-21')}>
        reopen
      </button>
    </>
  );
}

describe('task lifecycle', () => {
  it.each(['cancel', 'reopen'])(
    '%s reads back only the task detail, not the project (PM-1109)',
    async (action) => {
      const project = mockProject();
      project.render(<LifecycleProbe />);
      const cancel = await screen.findByRole('button', { name: 'cancel' });
      await waitFor(() => expect((cancel as HTMLButtonElement).disabled).toBe(false));
      if (action === 'reopen') {
        fireEvent.click(cancel);
        await screen.findByText('cancelled');
        await waitFor(() =>
          expect(project.requests.filter((r) => r.method === 'GET').length).toBeGreaterThan(0),
        );
      }
      project.requests.length = 0;
      fireEvent.click(screen.getByRole('button', { name: action }));
      await waitFor(() => expect(project.requests.filter((r) => r.method === 'POST')).toHaveLength(1));
      await waitFor(() =>
        expect(project.requests.filter((r) => r.method === 'GET').length).toBeLessThanOrEqual(1),
      );
      expect(project.requests.filter((r) => r.method === 'GET').map((r) => r.path)).not.toContainEqual(
        expect.stringMatching(/\/(board|project-manager)$/),
      );
    },
  );
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
