/** PM-693: render agreement, style and knowledge proposals with REST fixtures. */
import { hu } from '../../apps/web/src/i18n/hu.ts';

export default async ({ instance, open, shoot, step }) => {
  const owner = (await instance.api('/api/me')).handles.AC;
  const members = await instance.api('/api/projects/AC/members');
  const operator = members.find((member) => member.kind === 'ai' && member.role === 'ai_operator');
  const now = new Date().toISOString();
  const preference = {
    schemaVersion: 1,
    revision: 0,
    data: {
      length: 'brief',
      technicalLevel: 'plain',
      detail: 'offer',
      clarity: 'plain',
      background: 'minimal',
    },
    updatedAt: null,
  };
  const empty = { schemaVersion: 1, revision: 0, agreement: null, principles: [], appliedProposalIds: [] };
  const approval = { approvedBy: owner, approvedAt: now };
  const filled = {
    ...empty,
    revision: 3,
    agreement: {
      version: 2,
      data: {
        summary:
          'A fontos döntéseket megbeszéljük. A jóváhagyott kereteken belül önállóan intézem a rutinbeállításokat, és utólag jelentem, mi változott.',
        involvement: 'important',
        extraCritical: ['Kiadás és adatvesztéssel járó lépés előtt kérdezek.'],
      },
      ...approval,
    },
    principles: [
      {
        id: 'rule-1',
        principle: 'Egyszerre egy eldönthető kérdést teszek fel.',
        effect: 'A döntéshez szükséges összefüggést röviden leírom.',
        example: 'Több összekapcsolt kérdés között elveszett a fontos döntés.',
        ...approval,
      },
      {
        id: 'rule-2',
        principle: 'A kész munka mellé ellenőrzési eredményt is adok.',
        effect: 'A változás hatását és a teszt eredményét együtt jelentem.',
        example: 'A tulajdonos külön rákérdezett az ellenőrzésre.',
        ...approval,
      },
    ],
  };
  const payload = {
    id: 'proposal-1',
    requestId: 'req-1',
    stepId: 'step-1',
    baseRevision: 3,
    change: { kind: 'agreement_replace', agreement: { ...filled.agreement.data, involvement: 'minimal' } },
    operations: [],
    changes: [
      { area: 'limits', target: null, field: 'maxAiSessions', before: '2', after: '3', level: 'approval' },
    ],
    baseConfigVersion: null,
    proposedBy: operator.handle,
    stale: null,
    applying: null,
  };
  const item = {
    id: 'inb_knowledge',
    projectKey: 'AC',
    kind: 'approval',
    assignees: [owner],
    source: operator.handle,
    taskKey: null,
    sessionId: null,
    title: 'Közös megállapodásunk',
    body: '',
    options: [
      { id: 'approve', label: 'Approve', style: 'primary' },
      { id: 'reject', label: 'Reject', style: 'secondary' },
    ],
    payload: { operatorKnowledge: payload },
    state: 'open',
    createdAt: now,
    resolution: null,
  };
  const state = { knowledge: filled, access: 'owner', load: 'ok', loading: null, items: [item] };
  const page = await open({ path: '/p/AC' });
  const json = (route, status, body) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/me', async (route) => {
    const response = await route.fetch();
    const me = await response.json();
    me.projects = me.projects.map((project) =>
      project.key === 'AC' ? { ...project, access: state.access } : project,
    );
    return json(route, 200, me);
  });
  await page.route('**/api/projects/AC/operator/knowledge', async (route) => {
    if (state.loading) await state.loading;
    return state.load === 'error'
      ? json(route, 503, { error: { code: 'operator_knowledge_unavailable', message: 'Unavailable' } })
      : json(route, 200, state.knowledge);
  });
  await page.route('**/api/projects/AC/operator/preferences/me', (route) => json(route, 200, preference));
  await page.route('**/api/projects/AC/operator/preferences', (route) =>
    json(route, 200, {
      items: [
        { handle: owner, preference },
        {
          handle: 'kata',
          preference: { ...preference, revision: 1, data: { ...preference.data, length: 'detailed' } },
        },
      ],
    }),
  );
  await page.route('**/api/projects/AC/operator/approval-waiver', (route) =>
    json(route, 409, { error: { code: 'operator_knowledge_stale', message: 'Changed' } }),
  );
  await page.route(
    (url) => url.pathname === '/api/projects/AC/inbox',
    async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      return json(route, 200, { ...body, items: [...state.items, ...body.items] });
    },
  );
  const showView = async () => {
    await page.goto(`${new URL(page.url()).origin}/p/AC`);
    await page.getByRole('button', { name: new RegExp(`^${hu.operator.panel.label}`) }).click();
    await page
      .getByRole('button', {
        name: state.access === 'client' ? hu.knowledge.style : hu.knowledge.title,
        exact: true,
      })
      .click();
  };
  const capture = async (name) => {
    await shoot(page, name, { widths: [1512, 390] });
    const body = page.locator('#operator-panel').locator('[class*="view_"]');
    if (await body.count()) {
      const others = page.getByText(hu.knowledge.others.replace('{count}', '1'), { exact: true });
      if (await others.count()) await others.click();
      await body.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await shoot(page, `${name}-lower`, { widths: [1512, 390] });
    }
  };
  await step('Owner agreement and learned principles', async () => {
    await showView();
    await page.getByText(filled.agreement.data.summary).waitFor();
    await capture('owner-filled');
  });
  await step('Enable confirmation and conflict', async () => {
    await page.getByRole('switch').scrollIntoViewIfNeeded();
    await page.getByRole('switch').click();
    await shoot(page, 'waiver-dialog', { widths: [1512, 390] });
    await page.getByRole('button', { name: hu.knowledge.waiver.enable, exact: true }).click();
    await page.getByRole('alert').filter({ hasText: hu.knowledge.waiver.conflict }).waitFor();
    await shoot(page, 'waiver-conflict', { widths: [1512, 390] });
  });
  await step('First use', async () => {
    state.knowledge = empty;
    state.items = [];
    await showView();
    await page.getByText(hu.knowledge.emptyOwner).waitFor();
    await capture('owner-empty');
  });
  await step('Admin read-only view', async () => {
    state.knowledge = filled;
    state.access = 'admin';
    await showView();
    await page.getByText(filled.agreement.data.summary).waitFor();
    await capture('admin');
  });
  await step('Guest sees their own style', async () => {
    state.access = 'client';
    await showView();
    await page.getByText(hu.knowledge.defaultStyle).waitFor();
    await shoot(page, 'guest', { widths: [1512, 390] });
  });
  await step('Shared-data failure preserves personal style', async () => {
    state.access = 'owner';
    state.load = 'error';
    await showView();
    await page.getByText(hu.knowledge.failed).waitFor();
    await shoot(page, 'knowledge-error', { widths: [1512, 390] });
    state.load = 'ok';
  });
  await step('Loading shared knowledge preserves personal style', async () => {
    let release;
    state.loading = new Promise((resolve) => {
      release = resolve;
    });
    await showView();
    await page.getByText(hu.knowledge.defaultStyle).waitFor();
    await shoot(page, 'knowledge-loading', { widths: [1512, 390] });
    release();
    state.loading = null;
  });
  for (const [name, change, stale] of [
    ['agreement-proposal', payload.change, null],
    [
      'principle-proposal',
      {
        kind: 'principle_put',
        principle: { ...filled.principles[0], id: null, approvedBy: undefined, approvedAt: undefined },
      },
      null,
    ],
    ['stale-proposal', payload.change, { reason: 'knowledge_changed', at: now }],
  ])
    await step(name, async () => {
      state.items = [{ ...item, payload: { operatorKnowledge: { ...payload, change, stale } } }];
      await page.goto(`${new URL(page.url()).origin}/p/AC/inbox`);
      await page.locator('[data-operator-knowledge]').waitFor();
      await shoot(page, name, { widths: [1512, 390] });
    });
};
