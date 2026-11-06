import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes, useLocation, useNavigate } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import type { MemberContextPreview } from '@projectman/shared';
import { setFetchImplementation } from '../../api/client';
import { setCurrentLanguage } from '../../i18n/language';
import { t } from '../../i18n/t';
import { mockProject } from '../../test/mockProject';
import { server } from '../../test/msw/server';
import { MemberContextPage } from './MemberContextPage';
import { MemberProfilePage } from './MemberProfilePage';

const endpoint = 'http://localhost/api/projects/AC/members/:handle/context';
function Location() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="location">
        {location.pathname}
        {location.search}
      </output>
      <button onClick={() => navigate(-1)}>Back</button>
    </>
  );
}
function page() {
  return (
    <>
      <Routes>
        <Route path="/p/AC/team/:handle/context" element={<MemberContextPage />} />
        <Route path="/p/AC/team/:handle" element={<MemberProfilePage />} />
      </Routes>
      <Location />
    </>
  );
}
function sample(p: ReturnType<typeof mockProject>): MemberContextPreview {
  return p.backend.handle('GET', '/api/projects/AC/members/fe-1/context', undefined)
    .body as MemberContextPreview;
}
async function ready() {
  await screen.findByText(t('memberContext.ready'));
}
function openPart(part: 'intro' | 'guides' | 'tools') {
  fireEvent.click(
    screen.getByRole('button', { name: new RegExp(t(`memberContext.parts.${part}`, { count: 1 })) }),
  );
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  server.resetHandlers();
  vi.unstubAllGlobals();
  setFetchImplementation((input, init) => globalThis.fetch(input, init));
});

