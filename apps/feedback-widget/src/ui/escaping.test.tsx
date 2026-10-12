import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { createController } from '../controller';
import type { Controller } from '../controller';
import { safeHttpUrl } from '../links';
import {
  API,
  PAGE,
  detail,
  fakeServer,
  flush,
  mark,
  person,
  reply,
  session,
  setUrl,
} from '../test/helpers';
import { sessionKey } from '../storage';
import { App } from './App';

const HOSTILE = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script><b>bold</b>';
const ID = 'fbm_hostile0000';

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

async function mountWith(marks: ReturnType<typeof mark>[], threadDetail = detail({ id: ID })) {
  window.localStorage.setItem(sessionKey({ apiOrigin: API, projectKey: 'PM' }), JSON.stringify(session()));
  const server = fakeServer({
    'GET /marks': () => reply(200, { marks, markers: [], cursor: 'c', me: session().me }),
    [`GET /marks/${ID}`]: () => reply(200, threadDetail),
  });
  controller = createController({ win: window, base: API, projectKey: 'PM', fetchImpl: server.fetchImpl });
  await act(async () => {
    render(<App controller={controller} />, container);
    await controller.start();
    await flush();
  });
}

const texts = (root: ParentNode): string => root.textContent ?? '';

describe('text from the page and from people is rendered as text', () => {
  it('shows a hostile mark body, author name and thread as text in the pin, the card and the panel', async () => {
    const hostile = mark({ id: ID, body: HOSTILE, author: person({ name: '<b>Eve</b>' }) });
    await mountWith(
      [hostile],
      detail({
        id: ID,
        body: HOSTILE,
        author: person({ name: '<b>Eve</b>' }),
        thread: [
          {
            id: 'fbe_1',
            type: 'comment',
            actor: person({ name: '<i>Mallory</i>' }),
            body: HOSTILE,
            card: null,
            createdAt: '2026-10-12T08:05:00.000Z',
          },
        ],
      }),
    );

    const root: ParentNode = container;
    // The views use <b> and <i> themselves; what must never appear is an element made from the text.
    const injected = (): string[] =>
      [...root.querySelectorAll('b, i')].map((element) => element.textContent ?? '').filter((text) =>
        ['bold', 'Eve', 'Mallory'].includes(text),
      );

    await act(async () => {
      controller.openMark(ID, { scroll: false });
      await flush();
    });

    expect(texts(root)).toContain(HOSTILE);
    expect(texts(root)).toContain('<i>Mallory</i>');
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('script')).toBeNull();
    expect(injected()).toEqual([]);
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();

    await act(async () => {
      controller.openPanel();
      await flush();
    });
    expect(texts(root)).toContain('<b>Eve</b>');
    expect(injected()).toEqual([]);
  });

  it('never renders markup through an attribute', async () => {
    await mountWith([mark({ id: ID, body: '"><svg onload=alert(1)>' })]);
    expect(container.querySelector('svg')).toBeNull();
    const pin = container.querySelector('.pin');
    expect(pin?.getAttribute('aria-label')).toContain('"><svg onload=alert(1)>');
  });

  it('does not use dangerouslySetInnerHTML anywhere in the views', async () => {
    const sources = import.meta.glob('./*.tsx', { query: '?raw', import: 'default', eager: true }) as Record<
      string,
      string
    >;
    for (const [file, source] of Object.entries(sources)) {
      if (file.endsWith('.test.tsx')) continue;
      expect(source, file).not.toContain('dangerouslySetInnerHTML');
      expect(source, file).not.toContain('innerHTML');
    }
  });
});

describe('safeHttpUrl', () => {
  it('allows only http and https addresses', () => {
    expect(safeHttpUrl('https://app.test/p/PM/feedback')).toBe('https://app.test/p/PM/feedback');
    expect(safeHttpUrl('http://app.test/x')).toBe('http://app.test/x');
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpUrl('data:text/html,<script>1</script>')).toBeNull();
    expect(safeHttpUrl('//evil.test/x')).toBeNull();
    expect(safeHttpUrl('')).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
  });
});
