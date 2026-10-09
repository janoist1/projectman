import { fireEvent, screen } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { MockBackend } from '../../mocks/backend';
import { mockProject } from '../../test/mockProject';
import { SetupPage } from './SetupPage';

function renderSetup(backend: MockBackend) {
  const project = mockProject(backend);
  project.render(
    <Routes>
      <Route path="/setup" element={<SetupPage />} />
      <Route path="/" element={<p>home</p>} />
    </Routes>,
    '/setup',
  );
  return project;
}
function fillAccount() {
  fireEvent.change(screen.getByLabelText(t('auth.setup.name'), { exact: false }), {
    target: { value: 'Owner' },
  });
  fireEvent.change(screen.getByLabelText(t('auth.setup.email'), { exact: false }), {
    target: { value: 'owner@example.com' },
  });
  fireEvent.change(screen.getByLabelText(t('auth.setup.password'), { selector: 'input' }), {
    target: { value: 'correct horse battery' },
  });
}
afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

describe('SetupPage', () => {
  it('has no code field on a single machine', async () => {
    const backend = new MockBackend('setup');
    renderSetup(backend);
    await screen.findByLabelText(t('auth.setup.name'), { exact: false });
    expect(screen.queryByLabelText(t('auth.setup.setupCode'), { exact: false })).toBeNull();
  });

  it('asks for the setup code in cloud mode and sends it', async () => {
    const backend = new MockBackend('setup');
    backend.setupCode = 'ABCD2345WXYZ';
    renderSetup(backend);
    const code = await screen.findByLabelText(t('auth.setup.setupCode'), { exact: false });
    fillAccount();
    fireEvent.click(screen.getByRole('button', { name: t('auth.setup.submit') }));
    expect(await screen.findByText(t('auth.validation.setupCodeRequired'))).toBeTruthy();
    expect(backend.auth).toBe('setup');

    fireEvent.change(code, { target: { value: 'wrong-code' } });
    fireEvent.click(screen.getByRole('button', { name: t('auth.setup.submit') }));
    expect(await screen.findByText(t('errors.codes.setup_code_invalid'))).toBeTruthy();

    fireEvent.change(code, { target: { value: 'abcd-2345-wxyz' } });
    fireEvent.click(screen.getByRole('button', { name: t('auth.setup.submit') }));
    await screen.findByText('home');
    expect(backend.auth).toBe('ready');
  });
});
