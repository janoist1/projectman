import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { routes } from '@projectman/shared';
import type { BoundaryRequester, ToolContext } from '../src/contracts';
import { TEAM_TOOLS } from '../src/mcp';
import { humanActor } from '../src/domain';
import {
  createAppHarness,
  createProject,
  setupOwner,
  addHumanAndLogin,
  inject,
  OWNER_LOGIN,
} from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { FakeBoundaryAdapter, fakeBoundaryTarget } from './helpers/fake-boundary';

const allow = { decision: 'allow', reason: 'scope_verified' } as const;
describe('boundary REST and MCP access', () => {
  let h: AppHarness;
  let adapter: FakeBoundaryAdapter;
  let owner: string;
  let lead: string;
  let outsider: string;
  let requester: BoundaryRequester;
  beforeEach(async () => {
    adapter = new FakeBoundaryAdapter();
    h = await createAppHarness({ now: () => new Date('2026-10-01T11:00:00.000Z'), boundaryAdapter: adapter });
    owner = await setupOwner(h.app);
    await createProject(h, owner);
    lead = await addHumanAndLogin(h.app, {
      handle: 'human-lead',
      roles: ['lead_developer'],
      adjust(config) {
        config.team.boundary = { enabled: true, leadTimeoutSeconds: 120 };
        const cr = config.team.members.find((m) => m.handle === 'cr')!;
        if (cr.kind === 'ai') cr.role = 'lead_developer';
      },
    });
    outsider = await addHumanAndLogin(h.app, { handle: 'admin', access: 'admin' });
    const domain = h.app.projectman.domain;
    await domain.tasks.create('AR', { title: 'External operation' }, humanActor('owner'));
    const started = await domain.taskStarts.start('AR', 'AR-1', {
      actor: humanActor('owner'),
      author: OWNER_LOGIN,
    });
    requester = { projectKey: 'AR', member: 'dev-1', sessionId: started.session!.id, taskKey: 'AR-1' };
  });
  afterEach(() => h.close());

  async function submit(id = 'docs', operation = fakeBoundaryTarget().operation) {
    adapter.register(id, requester, fakeBoundaryTarget({ operation }));
    return h.app.projectman.domain.boundary.submit(requester, { operationId: id, deduplicationKey: id });
  }
  const ctx = (member = 'cr'): ToolContext => ({ ...requester, member });

  it('uses the same live authorization for a human REST lead and an AI MCP lead', async () => {
    const first = await submit();
    expect(
      (await inject(h.app, 'POST', routes.decideBoundary('AR', first.id), outsider, allow)).statusCode,
    ).toBe(403);
    await expect(
      h.app.projectman.domain.teamTools.decideBoundaryRequest(ctx('dev-2'), {
        requestId: first.id,
        ...allow,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const resolved = await inject(h.app, 'POST', routes.decideBoundary('AR', first.id), lead, allow);
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().decidedBy).toEqual({ kind: 'human', handle: 'human-lead' });
    const second = await submit('second');
    const tool = TEAM_TOOLS.find((t) => t.name === 'decide_boundary_request')!;
    const args = tool.inputSchema.parse({ request_id: second.id, ...allow });
    const result = JSON.parse(
      await tool.run({ ctx: ctx(), args, handler: h.app.projectman.domain.teamTools }),
    );
    expect(result).toMatchObject({ state: 'allowed', decidedBy: { kind: 'ai', handle: 'cr' } });
    const inbox = await inject(h.app, 'GET', `${routes.inbox('AR')}?state=all`, owner);
    expect(inbox.json().items.find((i: { id: string }) => i.id === second.id).resolution.by).toBe('cr');
  });

  it('refuses owner exceptions and legacy inbox bypasses, but the owner can decide and revoke over REST', async () => {
    const request = await submit('cost', 'spend');
    expect(
      (await inject(h.app, 'POST', routes.decideBoundary('AR', request.id), lead, allow)).statusCode,
    ).toBe(403);
    await expect(
      h.app.projectman.domain.teamTools.decideBoundaryRequest(ctx(), { requestId: request.id, ...allow }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(
      (await inject(h.app, 'POST', routes.resolveInbox('AR', request.id), owner, { optionId: 'allow' }))
        .statusCode,
    ).toBe(403);
    expect(
      (await inject(h.app, 'POST', routes.decideBoundary('AR', request.id), owner, allow)).statusCode,
    ).toBe(200);
    expect((await inject(h.app, 'POST', routes.revokeBoundary('AR', request.id), outsider)).statusCode).toBe(
      403,
    );
    expect((await inject(h.app, 'POST', routes.revokeBoundary('AR', request.id), owner)).json().state).toBe(
      'revoked',
    );
    expect(
      (await inject(h.app, 'GET', routes.boundaryRequest('AR', request.id), owner)).json().grant.revokedAt,
    ).not.toBeNull();
  });

  it('rejects credential-bearing free text and category overrides at the transport boundary', async () => {
    const request = await submit();
    expect(
      (
        await inject(h.app, 'POST', routes.decideBoundary('AR', request.id), owner, {
          ...allow,
          category: 'delegable',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await inject(h.app, 'POST', routes.decideBoundary('AR', request.id), owner, {
          ...allow,
          reason: 'credential=value',
        })
      ).statusCode,
    ).toBe(400);
    const submitTool = TEAM_TOOLS.find((t) => t.name === 'submit_boundary_request')!;
    expect(
      submitTool.inputSchema.safeParse({
        operation_id: 'cost',
        deduplication_key: 'key',
        category: 'delegable',
      }).success,
    ).toBe(false);
    const get = TEAM_TOOLS.find((t) => t.name === 'get_boundary_request')!;
    const response = JSON.parse(
      await get.run({
        ctx: ctx('dev-1'),
        args: { request_id: request.id },
        handler: h.app.projectman.domain.teamTools,
      }),
    );
    expect(response.request.id).toBe(request.id);
    expect((await inject(h.app, 'GET', routes.boundaryRequest('AR', request.id), outsider)).statusCode).toBe(
      403,
    );
    expect(h.app.projectman.repos.boundary.grant(request.id)).toBeNull();
  });

  it('rejects admin changes to delegation settings and duty grants through the normal config path', async () => {
    const view = (await inject(h.app, 'GET', routes.config('AR'), outsider)).json();
    expect(
      (
        await inject(h.app, 'PATCH', routes.config('AR'), outsider, {
          baseVersion: view.version,
          boundary: { enabled: true, leadTimeoutSeconds: 600 },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await inject(h.app, 'PATCH', routes.config('AR'), outsider, {
          baseVersion: view.version,
          roleOverrides: {
            developer: { duties: ['implementation', 'boundary_authorization'], instructions: '' },
          },
        })
      ).statusCode,
    ).toBe(403);
  });
});
