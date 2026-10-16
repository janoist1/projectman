import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InboxItem, OperatorKnowledgeApprovalPayload } from '@projectman/shared';
import { DEFAULT_OPERATOR_PREFERENCE } from '@projectman/shared';
import { Route, Routes } from 'react-router';
import { MeContext } from '../../app/contexts';
import { ProjectLayout } from '../../app/ProjectLayout';
import { setFetchImplementation } from '../../api/client';
import { ToastProvider } from '../../components/Toast';
import { t } from '../../i18n/t';
import { mockProject, createMockFetch } from '../../test/mockProject';
import { OperatorKnowledgeView } from './OperatorKnowledgeView';
import { OperatorPanel } from './OperatorPanel';
import { InboxPage } from '../inbox/InboxPage';
import { OperatorKnowledgeActions, OperatorKnowledgeBody } from './OperatorKnowledgeApproval';

afterEach(() => {
  vi.restoreAllMocks();
  setFetchImplementation((input, init) => globalThis.fetch(input, init));
});

function setup() {
  const project = mockProject();
  project.backend.operatorKnowledge = {
    schemaVersion: 1,
    revision: 3,
    appliedProposalIds: [],
    agreement: {
      version: 2,
      data: { summary: 'Approved summary', involvement: 'important', extraCritical: ['Ask before deleting'] },
      approvedBy: 'owner',
      approvedAt: '2026-10-14T12:00:00.000Z',
    },
    principles: [
      {
        id: 'rule-1',
        example: 'Past example',
        principle: 'Current principle',
        effect: 'Current effect',
        approvedBy: 'owner',
        approvedAt: '2026-10-14T12:00:00.000Z',
      },
    ],
  };
  return project;
}
function renderView(project: ReturnType<typeof setup>, overrides = {}) {
  const onPrefill = vi.fn();
  const onBack = vi.fn();
  project.render(
    <ToastProvider>
      <OperatorKnowledgeView onBack={onBack} onPrefill={onPrefill} />
    </ToastProvider>,
    '/',
    overrides,
  );
  return { onPrefill, onBack };
}
function proposal(
  _project: ReturnType<typeof setup>,
  change: OperatorKnowledgeApprovalPayload['change'],
): InboxItem {
  const payload: OperatorKnowledgeApprovalPayload = {
    id: 'proposal-1',
    requestId: 'req-1',
    stepId: 'step-1',
    baseRevision: 3,
    change,
    operations: [],
    changes: [],
    baseConfigVersion: null,
    proposedBy: 'operator',
    stale: null,
    applying: null,
  };
  return {
    id: 'knowledge-1',
    projectKey: 'AC',
    kind: 'approval',
    state: 'open',
    source: 'operator',
    title: 'Knowledge proposal',
    body: '',
    taskKey: null,
    sessionId: null,
    assignees: ['owner'],
    options: [
      { id: 'approve', label: 'Approve', style: 'primary' },
      { id: 'reject', label: 'Reject', style: 'secondary' },
    ],
    payload: { operatorKnowledge: payload },
    createdAt: '2026-10-14T12:00:00.000Z',
    resolution: null,
  };
}
const toggle = () => screen.findByRole('switch', { name: t('knowledge.waiver.title') });
const puts = (project: ReturnType<typeof setup>) =>
  project.requests.filter((request) => request.method === 'PUT');

