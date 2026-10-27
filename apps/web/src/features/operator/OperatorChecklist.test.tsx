import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes, useLocation, useNavigate } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checklistProgress } from '@projectman/shared';
import type { ChecklistItem } from '@projectman/shared';
import { applyServerEvent } from '../../api/cache';
import { setFetchImplementation } from '../../api/client';
import { MeContext } from '../../app/contexts';
import { ProjectLayout } from '../../app/ProjectLayout';
import { ToastProvider } from '../../components/Toast';
import { t } from '../../i18n/t';
import { readStorage } from '../../lib/hooks';
import { mockProject } from '../../test/mockProject';
import { OperatorChecklist } from './OperatorChecklist';

const item = (id: string, overrides: Partial<ChecklistItem> = {}): ChecklistItem => ({
  id,
  title: id,
  hint: 'Helpful detail',
  source: 'base',
  templateId: null,
  condition: null,
  conditionHolds: null,
  state: 'open',
  reason: null,
  reopened: null,
  updatedAt: '2026-10-23T09:00:00.000Z',
  updatedBy: 'operator',
  ...overrides,
});

function projectWith(items = [item('first'), item('second', { state: 'done' })]) {
  const project = mockProject();
  project.backend.checklist = { baseTemplateId: null, items, progress: checklistProgress(items) };
  return project;
}

const head = () => screen.getByRole('button', { name: /^Indulás / });
const indicator = () => screen.queryByRole('button', { name: /^Indulási lista:/ });
const openDetail = (title = 'first') =>
  fireEvent.click(within(screen.getByRole('list')).getByRole('button', { name: new RegExp(title) }));
const posts = (project: ReturnType<typeof mockProject>) =>
  project.requests.filter((request) => request.method === 'POST' && request.path.endsWith('/state'));

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  setFetchImplementation((input, init) => globalThis.fetch(input, init));
});

describe('operator checklist', () => {
  it('renders progress, states, reasons, conditions and reopening context above item details', async () => {
    const project = projectWith([
      item('first', { condition: 'task_exists', reopened: 'condition' }),
      item('second', { state: 'done' }),
      item('third', { state: 'not_needed', reason: 'No client' }),
    ]);
    project.render(<OperatorChecklist appliedRequest={{ current: null }} />);
    expect(await screen.findByText('2/3')).not.toBeNull();
    expect(screen.getByRole('img', { name: t('operator.checklist.state.open') })).not.toBeNull();
    expect(screen.getByRole('img', { name: t('operator.checklist.state.done') })).not.toBeNull();
    expect(screen.getByRole('img', { name: t('operator.checklist.state.not_needed') })).not.toBeNull();
    expect(screen.getByText(t('operator.checklist.reason', { reason: 'No client' }))).not.toBeNull();
    expect(
      screen.getByText(
        t('operator.checklist.condition.holds', { condition: t('operator.checklist.condition.task_exists') }),
      ),
    ).not.toBeNull();
    expect(screen.getByText(t('operator.checklist.reopened.condition'))).not.toBeNull();
    openDetail();
    expect(screen.getByText('Helpful detail')).not.toBeNull();
    openDetail('second');
    expect(screen.getAllByText('Helpful detail')).toHaveLength(1);
  });

  it('remembers collapsing the list across remounts', async () => {
    const project = projectWith();
    const view = project.render(<OperatorChecklist appliedRequest={{ current: null }} />);
    await within(await screen.findByRole('button', { name: /^Indulás / })).findByText('1/2');
    fireEvent.click(head());
    expect(screen.queryByRole('list')).toBeNull();
    expect(readStorage('operatorChecklistOpen:AC')).toBe('false');
    view.unmount();
    project.render(<OperatorChecklist appliedRequest={{ current: null }} />);
    await within(await screen.findByRole('button', { name: /^Indulás / })).findByText('1/2');
    expect(head().getAttribute('aria-expanded')).toBe('false');
  });

  it('submits a trimmed not-needed reason, updates progress and returns focus to the row', async () => {
    const project = projectWith();
    project.render(<OperatorChecklist appliedRequest={{ current: null }} />);
    await within(await screen.findByRole('button', { name: /^Indulás / })).findByText('1/2');
    openDetail();
    fireEvent.click(screen.getByRole('button', { name: t('operator.checklist.notNeeded.open') }));
    const input = screen.getByRole('textbox');
    expect(document.activeElement).toBe(input);
    expect(
      (screen.getByRole('button', { name: t('operator.checklist.notNeeded.save') }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.change(input, { target: { value: '  No client  ' } });
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    await screen.findByText('2/2');
    expect(posts(project)[0]?.body).toEqual({ state: 'not_needed', reason: 'No client' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /first/ }));
  });

  it('reopens a settled item through the state endpoint', async () => {
    const project = projectWith([item('first', { state: 'not_needed', reason: 'No client' })]);
    project.render(<OperatorChecklist appliedRequest={{ current: null }} />);
    await screen.findByText('1/1');
    fireEvent.click(head());
    openDetail();
    fireEvent.click(screen.getByRole('button', { name: t('operator.checklist.reopen') }));
    await screen.findByText('0/1');
    expect(posts(project)[0]?.body).toEqual({ state: 'open' });
    expect(screen.getByText(t('operator.checklist.reopened.ownerSelf'))).not.toBeNull();
  });

  it('keeps the entered reason after a save failure and permits retry', async () => {
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
    const project = projectWith();
    const handle = project.backend.handle.bind(project.backend);
    let fail = true;
    vi.spyOn(project.backend, 'handle').mockImplementation((method, path, body, query) =>
      method === 'POST' && path.endsWith('/state') && fail
        ? { status: 500, body: { error: { code: 'internal_error', message: 'Failed' } } }
        : handle(method, path, body, query),
    );
    project.render(<OperatorChecklist appliedRequest={{ current: null }} />);
    await within(await screen.findByRole('button', { name: /^Indulás / })).findByText('1/2');
    openDetail();
    fireEvent.click(screen.getByRole('button', { name: t('operator.checklist.notNeeded.open') }));
    expect(scroll).toHaveBeenCalledWith({ block: 'nearest' });
    scroll.mockClear();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'No client' } });
    fireEvent.click(screen.getByRole('button', { name: t('operator.checklist.notNeeded.save') }));
    await screen.findByRole('alert');
    expect(scroll).toHaveBeenCalledWith({ block: 'nearest' });
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('No client');
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: t('operator.checklist.notNeeded.save') }));
    await screen.findByText('2/2');
  });

  it('cancels the reason form with Escape without closing the operator panel', async () => {
    const project = projectWith();
    project.render(<OperatorChecklist appliedRequest={{ current: null }} />);
    await within(await screen.findByRole('button', { name: /^Indulás / })).findByText('1/2');
    openDetail();
    fireEvent.click(screen.getByRole('button', { name: t('operator.checklist.notNeeded.open') }));
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: t('operator.checklist.notNeeded.open') }),
    );
    expect(posts(project)).toHaveLength(0);
  });

  it('shows the admin the list and owner reopening context without edit controls', async () => {
    const project = projectWith([item('first', { reopened: 'owner', condition: 'feedback_surface' })]);
    const owner = project.backend.config.team.members.find((member) => member.handle === 'owner')!;
    if (owner.kind === 'human') owner.access = 'admin';
    project.context.me.projects[0]!.access = 'admin';
    project.render(<OperatorChecklist appliedRequest={{ current: null }} />);
    await screen.findByText('0/1');
    openDetail();
    expect(screen.getByText(t('operator.checklist.reopened.owner'))).not.toBeNull();
    expect(
      screen.getByText(
        t('operator.checklist.condition.unmet', {
          condition: t('operator.checklist.condition.feedback_surface'),
        }),
      ),
    ).not.toBeNull();
    expect(screen.getByText(t('operator.checklist.ownerOnly'))).not.toBeNull();
    expect(screen.queryByRole('button', { name: t('operator.checklist.notNeeded.open') })).toBeNull();
  });
});

