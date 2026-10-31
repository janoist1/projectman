import { StrictMode } from 'react';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '@projectman/shared';
import type { InboxItem } from '@projectman/shared';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { createMockFetch, mockProject } from '../../test/mockProject';
import { OperatorPanel } from './OperatorPanel';

afterEach(() => {
  vi.restoreAllMocks();
  setFetchImplementation((input, init) => globalThis.fetch(input, init));
});

const url = routes.operatorOwnerQuestions('AC');

function question(id: string, payload: Record<string, unknown>, rest: Partial<InboxItem> = {}): InboxItem {
  return {
    id,
    projectKey: 'AC',
    kind: 'question',
    state: 'open',
    source: 'dev',
    title: 'Which approach?',
    body: '',
    taskKey: null,
    sessionId: null,
    assignees: ['owner'],
    options: [{ id: 'answer', label: 'Answer', style: 'primary' }],
    payload: { question: 'Which approach?', ...payload },
    createdAt: new Date().toISOString(),
    resolution: null,
    ...rest,
  };
}

type Project = ReturnType<typeof mockProject>;
function setup(items: InboxItem[] = [], overrides: (project: Project) => object = () => ({})) {
  const project = mockProject();
  project.backend.inbox.length = 0;
  project.backend.inbox.push(...items);
  // Strict mode runs a newly drawn composer's effects again, as the development build does in the browser.
  project.render(
    <StrictMode>
      <OperatorPanel returnFocusTo={{ current: null }} />
    </StrictMode>,
    '/',
    overrides(project),
  );
  return project;
}
const loads = (project: Project) => project.requests.filter((request) => request.path.startsWith(url)).length;
const composer = () => screen.findByRole('textbox', { name: t('operator.composer.label') });
const entry = () => screen.findByRole('button', { name: new RegExp(`^${t('operator.weekly.entry')}`) });
/** The row's numbers as a screen reader reads them, the hidden column name first. */
const counts = (summary: HTMLElement) =>
  Array.from(
    summary.querySelectorAll('span > .visually-hidden'),
    (label) => label.parentElement!.textContent,
  );
const weekRows = () => document.querySelectorAll('details > summary[aria-expanded]').length - 1;

describe('the weekly question measure (PM-1192)', () => {
  it('opens from the panel and loads only then, counts the weeks, and goes back with the draft and the focus', async () => {
    const at = new Date().toISOString();
    const project = setup([
      question('q-1', { ownerTopic: 'cost' }),
      question(
        'q-2',
        {},
        {
          state: 'resolved',
          resolution: { optionId: 'answer', by: 'owner', at, via: 'integrator' } as InboxItem['resolution'],
        },
      ),
      question('todo-1', {
        recipient: 'integrator',
        integratorOpenedAt: at,
        screening: {
          until: at,
          at,
          outcome: 'todo',
          todo: { what: 'Run', where: 'Mac', expected: 'Output' },
        },
      }),
    ]);
    fireEvent.change(await composer(), { target: { value: 'Unfinished message' } });
    expect(loads(project)).toBe(0);

    fireEvent.click(await entry());
    const title = await screen.findByRole('heading', { name: t('operator.weekly.title') });
    await waitFor(() => expect(document.activeElement).toBe(title));
    const current = (await screen.findByText(t('operator.weekly.current'))).closest('summary')!;
    expect(weekRows()).toBe(8);
    expect(counts(current)).toEqual([
      `${t('operator.weekly.total')}: 2`,
      `${t('operator.weekly.viaIntegrator')}: 1`,
    ]);
    expect(screen.queryByRole('textbox', { name: t('operator.composer.label') })).toBeNull();

    fireEvent.click(current);
    expect(current.getAttribute('aria-expanded')).toBe('true');
    const week = within(current.closest('details')!);
    const row = (label: string) => week.getByText(label).closest('div')!.querySelector('dd')!.textContent;
    expect(row(t('operator.weekly.routes.unscreened'))).toBe('2');
    expect(row(t('operator.weekly.routes.decision'))).toBe('0');
    expect(row(t('ownerTopics.builtIn.cost.label'))).toBe('1');
    expect(row(t('ownerTopics.approval'))).toBe('0');
    expect(row(t('operator.weekly.unknownTopic'))).toBe('1');
    expect(week.getByText(t('operator.weekly.integratorTodos')).nextSibling?.textContent).toBe('1');
    expect(loads(project)).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: t('operator.weekly.back') }));
    expect(((await composer()) as HTMLTextAreaElement).value).toBe('Unfinished message');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: /^Heti/ })));
  });

  it.each([
    ['a person who is not an owner', () => ({ isOwner: false })],
    [
      'an integrator key',
      (project: Project) => ({ me: { ...project.context.me, via: 'integrator' as const } }),
    ],
  ])('is not offered to %s, and nothing is loaded', async (_who, overrides) => {
    const project = setup([], overrides);
    await composer();
    expect(screen.queryByRole('button', { name: new RegExp(`^${t('operator.weekly.entry')}`) })).toBeNull();
    expect(loads(project)).toBe(0);
  });

  it('shows eight zero weeks with the first-use note, and a zero week only says so', async () => {
    setup();
    fireEvent.click(await entry());
    expect(await screen.findByText(t('operator.weekly.empty', { weeks: 8 }))).toBeTruthy();
    expect(screen.getByText(t('operator.weekly.firstUse'))).toBeTruthy();
    expect(weekRows()).toBe(8);

    const current = screen.getByText(t('operator.weekly.current')).closest('summary')!;
    fireEvent.click(current);
    const week = within(current.closest('details')!);
    expect(week.getByText(t('operator.weekly.emptyWeek'))).toBeTruthy();
    expect(week.getByText(t('operator.weekly.integratorTodos'))).toBeTruthy();
    expect(week.queryByText(t('operator.weekly.answeredByOwner'))).toBeNull();
    expect(week.queryByText(t('operator.weekly.answerHint'))).toBeNull();
  });

  it('retries a failed first load, keeps the data on a failed refresh and drops it when access is gone', async () => {
    const project = mockProject();
    const answer = createMockFetch(project.backend, project.requests);
    let status = 500;
    setFetchImplementation((path, init) =>
      path.startsWith(url) && status !== 200
        ? Promise.resolve(
            new Response(JSON.stringify({ error: { code: 'internal', message: 'Down' } }), {
              status,
              headers: { 'content-type': 'application/json' },
            }),
          )
        : answer(path, init),
    );
    project.render(<OperatorPanel returnFocusTo={{ current: null }} />);
    fireEvent.click(await entry());
    expect(await screen.findByText(t('operator.weekly.failed'))).toBeTruthy();

    status = 200;
    fireEvent.click(screen.getByRole('button', { name: t('operator.weekly.retry') }));
    await screen.findByText(t('operator.weekly.current'));

    status = 500;
    fireEvent.click(screen.getByRole('button', { name: t('operator.weekly.refresh') }));
    expect(await screen.findByText(t('operator.weekly.stale'))).toBeTruthy();
    expect(weekRows()).toBe(8);

    status = 403;
    fireEvent.click(screen.getByRole('button', { name: t('operator.weekly.retry') }));
    expect(await screen.findByText(t('operator.weekly.denied'))).toBeTruthy();
    expect(screen.queryByText(t('operator.weekly.current'))).toBeNull();
  });
});