describe('Operator knowledge view', () => {
  it('reads the agreement and personal style, and prefills edits without sending', async () => {
    const project = setup();
    const { onPrefill } = renderView(project);
    expect(await screen.findByText('Approved summary')).toBeTruthy();
    expect(await screen.findByText(t('knowledge.defaultStyle'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('knowledge.rewrite') }));
    expect(onPrefill).toHaveBeenCalledWith(t('knowledge.rewritePrompt', { principle: 'Current principle' }));
    expect(project.requests.filter((request) => request.method !== 'GET')).toHaveLength(0);
  });

  it('opens the panel view and returns an edit to the focused composer', async () => {
    const project = setup();
    project.render(
      <ToastProvider>
        <OperatorPanel returnFocusTo={{ current: null }} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: t('knowledge.title') }));
    await screen.findByText('Approved summary');
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: t('knowledge.styleEdit') }));
    const composer = await screen.findByRole('textbox', { name: t('operator.composer.label') });
    await waitFor(() => expect((composer as HTMLTextAreaElement).value).toBe(t('knowledge.stylePrompt')));
    expect(document.activeElement).toBe(composer);
  });

  it.each(['developer', 'client', 'viewer'] as const)(
    'does not request or render shared data for %s',
    async (access) => {
      const project = setup();
      project.backend.viewerHandle = 'kata';
      renderView(project, {
        isOwner: false,
        myHandle: 'kata',
        me: { ...project.context.me, projects: [{ key: 'AC', name: 'Acme', access, roles: [] }] },
      });
      await screen.findByText(t('knowledge.defaultStyle'));
      expect(
        project.requests.some((request) => /operator\/(knowledge|preferences)$/.test(request.path)),
      ).toBe(false);
      expect(screen.queryByText(t('knowledge.agreement'))).toBeNull();
      expect(screen.queryByText('Current principle')).toBeNull();
      expect(screen.queryByRole('switch')).toBeNull();
    },
  );

  it('shows shared data to an admin without write controls', async () => {
    const project = setup();
    const owner = project.backend.config.team.members.find((member) => member.handle === 'owner');
    if (owner?.kind === 'human') owner.access = 'admin';
    project.backend.operatorPreferences.kata = {
      schemaVersion: 1,
      revision: 1,
      data: { ...DEFAULT_OPERATOR_PREFERENCE, length: 'detailed' },
      updatedAt: '2026-10-14T12:00:00.000Z',
    };
    renderView(project, {
      isOwner: false,
      me: { ...project.context.me, projects: [{ key: 'AC', name: 'Acme', access: 'admin', roles: [] }] },
    });
    await screen.findByText('Approved summary');
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('button', { name: t('knowledge.rewrite') })).toBeNull();
    fireEvent.click(screen.getByText(t('knowledge.others', { count: 1 })));
    expect(await screen.findByText(/Részletes ·/)).toBeTruthy();
  });

  it('requires an agreement before enabling the waiver', async () => {
    const project = setup();
    project.backend.operatorKnowledge.agreement = null;
    renderView(project);
    expect(((await toggle()) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(t('knowledge.emptyOwner'))).toBeTruthy();
  });

  it('keeps the old value while saving, confirms once and accepts only the server value', async () => {
    const project = setup();
    const transport = createMockFetch(project.backend, project.requests);
    let finish: (() => void) | undefined;
    setFetchImplementation(async (path, init) => {
      if (init?.method === 'PUT')
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      return transport(path, init);
    });
    renderView(project);
    const control = await toggle();
    fireEvent.click(control);
    const dialog = screen.getByRole('dialog');
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(dialog).getByRole('button', { name: t('knowledge.waiver.cancel') }),
      ),
    );
    const confirm = within(dialog).getByRole('button', { name: t('knowledge.waiver.enable') });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect((control as HTMLInputElement).checked).toBe(false);
    expect((control as HTMLInputElement).disabled).toBe(true);
    finish?.();
    await waitFor(() => expect((control as HTMLInputElement).checked).toBe(true));
    expect(puts(project)).toHaveLength(1);
    expect(puts(project)[0]!.body).toEqual({
      baseVersion: expect.any(String),
      enabled: true,
      agreementVersion: 2,
    });
    await waitFor(() => expect(document.activeElement).toBe(control));
  });

  it('disables immediately and uses the returned value even when it differs from the request', async () => {
    const project = setup();
    project.backend.config.team.operatorApprovalWaiver = true;
    const transport = createMockFetch(project.backend, project.requests);
    setFetchImplementation(async (path, init) => {
      const result = await transport(path, init);
      if (init?.method !== 'PUT') return result;
      project.backend.config.team.operatorApprovalWaiver = true;
      return new Response(
        JSON.stringify({ version: project.backend.configVersion, enabled: true, agreementVersion: 2 }),
        { status: 200 },
      );
    });
    renderView(project);
    const control = await toggle();
    fireEvent.click(control);
    await waitFor(() => expect(puts(project)).toHaveLength(1));
    await waitFor(() => expect((control as HTMLInputElement).disabled).toBe(false));
    expect((control as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(puts(project)[0]!.body).toMatchObject({ enabled: false });
  });

  it('refreshes after a conflict without retrying or enabling', async () => {
    const project = setup();
    renderView(project);
    const control = await toggle();
    fireEvent.click(control);
    project.backend.operatorKnowledge.agreement!.version = 3;
    fireEvent.click(screen.getByRole('button', { name: t('knowledge.waiver.enable') }));
    expect((await screen.findByRole('alert')).textContent).toContain(t('knowledge.waiver.conflict'));
    expect((control as HTMLInputElement).checked).toBe(false);
    expect(puts(project)).toHaveLength(1);
    expect(project.requests.filter((request) => request.path.endsWith('/operator/knowledge'))).toHaveLength(
      2,
    );
  });

  it('keeps the personal style visible when shared knowledge fails', async () => {
    const project = setup();
    const transport = createMockFetch(project.backend, project.requests);
    setFetchImplementation((path, init) =>
      path.endsWith('/operator/knowledge')
        ? Promise.resolve(
            new Response(
              JSON.stringify({ error: { code: 'operator_knowledge_unavailable', message: 'Unavailable' } }),
              { status: 503 },
            ),
          )
        : transport(path, init),
    );
    renderView(project);
    await screen.findByText(t('knowledge.defaultStyle'));
    await screen.findByText(t('knowledge.failed'));
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByText('Current principle')).toBeNull();
  });
});

