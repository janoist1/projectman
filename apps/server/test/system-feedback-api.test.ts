import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerEvent } from '@projectman/shared';
import { addHumanAndLogin, createAppHarness, createProject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { OWNER } from './helpers/domain-harness';

const INPUT = {
  title: 'A tool refused a plain read',
  what: 'The Operator could not read a card and got a refusal without a reason.',
  workaround: 'Asked the owner.',
  fix: 'Say why a read is refused.',
};

describe('system feedback live event (PM-479)', () => {
  let h: AppHarness;
  const cookies: Record<string, string> = {};
  let brItem: string;

  const feedback = () => h.app.projectman.domain.systemFeedback;

  beforeEach(async () => {
    h = await createAppHarness();
    cookies.owner = await setupOwner(h.app);
    await createProject(h, cookies.owner);
    await h.app.projectman.domain.projects.create(
      { key: 'BR', name: 'Second', workspacePath: h.workspace, templateId: 'test' },
      OWNER,
    );
    // Owner of AR only: the owner of one project is not the owner of the instance.
    cookies.projectOwner = await addHumanAndLogin(h.app, { handle: 'pat', access: 'owner' });
    cookies.developer = await addHumanAndLogin(h.app, { handle: 'robin', access: 'developer' });
    cookies.client = await addHumanAndLogin(h.app, { handle: 'cleo', access: 'client' });
    brItem = 'fb_other_project';
    h.app.projectman.repos.systemFeedback.insert({
      id: brItem,
      projectKey: 'BR',
      title: 'Other',
      what: 'w',
      workaround: 'w',
      fix: 'f',
      createdAt: new Date().toISOString(),
      version: 'dev',
      sessionId: null,
    });
  });
  afterEach(async () => h.close());

  interface Socket {
    terminate(): void;
    on(event: 'message', listener: (data: Buffer) => void): void;
  }
  const sockets: Socket[] = [];
  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.terminate();
  });
  const connect = async (cookie: string) => {
    const events: ServerEvent[] = [];
    const ws = (await h.app.injectWS(
      '/ws',
      { headers: { cookie } },
      {
        onInit: (socket) =>
          (socket as unknown as Socket).on('message', (data) =>
            events.push(JSON.parse(data.toString()) as ServerEvent),
          ),
      },
    )) as unknown as Socket;
    sockets.push(ws);
    await new Promise((resolve) => setTimeout(resolve, 20));
    return events;
  };
  const changes = (events: ServerEvent[]) =>
    events.filter((event) => event.type === 'system_feedback_changed').map((event) => event.projectKey);

  it('reaches the instance owner for any item, a project owner for their own and no one else', async () => {
    const [owner, projectOwner, developer, client] = await Promise.all(
      ['owner', 'projectOwner', 'developer', 'client'].map((who) => connect(cookies[who]!)),
    );
    await feedback().record('AR', 'operator', 'ses_2', { ...INPUT, title: 'Second gap' });
    feedback().dismiss(brItem, 'no', { id: 'usr_owner' });
    // The forwarding setting belongs to no project: only the instance owner is told.
    feedback().setForwarding({ mode: 'off' }, { id: 'usr_owner' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(changes(owner!)).toEqual(['AR', 'BR', null]);
    expect(changes(projectOwner!)).toEqual(['AR']);
    expect(changes(developer!)).toEqual([]);
    expect(changes(client!)).toEqual([]);
  });
});
