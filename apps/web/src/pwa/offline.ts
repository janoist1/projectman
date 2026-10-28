import { PWA_COLORS } from './manifest';

export interface OfflineText {
  /** Product name; it fills `{name}` in the body. */
  name: string;
  title: string;
  body: string;
  retry: string;
  retrying: string;
  stillOffline: string;
}

/**
 * Token values (styles/tokens.css) the offline page uses, light and dark; `offline.test.ts` checks them.
 * The page is self-contained: offline the web fonts do not load, so it uses the system fonts.
 */
export const OFFLINE_TOKENS = {
  light: {
    page: PWA_COLORS.lightPage,
    ink: '#191916',
    ink3: '#5b5a55',
    primary: '#191916',
    onPrimary: '#ffffff',
    accent: '#3044c9',
  },
  dark: {
    page: PWA_COLORS.darkPage,
    ink: '#f2f1ec',
    ink3: '#c1beb4',
    primary: '#f2f1ec',
    onPrimary: '#141412',
    accent: '#8190ff',
  },
} as const;

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function palette(tokens: (typeof OFFLINE_TOKENS)[keyof typeof OFFLINE_TOKENS]): string {
  return `--page:${tokens.page};--ink:${tokens.ink};--ink-3:${tokens.ink3};--primary:${tokens.primary};--on-primary:${tokens.onPrimary};--accent:${tokens.accent};`;
}

/** The static page the service worker shows when a page load finds no network. */
export function buildOfflineHtml(text: OfflineText): string {
  const body = text.body.replaceAll('{name}', text.name);
  const { light, dark } = OFFLINE_TOKENS;
  return `<!doctype html>
<html lang="hu">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <meta name="color-scheme" content="light dark" />
    <meta name="theme-color" content="${light.page}" media="(prefers-color-scheme: light)" />
    <meta name="theme-color" content="${dark.page}" media="(prefers-color-scheme: dark)" />
    <title>${escapeHtml(text.title)} · ${escapeHtml(text.name)}</title>
    <style>
      :root { color-scheme: light; ${palette(light)} }
      @media (prefers-color-scheme: dark) { :root { color-scheme: dark; ${palette(dark)} } }
      * { box-sizing: border-box; }
      html, body { margin: 0; min-height: 100%; background: var(--page); color: var(--ink); }
      body {
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: max(24px, env(safe-area-inset-top)) max(24px, env(safe-area-inset-right)) max(24px, env(safe-area-inset-bottom)) max(24px, env(safe-area-inset-left));
        font: 400 15px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif;
      }
      main { width: 100%; max-width: 360px; display: flex; flex-direction: column; align-items: center; text-align: center; }
      .logo { width: 40px; height: 40px; border-radius: 12px; background: var(--primary); color: var(--on-primary); display: flex; align-items: center; justify-content: center; }
      h1 { margin: 20px 0 8px; font: 600 30px/1.2 system-ui, -apple-system, 'Segoe UI', sans-serif; letter-spacing: -0.01em; }
      p { margin: 0; color: var(--ink-3); }
      button { margin-top: 24px; min-height: 44px; min-width: 120px; padding: 0 24px; border: 0; border-radius: 10px; background: var(--primary); color: var(--on-primary); font: 600 15px/1 system-ui, -apple-system, 'Segoe UI', sans-serif; cursor: pointer; }
      button[aria-busy='true'] { opacity: 0.7; cursor: default; }
      button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
      #status { min-height: 1.5em; margin-top: 12px; font-size: 13px; color: var(--ink-3); }
    </style>
  </head>
  <body>
    <main>
      <div class="logo" aria-hidden="true">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M6.5 6v12M12 6v7.5M17.5 6v4" />
        </svg>
      </div>
      <h1>${escapeHtml(text.title)}</h1>
      <p>${escapeHtml(body)}</p>
      <button type="button" id="retry" data-retry="${escapeHtml(text.retry)}" data-retrying="${escapeHtml(text.retrying)}" data-still-offline="${escapeHtml(text.stillOffline)}">${escapeHtml(text.retry)}</button>
      <div id="status" role="status" aria-live="polite"></div>
    </main>
    <script>
      (function () {
        var button = document.getElementById('retry');
        var status = document.getElementById('status');
        function reload() { location.reload(); }
        function retry() {
          if (button.getAttribute('aria-busy') === 'true') return;
          button.setAttribute('aria-busy', 'true');
          button.textContent = button.getAttribute('data-retrying');
          status.textContent = '';
          // A redirect (for example to the sign-in page) also proves that the network is back.
          fetch('/', { method: 'HEAD', cache: 'no-store', redirect: 'manual' }).then(reload, function () {
            button.removeAttribute('aria-busy');
            button.textContent = button.getAttribute('data-retry');
            status.textContent = button.getAttribute('data-still-offline');
          });
        }
        button.addEventListener('click', retry);
        window.addEventListener('online', reload);
      })();
    </script>
  </body>
</html>
`;
}