describe('member context preview', () => {
  it.each([
    ['owner', 'fe-1', true],
    ['admin', 'fe-1', false],
    ['developer', 'fe-1', false],
    ['viewer', 'fe-1', false],
    ['client', 'fe-1', false],
    ['owner', 'owner', false],
  ] as const)('limits the profile entry for %s and %s', async (access, handle, visible) => {
    const p = mockProject();
    p.render(page(), `/p/AC/team/${handle}`, {
      me: { ...p.context.me, projects: [{ ...p.context.me.projects[0]!, access }] },
    });
    await screen.findByRole('heading', { name: p.backend.findMember(handle)!.displayName });
    expect(!!screen.queryByRole('link', { name: `${t('memberContext.entry')} →` })).toBe(visible);
  });

  it('uses server counts, sections, time and the original prompt without writing data', async () => {
    const p = mockProject();
    const fixture = sample(p);
    fixture.generatedAt = '2026-01-01T12:34:56Z';
    fixture.prompt.chars = 12345;
    server.use(http.get(endpoint, () => HttpResponse.json(fixture)));
    p.render(page(), '/p/AC/team/fe-1/context');
    await ready();
    expect(screen.getByText('12 345')).toBeTruthy();
    expect(document.querySelector('time')?.getAttribute('datetime')).toBe(fixture.generatedAt);
    const summary = screen.getByText(fixture.prompt.sections[0]!.title).closest('summary')!;
    expect(summary.closest('details')?.open).toBe(false);
    fireEvent.click(summary);
    expect(summary.closest('details')?.open).toBe(true);
    expect(summary.closest('details')?.querySelector('pre')?.textContent).toBe(fixture.prompt.text);
    expect(summary.closest('details')?.querySelector('pre')?.getAttribute('lang')).toBe('en');
    expect(p.requests.every((request) => request.method === 'GET')).toBe(true);
    expect(screen.getByText(t('memberContext.placementNote'))).toBeTruthy();
  });

  it('counts the characters of a long section in English, with a formatted number (PM-1180)', async () => {
    setCurrentLanguage('en');
    const p = mockProject();
    const fixture = sample(p);
    fixture.prompt.sections[0]!.chars = 1234;
    server.use(http.get(endpoint, () => HttpResponse.json(fixture)));
    p.render(page(), '/p/AC/team/fe-1/context');
    await ready();
    expect(screen.getByText('1,234 chars')).toBeTruthy();
    expect(document.body.textContent).not.toContain('NaN');
  });

  it('copies the full original prompt and announces success', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const p = mockProject();
    p.render(page(), '/p/AC/team/fe-1/context');
    await ready();
    fireEvent.click(screen.getByRole('button', { name: t('memberContext.copy') }));
    await screen.findByText(t('memberContext.copied'));
    expect(writeText).toHaveBeenCalledWith(sample(p).prompt.text);
  });

  it('expands and collapses all introduction folds together', async () => {
    const p = mockProject();
    p.render(page(), '/p/AC/team/fe-1/context');
    await ready();
    fireEvent.click(screen.getByRole('button', { name: t('memberContext.expandAll') }));
    expect([...document.querySelectorAll('details')].every((fold) => fold.open)).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: t('memberContext.collapseAll') }));
    expect([...document.querySelectorAll('details')].every((fold) => !fold.open)).toBe(true);
  });

  it('selects a task with arrows and Enter, dismisses options with Escape and restores the URL on Back', async () => {
    const p = mockProject();
    p.render(page(), '/p/AC/team/fe-1/context?part=guides');
    await ready();
    const general = screen.getByRole('button', { name: t('memberContext.general') });
    general.focus();
    fireEvent.keyDown(general, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: t('memberContext.onTask') }));
    await screen.findByText(t('memberContext.chooseTask'));
    const input = screen.getByRole('combobox', { name: t('memberContext.task') });
    const task = p.backend.tasks.find((entry) => entry.kind !== 'theme')!;
    fireEvent.change(input, { target: { value: task.title } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.getAttribute('aria-expanded')).toBe('false');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    await screen.findByText(t('memberContext.previewOnTask', { task: task.key }));
    expect(screen.getByTestId('location').textContent).toContain(`task=${task.key}`);
    expect(screen.getByTestId('location').textContent).toContain('part=guides');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await screen.findByText(t('memberContext.preview'));
  });

  it.each(['task_not_found', 'invalid_request', 'task_is_theme'] as const)(
    'places %s under the task field without retrying',
    async (code) => {
      const p = mockProject();
      server.use(
        http.get(endpoint, () =>
          HttpResponse.json(
            { error: { code, message: 'Task error' } },
            { status: code === 'task_not_found' ? 404 : 400 },
          ),
        ),
      );
      p.render(page(), '/p/AC/team/fe-1/context?task=AC-9999');
      await screen.findByText(
        t(code === 'task_is_theme' ? 'memberContext.taskIsTheme' : 'memberContext.taskNotFound', {
          task: 'AC-9999',
        }),
      );
      expect(
        screen.getByRole('combobox', { name: t('memberContext.task') }).getAttribute('aria-invalid'),
      ).toBe('true');
      expect(screen.queryByText(t('memberContext.ready'))).toBeNull();
      expect(p.requests.filter((request) => request.path.includes('/context'))).toHaveLength(1);
    },
  );

  it('accepts a typed task key outside the board', async () => {
    const p = mockProject();
    p.render(page(), '/p/AC/team/fe-1/context');
    await ready();
    fireEvent.click(screen.getByRole('button', { name: t('memberContext.onTask') }));
    const input = screen.getByRole('combobox', { name: t('memberContext.task') });
    fireEvent.change(input, { target: { value: 'ac-9999' } });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(input.getAttribute('aria-expanded')).toBe('false');
    fireEvent.keyDown(input, { key: 'Enter' });
    await screen.findByText(t('memberContext.taskNotFound', { task: 'AC-9999' }));
  });

  it('explains a human member reached by a direct link', async () => {
    const p = mockProject();
    p.render(page(), '/p/AC/team/owner/context');
    await screen.findByText(t('memberContext.human', { name: p.backend.findMember('owner')!.displayName }));
    expect(screen.getByText(t('memberContext.chooseAi'))).toBeTruthy();
  });

  it('explains a missing member', async () => {
    const p = mockProject();
    p.render(page(), '/p/AC/team/unknown/context');
    await screen.findByText(t('memberContext.memberNotFound'));
    expect(screen.getByRole('link', { name: t('memberContext.backToTeam') })).toBeTruthy();
  });

  it('explains denied server access', async () => {
    const p = mockProject();
    server.use(
      http.get(endpoint, () =>
        HttpResponse.json({ error: { code: 'insufficient_access', message: 'Denied' } }, { status: 403 }),
      ),
    );
    p.render(page(), '/p/AC/team/fe-1/context');
    await screen.findByText(t('memberContext.ownerOnly'));
    expect(screen.queryByText(t('memberContext.ready'))).toBeNull();
  });

  it('does not request context for a non-owner', async () => {
    const p = mockProject();
    p.render(page(), '/p/AC/team/fe-1/context', {
      me: { ...p.context.me, projects: [{ ...p.context.me.projects[0]!, access: 'admin' }] },
    });
    await screen.findByText(t('memberContext.ownerOnly'));
    expect(p.requests.some((request) => request.path.includes('/context'))).toBe(false);
  });

  it('shows a network error and retries on request', async () => {
    const p = mockProject();
    server.use(http.get(endpoint, () => HttpResponse.error()));
    const rendered = p.render(page(), '/p/AC/team/fe-1/context');
    rendered.client.setQueryDefaults(['memberContext'], { retry: false });
    await screen.findByText(t('memberContext.error'));
    server.resetHandlers();
    fireEvent.click(screen.getByRole('button', { name: t('app.retry') }));
    await ready();
  });

  it.each(['guides', 'tools'] as const)('explains empty %s', async (part) => {
    const p = mockProject();
    const fixture = sample(p);
    fixture[part] = [];
    server.use(http.get(endpoint, () => HttpResponse.json(fixture)));
    p.render(page(), `/p/AC/team/fe-1/context?part=${part}`);
    await screen.findByText(t(part === 'guides' ? 'memberContext.noGuides' : 'memberContext.noTools'));
    expect(
      screen
        .getByRole('button', { name: new RegExp(t(`memberContext.parts.${part}`, { count: 0 })) })
        .querySelector('strong')?.textContent,
    ).toBe('0');
  });

  it('filters tools, keeps the visibility explanation and clears a missing match', async () => {
    const p = mockProject();
    p.render(page(), '/p/AC/team/fe-1/context?part=tools');
    await ready();
    const input = screen.getByRole('textbox', { name: t('memberContext.toolsFilter') });
    fireEvent.change(input, { target: { value: 'timeline' } });
    expect(screen.getByText('get_task')).toBeTruthy();
    expect(screen.queryByText('get_guide')).toBeNull();
    fireEvent.change(input, { target: { value: 'missing' } });
    expect(screen.getByText(t('memberContext.toolsNote'))).toBeTruthy();
    expect(screen.getByText(t('memberContext.noMatches', { filter: 'missing' }))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('memberContext.clearFilter') }));
    expect(screen.getByText('get_guide')).toBeTruthy();
  });

  it('persists only dismissal of the first-use notice', async () => {
    const p = mockProject();
    const first = p.render(page(), '/p/AC/team/fe-1/context');
    fireEvent.click(screen.getByRole('button', { name: t('memberContext.firstUseOk') }));
    first.unmount();
    p.render(page(), '/p/AC/team/fe-1/context');
    expect(screen.queryByText(t('memberContext.firstUse'))).toBeNull();
    expect(Object.keys(localStorage)).toEqual(['memberContext.introductionDismissed']);
  });

  it('clears the old member while loading a new selection and preserves the situation', async () => {
    const p = mockProject();
    const task = p.backend.tasks.find((entry) => entry.kind !== 'theme')!;
    p.render(page(), `/p/AC/team/fe-1/context?part=guides&task=${task.key}`);
    await ready();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get(endpoint, async () => {
        await blocked;
        return HttpResponse.json(sample(p));
      }),
    );
    const next = p.backend.members.find((entry) => entry.kind === 'ai' && entry.handle !== 'fe-1')!;
    fireEvent.change(screen.getByRole('combobox', { name: t('memberContext.member') }), {
      target: { value: next.handle },
    });
    await screen.findByText(t('memberContext.loading'));
    expect(screen.queryByText('Team rules', { exact: false })).toBeNull();
    expect(screen.getByTestId('location').textContent).toContain(`part=guides&task=${task.key}`);
    release();
    await ready();
  });

  it('refreshes the preview from the server', async () => {
    const p = mockProject();
    p.render(page(), '/p/AC/team/fe-1/context');
    await ready();
    const refresh = screen.getByRole('button', { name: t('memberContext.refresh') });
    refresh.focus();
    fireEvent.click(refresh);
    await waitFor(() =>
      expect(p.requests.filter((request) => request.path.includes('/context'))).toHaveLength(2),
    );
    await ready();
    expect(document.activeElement).toBe(refresh);
    openPart('guides');
    expect(screen.getByText('Team rules', { exact: false })).toBeTruthy();
  });
});
