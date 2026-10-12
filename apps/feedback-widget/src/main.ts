import css from './styles.css?inline';
import { mountWidget } from './widget';

/**
 * The script tag's entry (PM-510): `<script src="https://projectman.example/feedback/widget.js" data-project="KEY" defer>`.
 * The server the widget talks to is the one the script came from.
 */
const GUARD = '__projectmanFeedbackWidget';
const PROJECT_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

// `currentScript` is only set while the script runs, so it is read before anything else.
const script =
  document.currentScript instanceof HTMLScriptElement
    ? document.currentScript
    : document.querySelector<HTMLScriptElement>('script[data-project]');

function boot(): void {
  const guarded = window as unknown as Record<string, unknown>;
  if (guarded[GUARD]) return; // the tag was included twice
  const projectKey = script?.dataset.project?.trim() ?? '';
  if (!script || !PROJECT_KEY.test(projectKey)) {
    console.warn('projectman feedback: the script tag needs a data-project attribute');
    return;
  }
  let base: string;
  try {
    // A development page is served by Vite, not by projectman, and names the server itself.
    const api = import.meta.env.DEV ? script.dataset.api : undefined;
    base = new URL(api ?? script.src, window.location.href).origin;
  } catch {
    console.warn('projectman feedback: the script address is not valid');
    return;
  }
  guarded[GUARD] = true;
  mountWidget({ win: window, base, projectKey, css });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
else boot();
