import { h, render } from 'preact';
import { createController } from './controller';
import type { Controller } from './controller';
import { HOST_ATTRIBUTE } from './screenshot';
import { App } from './ui/App';
import { paletteVariables } from './ui/common';

interface MountOptions {
  win: Window;
  /** The origin of the projectman server the widget talks to. */
  base: string;
  projectKey: string;
  css: string;
  fetchImpl?: typeof fetch;
}

interface Mounted {
  controller: Controller;
  host: HTMLElement;
  unmount(): void;
}

/** Gives the shadow root its styles. A constructed sheet is used when there is one: a page's CSP can block an inline `<style>`. */
function applyStyles(shadow: ShadowRoot, css: string): void {
  if (typeof CSSStyleSheet !== 'undefined' && 'adoptedStyleSheets' in shadow) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      shadow.adoptedStyleSheets = [sheet];
      return;
    } catch {
      /* fall back to a style element */
    }
  }
  const style = shadow.ownerDocument.createElement('style');
  style.textContent = css;
  shadow.append(style);
}

/**
 * Puts the widget on the page: one host element with a shadow root, so the page's styles and scripts
 * do not reach it. Nothing is requested here; the controller decides from the address and the storage.
 */
export function mountWidget(options: MountOptions): Mounted {
  const { win } = options;
  const doc = win.document;
  const host = doc.createElement('div');
  host.setAttribute(HOST_ATTRIBUTE, '');
  host.setAttribute('style', paletteVariables());
  const shadow = host.attachShadow({ mode: 'open' });
  applyStyles(shadow, options.css);
  const root = doc.createElement('div');
  root.className = 'w';
  shadow.append(root);
  // Under <html>, not <body>: a positioned body would shift the pins' document coordinates.
  doc.documentElement.append(host);

  const controller = createController({
    win,
    base: options.base,
    projectKey: options.projectKey,
    fetchImpl: options.fetchImpl,
  });
  render(h(App, { controller }), root);
  void controller.start();

  return {
    controller,
    host,
    unmount() {
      controller.stop();
      render(null, root);
      host.remove();
    },
  };
}
