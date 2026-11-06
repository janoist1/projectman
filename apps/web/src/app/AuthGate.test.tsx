import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { setFetchImplementation } from '../api/client';
import { mockProject } from '../test/mockProject';
import { AppRoutes } from './App';

beforeEach(() => {
  delete document.documentElement.dataset.style;
  window.localStorage.clear();
});
afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

it('keeps an interface style whose save failed and saves it again at the next start (PM-363)', async () => {
  window.localStorage.setItem('pm:ui-style-pending', 'win311');
  const project = mockProject();
  project.render(<AppRoutes />, '/');
  await waitFor(() => expect(project.backend.uiStyle).toBe('win311'));
  expect(document.documentElement.dataset.style).toBe('win311');
  await waitFor(() => expect(window.localStorage.getItem('pm:ui-style-pending')).toBe(''));
});

it("applies the account's style on start when nothing is pending", async () => {
  const project = mockProject();
  project.backend.uiStyle = 'win311';
  project.render(<AppRoutes />, '/');
  await waitFor(() => expect(document.documentElement.dataset.style).toBe('win311'));
});