function CreationProbe() {
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <>
      <button onClick={() => void navigate('/p/AC', { state: { operatorChecklist: true } })}>created</button>
      <output data-testid="router-state">{JSON.stringify(location.state)}</output>
    </>
  );
}

function layout(project: ReturnType<typeof mockProject>) {
  return project.render(
    <ToastProvider>
      <MeContext.Provider value={project.context.me}>
        <Routes>
          <Route path="/p/:projectKey" element={<ProjectLayout />}>
            <Route index element={<CreationProbe />} />
          </Route>
        </Routes>
      </MeContext.Provider>
    </ToastProvider>,
    '/p/AC',
  );
}

describe('checklist in the project layout', () => {
  it('shows checklist loading independently of the conversation and no header indicator', async () => {
    const project = projectWith();
    const { createMockFetch } = await import('../../test/mockProject');
    const fetch = createMockFetch(project.backend, project.requests);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    setFetchImplementation(async (path, init) => {
      if (path.endsWith('/checklist')) await pending;
      return fetch(path, init);
    });
    layout(project);
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^${t('operator.panel.label')}`) }));
    expect(screen.getAllByRole('status', { name: t('app.loading') }).length).toBeGreaterThan(0);
    expect(indicator()).toBeNull();
    release();
    await within(await screen.findByRole('button', { name: /^Indulás / })).findByText('1/2');
  });

  it('offers retry when the checklist fails while keeping the conversation available', async () => {
    const project = projectWith();
    const handle = project.backend.handle.bind(project.backend);
    let fail = true;
    vi.spyOn(project.backend, 'handle').mockImplementation((method, path, body, query) =>
      path.endsWith('/checklist') && fail
        ? { status: 403, body: { error: { code: 'insufficient_access', message: 'Failed' } } }
        : handle(method, path, body, query),
    );
    layout(project);
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^${t('operator.panel.label')}`) }));
    await screen.findByText(t('operator.checklist.loadFailed'));
    expect(indicator()).toBeNull();
    expect(screen.getByRole('textbox', { name: t('operator.composer.label') })).not.toBeNull();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: t('app.retry') }));
    await within(await screen.findByRole('button', { name: /^Indulás / })).findByText('1/2');
  });

  it('opens the collapsed checklist from the header, focuses it and keeps an open panel open', async () => {
    const project = projectWith();
    window.localStorage.setItem('pm:operatorChecklistOpen:AC', 'false');
    layout(project);
    await waitFor(() => expect(indicator()).not.toBeNull());
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(indicator()!);
    await waitFor(() => expect(document.activeElement).toBe(head()));
    expect(screen.getByRole('list')).not.toBeNull();
    fireEvent.click(head());
    fireEvent.click(indicator()!);
    await waitFor(() => expect(document.activeElement).toBe(head()));
    expect(screen.getByRole('dialog')).not.toBeNull();
    expect(head().getAttribute('aria-expanded')).toBe('true');
  });

  it('does not replay a handled checklist request when returning from another panel view', async () => {
    const project = projectWith();
    layout(project);
    await waitFor(() => expect(indicator()).not.toBeNull());
    fireEvent.click(indicator()!);
    await waitFor(() => expect(document.activeElement).toBe(head()));
    fireEvent.click(head());
    const knowledge = screen.getByRole('button', { name: t('knowledge.title') });
    fireEvent.click(knowledge);
    expect(screen.queryByRole('button', { name: /^Indulás / })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: t('knowledge.back') }));
    await waitFor(() => expect(document.activeElement).toBe(knowledge));
    expect(head().getAttribute('aria-expanded')).toBe('false');
    expect(readStorage('operatorChecklistOpen:AC')).toBe('false');
    fireEvent.click(indicator()!);
    await waitFor(() => expect(document.activeElement).toBe(head()));
    expect(head().getAttribute('aria-expanded')).toBe('true');
  });

  it('hides the completed indicator and defaults the panel checklist to collapsed', async () => {
    const project = projectWith([item('first', { state: 'done' })]);
    layout(project);
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^${t('operator.panel.label')}`) }));
    await screen.findByText('1/1');
    expect(indicator()).toBeNull();
    expect(head().getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(head());
    expect(screen.getByRole('img', { name: t('operator.checklist.state.done') })).not.toBeNull();
  });

  it.each([null, []])('renders no checklist for missing or empty data: %s', async (items) => {
    const project = projectWith(items ?? []);
    if (items === null) project.backend.checklist = null;
    layout(project);
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^${t('operator.panel.label')}`) }));
    await waitFor(() =>
      expect(project.requests.some((request) => request.path.endsWith('/checklist'))).toBe(true),
    );
    expect(indicator()).toBeNull();
    expect(screen.queryByRole('button', { name: /^Indulás/ })).toBeNull();
  });

  it('does not query or show a checklist below admin access', async () => {
    const project = projectWith();
    project.context.me.projects[0]!.access = 'developer';
    layout(project);
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^${t('operator.panel.label')}`) }));
    await screen.findByRole('dialog');
    expect(indicator()).toBeNull();
    expect(project.requests.filter((request) => request.path.endsWith('/checklist'))).toHaveLength(0);
  });

  it('refreshes the panel and header from the same cache on a checklist event', async () => {
    const project = projectWith();
    const view = layout(project);
    await waitFor(() => expect(indicator()).not.toBeNull());
    fireEvent.click(indicator()!);
    await within(await screen.findByRole('button', { name: /^Indulás / })).findByText('1/2');
    const first = project.backend.checklist!.items[0]!;
    first.state = 'done';
    first.updatedAt = '2026-10-23T10:00:00.000Z';
    act(() => applyServerEvent(view.client, { type: 'project_checklist_changed', projectKey: 'AC' }));
    await screen.findByText('2/2');
    expect(indicator()).toBeNull();
    first.state = 'open';
    first.reopened = 'condition';
    first.updatedAt = '2026-10-23T11:00:00.000Z';
    act(() => applyServerEvent(view.client, { type: 'project_checklist_changed', projectKey: 'AC' }));
    await waitFor(() =>
      expect(indicator()?.getAttribute('aria-label')).toBe(
        t('operator.checklist.indicator.label', { total: 2, settled: 1 }),
      ),
    );
    expect(within(head()).getByText('1/2')).not.toBeNull();
  });

  it('opens after creation, shows the introduction, clears router state and leaves focus in the composer', async () => {
    const project = projectWith();
    layout(project);
    fireEvent.click(screen.getByRole('button', { name: 'created' }));
    await screen.findByText(t('operator.checklist.intro'));
    expect(head().getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('router-state').textContent).toBe('{}');
    const panel = screen.getByRole('dialog');
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(panel).getByRole('textbox', { name: t('operator.composer.label') }),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: t('operator.panel.close') }));
    fireEvent.click(indicator()!);
    expect(screen.queryByText(t('operator.checklist.intro'))).toBeNull();
  });
});
