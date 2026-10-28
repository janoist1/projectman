import { screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { setFetchImplementation } from '../api/client';
import { t } from '../i18n/t';
import { MockBackend } from '../mocks/backend';
import { mockProject } from '../test/mockProject';
import { AppRoutes } from './App';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

const OWNER = { userId: 'usr_owner2', name: 'Eszter', email: 'eszter@owner.test' };

it('sends an owner account without a project to the first steps, not to project creation', async () => {
  const backend = new MockBackend();
  backend.user = OWNER;
  backend.viewerHandle = '';
  backend.ownerAccountIds.add(OWNER.userId);
  backend.engineMode = 'cloud';
  mockProject(backend).render(<AppRoutes />, '/');
  expect(await screen.findByText(t('ownerOnboarding.welcome.step1'))).toBeTruthy();
});
