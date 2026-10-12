import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { createController } from '../controller';
import type { Controller, Target } from '../controller';
import { API, PAGE, fakeServer, flush, pointAnchor, reply, session, setUrl } from '../test/helpers';
import { sessionKey } from '../storage';
import { App } from './App';

let container: HTMLElement;
let controller: Controller;
let posted: () => number;

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

const pointTarget = (): Target => ({
  kind: 'point',
  anchor: pointAnchor(120, 240),
  label: 'Pont az oldalon',
  viewportRect: null,
  viewportPoint: { x: 120, y: 240 },
});

const areaTarget = (): Target => ({
  kind: 'area',
  anchor: {
    kind: 'area',
    selector: null,
    textSnippet: null,
    elementOffset: null,
    pagePoint: null,
    rect: { x: 50, y: 60, width: 200, height: 100 },
  },
  label: 'Terület az oldalon',
  viewportRect: { x: 50, y: 60, width: 200, height: 100 },
  viewportPoint: { x: 50, y: 60 },
});

const elementTarget = (): Target => ({
  kind: 'element',
  anchor: { ...pointAnchor(120, 240), kind: 'element', selector: '#nope', textSnippet: null },
  label: 'button.btn-cart',
  viewportRect: { x: 100, y: 220, width: 80, height: 40 },
  viewportPoint: { x: 120, y: 240 },
});

async function openCardWith(target: Target) {
  window.localStorage.setItem(sessionKey({ apiOrigin: API, projectKey: 'PM' }), JSON.stringify(session()));
  const server = fakeServer({
    'GET /marks': () => reply(200, { marks: [], markers: [], cursor: 'c', me: session().me }),
    'POST /marks': () => reply(500, { error: { code: 'internal', message: 'x', details: null } }),
  });
  posted = () => server.calls.filter((call) => call.method === 'POST' && call.path === '/marks').length;
  controller = createController({
    win: window,
    base: API,
    projectKey: 'PM',
    fetchImpl: server.fetchImpl,
    capture: (async () => null) as never,
  });
  await act(async () => {
    render(<App controller={controller} />, container);
    await controller.start();
    await flush();
    controller.finishWelcome();
    controller.chooseTarget(target);
    await flush();
  });
  return server;
}

describe('the new-mark card', () => {
  it('draws the marked place on the page in the marker colour while the card is open', async () => {
    await openCardWith(pointTarget());
    const pin = container.querySelector('.pin.draft');
    expect(pin).not.toBeNull();
    expect(pin?.getAttribute('style')).toContain('--pc');
    expect(pin?.textContent).toBe('KA');
    expect(container.querySelector('.frame.draft')).toBeNull();
    expect(posted()).toBe(0);
  });

  it('draws a dashed frame for an area and an outline is left to elements that are found', async () => {
    await openCardWith(areaTarget());
    expect(container.querySelector('.frame.draft')).not.toBeNull();
    expect(container.querySelector('.pin.draft')).not.toBeNull();
  });

  it('removes the drawing when the card closes', async () => {
    await openCardWith(pointTarget());
    await act(async () => {
      controller.cancelDraft();
      await flush();
    });
    expect(container.querySelector('.pin.draft')).toBeNull();
  });

  it('names a point or an area once, and an element as "Elem:" plus its selector', async () => {
    await openCardWith(pointTarget());
    expect(container.querySelector('.what')?.textContent).toBe('Pont az oldalon');
    expect(container.querySelector('.what .kind')).toBeNull();
    await act(async () => {
      controller.cancelDraft();
      controller.chooseTarget(elementTarget());
      await flush();
    });
    expect(container.querySelector('.what')?.textContent).toBe('Elem:button.btn-cart');
    expect(container.querySelector('.what .what-label')?.textContent).toBe('button.btn-cart');
  });

  it('labels the text field with the question', async () => {
    await openCardWith(pointTarget());
    const field = container.querySelector('textarea');
    expect(field?.getAttribute('aria-label')).toBe(field?.getAttribute('placeholder'));
    expect(field?.getAttribute('aria-label')).not.toBe(container.querySelector('h2')?.textContent);
  });

  it('scrolls the page on a phone so the marked place shows above the sheet', async () => {
    const width = window.innerWidth;
    const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => undefined);
    window.innerWidth = 390;
    try {
      await openCardWith(pointTarget());
      expect(scrollBy).toHaveBeenCalled();
      expect(scrollBy.mock.calls[0]?.[0]).toMatchObject({ top: expect.any(Number) });
    } finally {
      window.innerWidth = width;
      scrollBy.mockRestore();
    }
  });

  it('does not scroll the page on a wide screen', async () => {
    const scrollBy = vi.spyOn(window, 'scrollBy').mockImplementation(() => undefined);
    await openCardWith(pointTarget());
    expect(scrollBy).not.toHaveBeenCalled();
    scrollBy.mockRestore();
  });

  it('forgets the element frame when the page scrolls or resizes', async () => {
    window.localStorage.setItem(sessionKey({ apiOrigin: API, projectKey: 'PM' }), JSON.stringify(session()));
    const server = fakeServer({
      'GET /marks': () => reply(200, { marks: [], markers: [], cursor: 'c', me: session().me }),
    });
    controller = createController({
      win: window,
      base: API,
      projectKey: 'PM',
      fetchImpl: server.fetchImpl,
      capture: (async () => null) as never,
    });
    const target = document.createElement('section');
    target.getBoundingClientRect = () => new DOMRect(10, 20, 100, 50);
    document.body.append(target);
    const under = vi.spyOn(document, 'elementFromPoint').mockReturnValue(target);
    await act(async () => {
      render(<App controller={controller} />, container);
      await controller.start();
      await flush();
      controller.finishWelcome();
      controller.beginMode('element');
      await flush();
    });
    const overlay = container.querySelector('.target');
    await act(async () => {
      overlay?.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 30, clientY: 40 }));
      await flush();
    });
    expect(container.querySelector('.target-frame')).not.toBeNull();
    await act(async () => {
      window.dispatchEvent(new Event('resize'));
      await flush();
    });
    expect(container.querySelector('.target-frame')).toBeNull();
    under.mockRestore();
    target.remove();
  });

  it('does not disable send on an empty text: it moves to the field instead and requests nothing', async () => {
    await openCardWith(pointTarget());
    const send = container.querySelector<HTMLButtonElement>('.btn.primary');
    expect(send?.disabled).toBe(false);
    await act(async () => {
      send?.click();
      await flush();
    });
    expect(document.activeElement).toBe(container.querySelector('textarea'));
    expect(posted()).toBe(0);
    expect(controller.getState().draft?.sending).toBe(false);
  });
});
