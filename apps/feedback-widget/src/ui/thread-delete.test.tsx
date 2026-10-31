import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from 'preact';
import type { FeedbackCardRef } from '@projectman/shared';
import { act } from 'preact/test-utils';
import { createController } from '../controller';
import type { Controller } from '../controller';
import { API, PAGE, detail, fakeServer, flush, mark, reply, session, setUrl } from '../test/helpers';
import { sessionKey } from '../storage';
import { App } from './App';

const ID = 'fbm_aaaaaaaaaa';
const CARD: FeedbackCardRef = { key: 'PM-7', title: 'Cut-off button', stageName: 'Dev', visible: true };

let container: HTMLElement;
let controller: Controller;

beforeEach(() => {
  window.localStorage.clear();
  setUrl(PAGE);
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(() => {
  controller?.stop();
  render(null, container);
  container.remove();
});

async function openThread(overrides: { canDelete: boolean; card?: FeedbackCardRef }) {
  window.localStorage.setItem(sessionKey({ apiOrigin: API, projectKey: 'PM' }), JSON.stringify(session()));
  const server = fakeServer({
    'GET /marks': () => reply(200, { marks: [mark(overrides)], markers: [], cursor: 'c', me: session().me }),
    [`GET /marks/${ID}`]: () => reply(200, detail(overrides)),
    [`DELETE /marks/${ID}`]: () => reply(204),
  });
  controller = createController({
    win: window,
    base: API,
    projectKey: 'PM',
    fetchImpl: server.fetchImpl,
    capture: (async () => ({ ok: false, failure: { kind: 'timeout' } })) as never,
  });
  await act(async () => {
    render(<App controller={controller} />, container);
    await controller.start();
    await flush();
    controller.finishWelcome();
    controller.openMark(ID, { scroll: false });
    await flush();
  });
  return server;
}

describe('deleting a mark in the thread card (PM-1189)', () => {
  it('shows no delete button when the server says the mark cannot be deleted', async () => {
    await openThread({ canDelete: false });
    expect(container.querySelector('.thread-meta .link.danger')).toBeNull();
  });

  it('asks first, names the card that stays, focuses Cancel and deletes on confirm', async () => {
    const server = await openThread({ canDelete: true, card: CARD });
    const button = container.querySelector<HTMLButtonElement>('.thread-meta .link.danger');
    expect(button).not.toBeNull();
    await act(async () => {
      button?.click();
      await flush();
    });
    const group = container.querySelector('[role="group"].del-confirm');
    expect(group?.textContent).toContain('PM-7');
    expect(document.activeElement).toBe(container.querySelector('.del-actions .btn.ghost'));
    expect(server.calls.some((call) => call.method === 'DELETE')).toBe(false);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.del-actions .btn.danger')?.click();
      await flush();
    });
    expect(server.calls.some((call) => call.method === 'DELETE' && call.path === `/marks/${ID}`)).toBe(true);
    expect(container.querySelector('.thread')).toBeNull();
  });
});
