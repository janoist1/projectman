import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setFetchImplementation } from '../../../api/client';
import { MockBackend } from '../../../mocks/backend';
import { ToastContext } from '../../../components/toastContext';
import { t } from '../../../i18n/t';
import { createMockFetch, mockProject } from '../../../test/mockProject';
import { ProjectEnginesCard } from './ProjectEnginesCard';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

const SEEN = '2026-10-01T10:00:00.000Z';

/** The project's machines card: the project AC, a cloud installation, the caller the project owner. */
function setup(prepare: (backend: MockBackend) => void) {
  const backend = new MockBackend();
  backend.engineMode = 'cloud';
  prepare(backend);
  const project = mockProject(backend);
  const toasts: string[] = [];
  const onNewMachine = vi.fn();
  const view = project.render(
    <ToastContext.Provider value={{ show: (message) => void toasts.push(message) }}>
      <ProjectEnginesCard onNewMachine={onNewMachine} />
    </ToastContext.Provider>,
  );
  return { ...project, ...view, toasts, onNewMachine };
}

/** Binds the named machines to AC, the first one as the base. */
function bind(backend: MockBackend, ...engines: Array<{ id: string }>) {
  backend.projectEngineBindings.set(
    'AC',
    engines.map((engine, index) => ({ engineId: engine.id, isDefault: index === 0 })),
  );
  for (const engine of engines) backend.engineHolds.add(`AC/${engine.id}`);
}

async function openMenu(name: string) {
  const row = (await screen.findByText(name)).closest('li')!;
  fireEvent.click(within(row).getByRole('button', { name: t('engines.rowActions', { name }) }));
}

