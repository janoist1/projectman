import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { SuperOperationAudit } from '@projectman/shared';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { mockProject } from '../../test/mockProject';
import { InvolvementsPage } from './InvolvementsPage';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

it('filters and paginates the audit by prefix without fetching involvements', async () => {
  const project = mockProject();
  const base: SuperOperationAudit = {
    id: 'audit',
    projectKey: 'AC',
    taskKey: 'AC-21',
    prefix: 'pmi_filter',
    operatorMode: 'super',
    requestId: 'req_1',
    handoffId: 'handoff',
    operation: 'member.update',
    outcome: 'succeeded',
    errorCode: null,
    createdAt: new Date().toISOString(),
  };
  project.backend.superAudits = Array.from({ length: 51 }, (_, i) => ({ ...base, id: `audit_${i}` }));
  project.backend.superAudits.push({
    ...base,
    id: 'hidden',
    prefix: 'pmi_other',
    operation: 'hidden.operation',
  });
  project.render(<InvolvementsPage />, '/p/AC/sessions?by=super&prefix=pmi_filter');
  expect(await screen.findByRole('button', { name: t('superMode.more') })).toBeTruthy();
  expect(screen.queryByText(/member\.update/)).toBeNull();
  expect(screen.getAllByText(new RegExp(t('superMode.operations.member.update'))).length).toBe(50);
  expect(screen.getByRole('heading', { name: t('superMode.operationsTitle') })).toBeTruthy();
  expect(screen.queryByText(/hidden.operation/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: t('superMode.more') }));
  await waitFor(() =>
    expect(
      project.requests.some((request) => request.path.includes('prefix=pmi_filter&before=audit_49')),
    ).toBe(true),
  );
  await waitFor(() => expect(screen.queryByRole('button', { name: t('superMode.more') })).toBeNull());
  expect(project.requests.some((request) => request.path.includes('/involvements'))).toBe(false);
});

it('shows unknown outcomes', async () => {
  const project = mockProject();
  project.backend.superAudits = [
    {
      id: 'unknown',
      projectKey: 'AC',
      taskKey: 'AC-21',
      prefix: 'pmi_test',
      operatorMode: 'super',
      requestId: 'req_unknown',
      handoffId: null,
      operation: 'merge',
      outcome: 'unknown',
      errorCode: null,
      createdAt: new Date().toISOString(),
    },
  ];
  project.render(<InvolvementsPage />, '/p/AC/sessions?by=super');
  expect(await screen.findByText(t('superMode.outcomes.unknown'))).toBeTruthy();
});

it('does not read owner-only audit as a non-owner', () => {
  const project = mockProject();
  project.context.isOwner = false;
  project.render(<InvolvementsPage />, '/p/AC/sessions?by=super');
  expect(screen.getByText(t('integratorKey.ownerOnly'))).toBeTruthy();
  expect(project.requests.some((request) => request.path.includes('/operator-super'))).toBe(false);
  expect(screen.getByRole('heading', { name: t('superMode.activity') })).toBeTruthy();
});

it('uses project-wide empty copy without a credential filter', async () => {
  const project = mockProject();
  project.render(<InvolvementsPage />, '/p/AC/sessions?by=super');
  expect(await screen.findByText(t('superMode.emptyAll'))).toBeTruthy();
  expect(screen.queryByText(t('superMode.empty'))).toBeNull();
});
