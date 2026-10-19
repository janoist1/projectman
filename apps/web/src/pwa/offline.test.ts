import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hu } from '../i18n/hu';
import { buildOfflineHtml, OFFLINE_TOKENS } from './offline';

const text = { name: hu.app.name, ...hu.pwa.offline };

/** Renders the offline page in jsdom and runs its inline script. */
function mount() {
  const html = buildOfflineHtml(text);
  document.documentElement.innerHTML = html.slice(html.indexOf('<head>'), html.indexOf('</html>'));
  const script = document.querySelector('script')!;
  // jsdom does not run scripts inserted through innerHTML: run it by hand.
  new Function(script.textContent ?? '')();
  return {
    button: document.getElementById('retry') as HTMLButtonElement,
    status: document.getElementById('status') as HTMLElement,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.innerHTML = '';
});

describe('offline page', () => {
  it('shows the locale texts with the product name', () => {
    const html = buildOfflineHtml(text);
    expect(html).toContain('<html lang="hu">');
    expect(html).toContain('<h1>Nincs kapcsolat</h1>');
    expect(html).toContain('A projectman most nem éri el a szervert.');
    expect(html).not.toContain('{name}');
  });

  it('escapes text from the locale file', () => {
    const html = buildOfflineHtml({ ...text, title: '<b>"x"</b>' });
    expect(html).toContain('<h1>&lt;b&gt;&quot;x&quot;&lt;/b&gt;</h1>');
  });

  it('uses the token colours and fits a 44 px button', () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const tokens = readFileSync(resolve(dir, '../styles/tokens.css'), 'utf8').toLowerCase();
    const [light, dark] = tokens.split('@media (prefers-color-scheme: dark)');
    const check = (css: string, v: (typeof OFFLINE_TOKENS)[keyof typeof OFFLINE_TOKENS]) => {
      expect(css).toContain(`--c-page: ${v.page.toLowerCase()};`);
      expect(css).toContain(`--c-ink: ${v.ink};`);
      expect(css).toContain(`--c-ink-3: ${v.ink3};`);
      expect(css).toContain(`--c-primary: ${v.primary};`);
      expect(css).toContain(`--c-on-primary: ${v.onPrimary};`);
      expect(css).toContain(`--c-accent: ${v.accent};`);
    };
    check(light!, OFFLINE_TOKENS.light);
    check(dark!, OFFLINE_TOKENS.dark);
    expect(buildOfflineHtml(text)).toContain('min-height: 44px');
  });

  it('retries on click: busy label, then a polite note while the network is still down', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('offline'));
    vi.stubGlobal('fetch', fetchMock);
    const { button, status } = mount();
    expect(status.getAttribute('aria-live')).toBe('polite');
    button.click();
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.textContent).toBe('Próbálom…');
    await vi.waitFor(() => expect(status.textContent).toBe('Még mindig nincs kapcsolat.'));
    expect(button.hasAttribute('aria-busy')).toBe(false);
    expect(button.textContent).toBe('Újra');
    expect(fetchMock).toHaveBeenCalledWith('/', { method: 'HEAD', cache: 'no-store', redirect: 'manual' });
  });

  it('reloads on the online event', () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    mount();
    window.dispatchEvent(new Event('online'));
    expect(reload).toHaveBeenCalled();
  });
});