describe('project engines card', () => {
  it('shows the machine with the base chip and its state', async () => {
    setup((backend) => {
      const studio = backend.addEngine({ name: 'Mac Studio', online: true, lastSeenAt: SEEN });
      bind(backend, studio);
    });
    const row = (await screen.findByText('Mac Studio')).closest('li')!;
    expect(within(row).getByText(t('projectEngines.baseChip'))).toBeTruthy();
    expect(within(row).getByText(t('engines.online'))).toBeTruthy();
    expect(screen.getByRole('heading', { name: t('projectEngines.title') })).toBeTruthy();
  });

  it('names the machines card in the plural when there are several', async () => {
    setup((backend) => {
      const studio = backend.addEngine({ name: 'Mac Studio', lastSeenAt: SEEN });
      const linux = backend.addEngine({ name: 'Linux box', lastSeenAt: SEEN });
      bind(backend, studio, linux);
    });
    expect(await screen.findByRole('heading', { name: t('projectEngines.titleMany') })).toBeTruthy();
  });

  it('shows the project command when the machine does not run the project yet', async () => {
    setup((backend) => {
      const studio = backend.addEngine({ name: 'Mac Studio', online: true, lastSeenAt: SEEN });
      bind(backend, studio);
      backend.engineHolds.clear();
    });
    const command = await screen.findByLabelText(t('projectEngines.commandAria'));
    expect(command.textContent).toContain('project set AC');
    expect(command.textContent).toContain(t('projectEngines.folderPlaceholder'));
    expect(screen.getByText(t('projectEngines.folderHint'))).toBeTruthy();
  });

  it('binds another own machine and says so', async () => {
    const view = setup((backend) => {
      const studio = backend.addEngine({ name: 'Mac Studio', lastSeenAt: SEEN });
      backend.addEngine({ name: 'Linux box', lastSeenAt: SEEN });
      bind(backend, studio);
    });
    fireEvent.click(await screen.findByRole('button', { name: t('projectEngines.bindMore') }));
    const dialog = await screen.findByRole('dialog', { name: t('projectEngines.bindTitle', { key: 'AC' }) });
    expect(within(dialog).getByRole('group', { name: t('projectEngines.bindLegend') })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: t('projectEngines.bindConfirm') }));
    await waitFor(() => expect(view.toasts).toContain(t('projectEngines.bound', { name: 'Linux box' })));
    const put = view.requests.find((r) => r.method === 'PUT' && r.path.includes('/engines/'));
    expect(put?.body).toEqual({});
    expect(await screen.findByRole('heading', { name: t('projectEngines.titleMany') })).toBeTruthy();
  });

  it('offers no binding when every own machine is bound already', async () => {
    setup((backend) => {
      const studio = backend.addEngine({ name: 'Mac Studio', lastSeenAt: SEEN });
      bind(backend, studio);
    });
    await screen.findByText('Mac Studio');
    expect(screen.queryByRole('button', { name: t('projectEngines.bindMore') })).toBeNull();
  });

  it('makes another machine the project base', async () => {
    const view = setup((backend) => {
      const studio = backend.addEngine({ name: 'Mac Studio', lastSeenAt: SEEN });
      const linux = backend.addEngine({ name: 'Linux box', lastSeenAt: SEEN });
      bind(backend, studio, linux);
    });
    await openMenu('Linux box');
    fireEvent.click(await screen.findByRole('button', { name: t('projectEngines.makeBase') }));
    await waitFor(() => expect(view.toasts).toContain(t('projectEngines.baseSet', { name: 'Linux box' })));
    const put = view.requests.find((r) => r.method === 'PUT' && r.path.includes('/engines/'));
    expect(put?.body).toEqual({ default: true });
  });

  it('unbinds a machine only after the confirmation', async () => {
    const view = setup((backend) => {
      const studio = backend.addEngine({ name: 'Mac Studio', lastSeenAt: SEEN });
      const linux = backend.addEngine({ name: 'Linux box', lastSeenAt: SEEN });
      bind(backend, studio, linux);
    });
    await openMenu('Linux box');
    fireEvent.click(await screen.findByRole('button', { name: t('projectEngines.unbind') }));
    const dialog = await screen.findByRole('dialog', {
      name: t('projectEngines.unbindTitle', { name: 'Linux box' }),
    });
    expect(view.requests.some((r) => r.method === 'DELETE')).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: t('projectEngines.unbindConfirm') }));
    await waitFor(() => expect(view.toasts).toContain(t('projectEngines.unbound', { name: 'Linux box' })));
    expect(view.requests.some((r) => r.method === 'DELETE' && r.path.includes('/engines/'))).toBe(true);
    await waitFor(() => expect(screen.queryByText('Linux box')).toBeNull());
  });

  it('blocks the unbinding of the base while other machines remain, and says why', async () => {
    const view = setup((backend) => {
      const studio = backend.addEngine({ name: 'Mac Studio', lastSeenAt: SEEN });
      const linux = backend.addEngine({ name: 'Linux box', lastSeenAt: SEEN });
      bind(backend, studio, linux);
    });
    await openMenu('Mac Studio');
    const unbind = await screen.findByRole('button', { name: t('projectEngines.unbind') });
    expect(unbind.getAttribute('aria-disabled')).toBe('true');
    const reason = document.getElementById(unbind.getAttribute('aria-describedby')!);
    expect(reason?.textContent).toBe(t('projectEngines.unbindBlocked'));
    fireEvent.click(unbind);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(view.requests.some((r) => r.method === 'DELETE')).toBe(false);
  });

  it('shows the refusal in the dialog and keeps it open when the machine still works', async () => {
    const view = setup((backend) => {
      const studio = backend.addEngine({ name: 'Mac Studio', lastSeenAt: SEEN });
      const linux = backend.addEngine({ name: 'Linux box', lastSeenAt: SEEN });
      bind(backend, studio, linux);
    });
    const answer = createMockFetch(view.backend, view.requests);
    setFetchImplementation(async (path, init) =>
      init?.method === 'DELETE'
        ? new Response(JSON.stringify({ error: { code: 'engine_in_use', message: 'in use' } }), {
            status: 409,
            headers: { 'content-type': 'application/json' },
          })
        : answer(path, init),
    );
    await openMenu('Linux box');
    fireEvent.click(await screen.findByRole('button', { name: t('projectEngines.unbind') }));
    const dialog = await screen.findByRole('dialog', {
      name: t('projectEngines.unbindTitle', { name: 'Linux box' }),
    });
    fireEvent.click(within(dialog).getByRole('button', { name: t('projectEngines.unbindConfirm') }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(t('errors.codes.engine_in_use'));
  });

  it('warns when no machine is bound and offers the free own one', async () => {
    setup((backend) => {
      backend.addEngine({ name: 'Mac Studio', lastSeenAt: SEEN, isDefault: false });
    });
    expect(await screen.findByText(t('projectEngines.emptyWarn'))).toBeTruthy();
    expect(screen.getByRole('button', { name: t('projectEngines.bindFirst') })).toBeTruthy();
  });

  it('offers a new machine when there is none to bind', async () => {
    const view = setup(() => {});
    await screen.findByText(t('projectEngines.emptyWarn'));
    fireEvent.click(screen.getByRole('button', { name: t('engines.newEngine') }));
    expect(view.onNewMachine).toHaveBeenCalledTimes(1);
  });

  it('shows a load failure with a retry', async () => {
    const backend = new MockBackend();
    backend.engineMode = 'cloud';
    const project = mockProject(backend);
    const answer = createMockFetch(backend, project.requests);
    setFetchImplementation(async (path, init) =>
      path === '/api/projects/AC/engines' ? new Response('{}', { status: 500 }) : answer(path, init),
    );
    project.render(<ProjectEnginesCard onNewMachine={() => {}} />);
    expect((await screen.findByRole('alert')).textContent).toBe(t('projectEngines.loadFailed'));
    expect(screen.getByRole('button', { name: t('app.retry') })).toBeTruthy();
  });
});
