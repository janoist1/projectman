import { routes } from '@projectman/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addHumanAndLogin,
  createAppHarness,
  createProject,
  inject,
  OWNER_LOGIN,
  setupOwner,
  type AppHarness,
} from './helpers/app-harness';
import { OWNER_ACTOR } from './helpers/domain-harness';
import type { EmailChannelEnv, EmailSender } from '../src/services/email-channel';

const env = {
  region: 'eu-central-1',
  from: 'project@example.test',
  credentials: { accessKeyId: 'key', secretAccessKey: 'secret' },
  configurationSet: null,
  replyDomain: 'reply.example.test',
  queueUrl: null,
} as const;

const sender: EmailSender = {
  async send() {
    return { providerId: 'provider-1' };
  },
};

describe('email channel API', () => {
  let harness: AppHarness;
  let ownerCookie: string;

  beforeEach(async () => {
    harness = await createAppHarness({
      app: { emailChannelEnv: env as EmailChannelEnv, emailChannelSender: sender },
    });
    ownerCookie = await setupOwner(harness.app);
    await createProject(harness, ownerCookie);
    await harness.app.projectman.domain.projects.update(
      'AR',
      { actor: OWNER_ACTOR, author: OWNER_LOGIN },
      (draft) => {
        draft.project.email = { enabled: true };
        return 'Enable the e-mail channel';
      },
    );
  });

  afterEach(async () => {
    await harness.close();
  });

  it.each(['client', 'developer'] as const)('refuses %s access', async (access) => {
    const cookie = await addHumanAndLogin(harness.app, { handle: `${access}-human`, access });
    for (const [method, url] of [
      ['GET', routes.emailChannel('AR')],
      ['PUT', routes.emailContact('AR', 'owner')],
      ['GET', routes.emailLog('AR')],
    ] as const) {
      const response = await inject(
        harness.app,
        method,
        url,
        cookie,
        method === 'PUT' ? { wants: true } : undefined,
      );
      expect(response.statusCode).toBe(403);
    }
  });

  it('lets an owner view and change the contact setting', async () => {
    const view = await inject(harness.app, 'GET', routes.emailChannel('AR'), ownerCookie);
    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({
      configured: true,
      enabled: true,
      fromAddress: 'project@example.test',
    });
    const changed = await inject(harness.app, 'PUT', routes.emailContact('AR', 'owner'), ownerCookie, {
      wants: true,
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ handle: 'owner', wants: true, source: 'settings' });
  });

  it('answers a log cursor that cannot be read with 400, not a server error (PM-1108)', async () => {
    const response = await inject(
      harness.app,
      'GET',
      `${routes.emailLog('AR')}?before=not-a-cursor`,
      ownerCookie,
    );
    expect(response.statusCode).toBe(400);
  });
});