describe('Operator knowledge approvals', () => {
  it('does not replay a proposal prefill after closing and reopening the panel', async () => {
    const project = setup();
    const item = proposal(project, { kind: 'principle_remove', id: 'rule-1' });
    const payload = item.payload.operatorKnowledge as OperatorKnowledgeApprovalPayload;
    payload.stale = { reason: 'knowledge_changed', at: '2026-10-14T12:00:00.000Z' };
    item.options = [{ id: 'dismiss', label: 'Dismiss', style: 'secondary' }];
    project.backend.inbox = [item];
    project.render(
      <ToastProvider>
        <MeContext.Provider value={project.context.me}>
          <Routes>
            <Route path="/p/:projectKey" element={<ProjectLayout />}>
              <Route path="inbox" element={<InboxPage />} />
            </Route>
          </Routes>
        </MeContext.Provider>
      </ToastProvider>,
      '/p/AC/inbox',
    );
    fireEvent.click(await screen.findByRole('button', { name: t('knowledge.proposal.retry') }));
    const prefill = t('knowledge.proposal.retryPrompt', { title: item.title });
    const composer = await screen.findByRole('textbox', { name: t('operator.composer.label') });
    await waitFor(() => expect((composer as HTMLTextAreaElement).value).toBe(prefill));
    fireEvent.click(screen.getByRole('button', { name: t('operator.panel.close') }));
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${t('operator.panel.label')}`) }));
    const reopened = await screen.findByRole('textbox', { name: t('operator.composer.label') });
    expect((reopened as HTMLTextAreaElement).value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: t('knowledge.title') }));
    expect(await screen.findByRole('heading', { name: t('knowledge.title') })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: t('operator.composer.label') })).toBeNull();
  });

  it('shows agreement involvement and the proposed configuration values', async () => {
    const project = setup();
    const item = proposal(project, {
      kind: 'agreement_replace',
      agreement: {
        summary: 'Proposed summary',
        involvement: 'minimal',
        extraCritical: ['Ask about release'],
      },
    });
    const payload = item.payload.operatorKnowledge as OperatorKnowledgeApprovalPayload;
    payload.changes = [
      {
        area: 'member',
        target: 'fe-1',
        field: 'model',
        before: 'old-model',
        after: 'new-model',
        level: 'approval',
      },
    ];
    project.backend.inbox = [item];
    project.render(
      <ToastProvider>
        <InboxPage />
      </ToastProvider>,
      '/p/AC/inbox',
    );
    await screen.findByText('Proposed summary');
    expect(
      await screen.findByText(
        t('knowledge.proposal.previous', { value: t('knowledge.involvement.important') }),
      ),
    ).toBeTruthy();
    expect(screen.getByText('old-model')).toBeTruthy();
    expect(screen.getByText('new-model')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: t('operator.approval.reject') }));
    await screen.findByText(t('operator.approval.rejected'));
    expect(project.backend.operatorKnowledge.agreement!.data.summary).toBe('Approved summary');
  });

  it('shows a principle being recorded without active decision buttons', async () => {
    const project = setup();
    const item = proposal(project, { kind: 'principle_remove', id: 'rule-1' });
    const payload = item.payload.operatorKnowledge as OperatorKnowledgeApprovalPayload;
    payload.applying = { by: 'owner', at: '2026-10-14T12:00:00.000Z' };
    const decide = vi.fn();
    project.render(
      <>
        <OperatorKnowledgeBody payload={payload} />
        <OperatorKnowledgeActions
          item={item}
          payload={payload}
          pending={false}
          stale={false}
          onDecide={decide}
        />
      </>,
    );
    expect(await screen.findByText('Current principle')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe(t('knowledge.proposal.applying'));
    expect(screen.queryByRole('button', { name: t('operator.approval.approve') })).toBeNull();
  });

  it('lets an admin read the proposal without offering a decision', async () => {
    const project = setup();
    const item = proposal(project, { kind: 'principle_remove', id: 'rule-1' });
    const payload = item.payload.operatorKnowledge as OperatorKnowledgeApprovalPayload;
    project.render(
      <OperatorKnowledgeActions
        item={item}
        payload={payload}
        pending={false}
        stale={false}
        onDecide={vi.fn()}
      />,
      '/',
      { isOwner: false },
    );
    expect(screen.getByText(t('knowledge.proposal.ownerOnly'))).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows the old principle and resolves a double click once', async () => {
    const project = setup();
    project.backend.inbox = [
      proposal(project, {
        kind: 'principle_put',
        principle: { id: 'rule-1', principle: 'New principle', effect: 'New effect', example: 'New example' },
      }),
    ];
    project.render(
      <ToastProvider>
        <InboxPage />
      </ToastProvider>,
      '/p/AC/inbox',
    );
    await screen.findByText('New principle');
    expect(
      await screen.findByText(t('knowledge.proposal.previous', { value: 'Current principle' })),
    ).toBeTruthy();
    const approve = screen.getByRole('button', { name: t('operator.approval.approve') });
    fireEvent.click(approve);
    fireEvent.click(approve);
    await waitFor(() =>
      expect(project.requests.filter((request) => request.path.endsWith('/resolve'))).toHaveLength(1),
    );
    await screen.findByText(t('knowledge.proposal.approvedPrinciple'));
    expect(project.backend.operatorKnowledge.principles[0]!.principle).toBe('New principle');
  });

  it('shows a stale reason and requests a new proposal through the composer path', async () => {
    const project = setup();
    project.backend.inbox = [proposal(project, { kind: 'principle_remove', id: 'rule-1' })];
    const openOperator = vi.fn();
    project.render(
      <ToastProvider>
        <InboxPage />
      </ToastProvider>,
      '/p/AC/inbox',
      { openOperator },
    );
    const approve = await screen.findByRole('button', { name: t('operator.approval.approve') });
    project.backend.operatorKnowledge.revision++;
    fireEvent.click(approve);
    expect((await screen.findByRole('alert')).textContent).toContain(
      t('knowledge.proposal.knowledge_changed'),
    );
    fireEvent.click(screen.getByRole('button', { name: t('knowledge.proposal.retry') }));
    expect(openOperator).toHaveBeenCalledWith(
      expect.anything(),
      t('knowledge.proposal.retryPrompt', { title: 'Knowledge proposal' }),
    );
    expect(project.backend.operatorKnowledge.principles).toHaveLength(1);
  });
});
