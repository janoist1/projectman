import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ALERT_SEEN_OPTION, CheckOutageResponse, routes } from '@projectman/shared';
import type { AgentProvider, InboxItem } from '@projectman/shared';
import { createAppHarness, createProject, inject, setupOwner, addHumanAndLogin } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';

describe('outage recheck API', () => {
  let h: AppHarness;
  let cookie: string;
  let ready: boolean | null;
  let item: InboxItem;
  beforeEach(async () => {
    h = await createAppHarness({ app: { claudeTmpRoots: [] } });
    cookie = await setupOwner(h.app);
    await createProject(h, cookie);
    ready = false;
    Object.assign(h.runner, {
      providerStatus: async (provider: AgentProvider) => ({
        provider,
        loggedIn: ready,
        method: null,
        checkedAt: new Date().toISOString(),
      }),
    });
    await h.app.projectman.domain.outages.check();
    item = h.app.projectman.domain.inbox.list('AR', { state: 'open', kind: 'alert' })[0]!;
  });
  afterEach(() => h?.close());

  it('rechecks without a body and reports failure, unknown status and recovery', async () => {
    const check = () => inject(h.app, 'POST', routes.checkOutage('AR', item.id), cookie);
    const failing = await check();
    expect(failing.statusCode, failing.body).toBe(200);
    expect(CheckOutageResponse.parse(failing.json()).stillFailing).toBe(true);
    ready = null;
    expect(CheckOutageResponse.parse((await check()).json()).stillFailing).toBe(true);
    ready = true;
    const recovered = CheckOutageResponse.parse((await check()).json());
    expect(recovered).toMatchObject({
      stillFailing: false,
      item: { state: 'resolved', resolution: { rule: 'outage_ended' } },
    });
    expect((await check()).statusCode).toBe(409);
  });

  it('rejects another member, clients, non-outage alerts and missing items', async () => {
    const developer = await addHumanAndLogin(h.app, { handle: 'other', access: 'developer' });
    const denied = await inject(h.app, 'POST', routes.checkOutage('AR', item.id), developer);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('not_an_assignee');
    const client = await addHumanAndLogin(h.app, { handle: 'client', access: 'client' });
    expect((await inject(h.app, 'POST', routes.checkOutage('AR', item.id), client)).statusCode).toBe(403);
    const disk = h.app.projectman.domain.inbox.create({
      projectKey: 'AR',
      kind: 'alert',
      assignees: ['owner'],
      source: 'system',
      title: 'Disk low',
      payload: { alert: 'disk_low', freeBytes: 1, thresholdBytes: 2 },
      options: [ALERT_SEEN_OPTION],
    });
    const wrong = await inject(h.app, 'POST', routes.checkOutage('AR', disk.id), cookie);
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json().error.code).toBe('not_an_outage_alert');
    expect((await inject(h.app, 'POST', routes.checkOutage('AR', 'missing'), cookie)).statusCode).toBe(404);
  });
});
