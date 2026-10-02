import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// findBy* and waitFor poll for 1 s by default; a slow role query under parallel load can use that
// up on its own, so give them time to stay below the test timeout in vitest.config.ts.
configure({ asyncUtilTimeout: 5000 });

// Vitest globals are off, so testing-library cannot register its own cleanup.
afterEach(() => {
  cleanup();
});

// jsdom lacks these browser APIs used by the UI.
if (!('ResizeObserver' in globalThis)) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.assign(globalThis, { ResizeObserver: ResizeObserverStub });
}

if (!window.matchMedia) {
  Object.assign(window, {
    matchMedia: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }),
  });
}

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}
