import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { SuperHandoff, SuperOperationAudit } from '@projectman/shared';
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
  expect(screen.queryByText(/hidden.operation/)).toBeNull();
  expect(document.querySelector('a[href="/p/AC/sessions?by=super#handoff-handoff"]')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: t('superMode.more') }));
  await waitFor(() =>
    expect(
      project.requests.some((request) => request.path.includes('prefix=pmi_filter&before=audit_49')),
    ).toBe(true),
  );
  await waitFor(() => expect(screen.queryByRole('button', { name: t('superMode.more') })).toBeNull());
  expect(project.requests.some((request) => request.path.includes('/involvements'))).toBe(false);
});

it('shows pending handoffs, owner questions and unknown outcomes', async () => {
  const project = mockProject();
  const handoff: SuperHandoff = {
    id: 'h1',
    projectKey: 'AC',
    taskKey: 'AC-21',
    requestedBy: { kind: 'ai', handle: 'operator' },
    reason: 'Owner decision needed',
    command: {
      kind: 'merge_order',
      repo: 'projectman',
      taskKeys: [],
      expectedRevision: 0,
      reason: 'Queue order',
    },
    expectedConfigVersion: null,
    state: 'waiting_owner',
    operationId: 'o1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  project.backend.superHandoffs = [handoff];
  project.backend.superAudits = [
    {
      id: 'unknown',
      projectKey: 'AC',
      taskKey: 'AC-21',
      prefix: 'pmi_test',
      operatorMode: 'super',
      requestId: 'req_unknown',
      handoffId: 'h1',
      operation: 'merge',
      outcome: 'unknown',
      errorCode: null,
      createdAt: handoff.createdAt,
    },
  ];
  project.backend.superOperations = [
    {
      id: 'o1',
      projectKey: 'AC',
      taskKey: 'AC-21',
      handoffId: 'h1',
      state: 'waiting_owner',
      requestId: '00000000-0000-4000-8000-000000000000',
      command: handoff.command,
      ownerQuestionId: 'q1',
      errorCode: null,
      createdAt: handoff.createdAt,
      updatedAt: handoff.updatedAt,
    },
  ];
  project.render(<InvolvementsPage />, '/p/AC/sessions?by=super');
  expect(await screen.findByText(/Owner decision needed/)).toBeTruthy();
  expect(await screen.findByText(t('superMode.outcomes.unknown'))).toBeTruthy();
  await waitFor(() => expect(document.querySelector('a[href="/p/AC/inbox#inbox-item-q1"]')).toBeTruthy());
  expect(screen.queryByRole('button', { name: /execute/i })).toBeNull();
});

it('does not read owner-only audit as a non-owner', () => {
  const project = mockProject();
  project.context.isOwner = false;
  project.render(<InvolvementsPage />, '/p/AC/sessions?by=super');
  expect(screen.getByText(t('integratorKey.ownerOnly'))).toBeTruthy();
  expect(project.requests.some((request) => request.path.includes('/operator-super'))).toBe(false);
});

it('loads an audit-linked handoff even after it leaves the bounded list', async () => {
  const project = mockProject();
  const at = new Date().toISOString();
  const old: SuperHandoff = {
    id: 'old',
    projectKey: 'AC',
    taskKey: 'AC-21',
    requestedBy: { kind: 'ai', handle: 'operator' },
    reason: 'Old handoff reason',
    command: {
      kind: 'merge_order',
      repo: 'webshop',
      taskKeys: [],
      expectedRevision: 0,
      reason: 'Queue maintenance',
    },
    expectedConfigVersion: null,
    state: 'pending',
    operationId: null,
    createdAt: at,
    updatedAt: at,
  };
  project.backend.superHandoffs = [
    ...Array.from({ length: 51 }, (_, i) => ({ ...old, id: `recent_${i}`, reason: 'Recent handoff' })),
    old,
  ];
  project.render(<InvolvementsPage />, '/p/AC/sessions?by=super#handoff-old');
  expect(await screen.findByText(/Old handoff reason/)).toBeTruthy();
  expect(project.requests.some((request) => request.path.endsWith('/handoffs/old'))).toBe(true);
  expect(document.activeElement?.id).toBe('handoff-old');
});
