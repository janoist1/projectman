import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { setFetchImplementation } from '../api/client';
import { queryKeys } from '../api/queryKeys';
import { ToastProvider } from '../components/Toast';
import { BoardPage } from '../features/board/BoardPage';
import { SetupPage } from '../features/auth/SetupPage';
import { currentLanguage, setCurrentLanguage } from '../i18n/language';
import { t } from '../i18n/t';
import { useLanguage } from '../i18n/useLanguage';
import { MockBackend } from '../mocks/backend';
import { mockProject } from '../test/mockProject';
import { server } from '../test/msw/server';
import { AuthGate } from './AuthGate';
import { MeContext } from './contexts';
import { AccountMenu } from './Menus';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

/** What `App` does with the language: a new one remounts the tree below it. */
function Keyed({ children }: { children: React.ReactNode }) {
  return <div key={useLanguage()}>{children}</div>;
}

function accountMenu() {
  const project = mockProject();
  const view = project.render(
    <ToastProvider>
      <Keyed>
        <MeContext.Provider value={project.context.me}>
          <AccountMenu settingsPath={null} />
        </MeContext.Provider>
      </Keyed>
    </ToastProvider>,
  );
  view.client.setQueryData(queryKeys.me, project.context.me);
  const open = () =>
    fireEvent.click(
      screen.getByRole('button', { name: t('nav.account', { name: project.context.me.name }) }),
    );
  return { ...project, ...view, open };
}

describe('language switch in the account menu', () => {
  it('saves the language and turns the page English without a reload', async () => {
    const menu = accountMenu();
    menu.open();
    fireEvent.click(await screen.findByRole('radio', { name: 'English' }));

    await waitFor(() =>
      expect(menu.requests.find((r) => r.method === 'PUT' && r.path === '/api/auth/language')?.body).toEqual({
        language: 'en',
      }),
    );
    expect(currentLanguage()).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    expect(await screen.findByRole('button', { name: `Account: ${menu.context.me.name}` })).toBeTruthy();
    expect(menu.backend.language).toBe('en');
  });

  it('puts the old language back when saving fails', async () => {
    const menu = accountMenu();
    server.use(
      http.put('*/api/auth/language', () =>
        HttpResponse.json({ code: 'internal_error', message: 'Failed' }, { status: 500 }),
      ),
    );
    menu.open();
    fireEvent.click(await screen.findByRole('radio', { name: 'English' }));
    await waitFor(() => expect(currentLanguage()).toBe('hu'));
    expect(document.documentElement.lang).toBe('hu');
    expect(await screen.findByText(t('language.saveFailed'))).toBeTruthy();
  });
});

describe('language before login', () => {
  it('opens in English without a stored choice and sends the chosen language with the account', async () => {
    window.localStorage.removeItem('pm:language');
    setCurrentLanguage('en');
    const project = mockProject(new MockBackend('setup'));
    project.render(
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/" element={<p>home</p>} />
      </Routes>,
      '/setup',
    );
    fireEvent.change(await screen.findByLabelText(t('auth.setup.name'), { exact: false }), {
      target: { value: 'Owner' },
    });
    fireEvent.change(screen.getByLabelText(t('auth.setup.email'), { exact: false }), {
      target: { value: 'owner@example.com' },
    });
    fireEvent.change(screen.getByLabelText(t('auth.setup.password'), { selector: 'input' }), {
      target: { value: 'correct horse battery' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('auth.setup.submit') }));
    await screen.findByText('home');
    const sent = project.requests.find((r) => r.path === '/api/setup' && r.method === 'POST');
    expect(sent?.body).toMatchObject({ language: 'en' });
  });

  it('switches the page by the pre-login switch alone, without a request', async () => {
    setCurrentLanguage('en');
    const project = mockProject(new MockBackend('setup'));
    project.render(
      <Keyed>
        <Routes>
          <Route path="*" element={<SetupPage />} />
        </Routes>
      </Keyed>,
      '/setup',
    );
    const englishTitle = t('auth.setup.title');
    fireEvent.click(await screen.findByRole('radio', { name: 'Magyar' }));
    await waitFor(() => expect(screen.queryByText(englishTitle)).toBeNull());
    expect(screen.getByText(t('auth.setup.title'))).toBeTruthy();
    expect(currentLanguage()).toBe('hu');
    expect(project.requests.some((r) => r.path === '/api/auth/language')).toBe(false);
  });
});

describe('language of the account', () => {
  it('wins over the one stored in the browser', async () => {
    const backend = new MockBackend();
    backend.language = 'en';
    const project = mockProject(backend);
    project.render(
      <Routes>
        <Route element={<AuthGate />}>
          <Route index element={<p>inside</p>} />
        </Route>
      </Routes>,
    );
    expect(currentLanguage()).toBe('hu');
    await screen.findByText('inside');
    expect(currentLanguage()).toBe('en');
  });
});

describe('team content in English', () => {
  it('leaves a configured stage name and a card title as they are', async () => {
    setCurrentLanguage('en');
    const project = mockProject();
    const stage = project.backend.config.pipeline.columns[0]!.name;
    const title = project.backend.tasks.find((task) => task.title)!.title;
    project.render(<BoardPage />);
    expect(await screen.findByRole('region', { name: stage })).toBeTruthy();
    expect((await screen.findAllByText(title, { exact: false })).length).toBeGreaterThan(0);
  });
});
