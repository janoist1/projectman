import { cleanup, configure } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';
import { resetCommentDrafts } from '../features/board/useCardCommentDraft';
import { setCurrentLanguage } from '../i18n/language';
import { FakeIntersectionObserver } from './intersection';
import { server } from './msw/server';
import { takeContractViolations } from './msw/contract';

// Initialise before test modules build translated fixtures, and reset between tests.
// The UI tests read Hungarian (the mock account's language too); an English test sets its own language.
setCurrentLanguage('hu');
beforeEach(() => {
  setCurrentLanguage('hu');
});

// findBy* and waitFor poll for 1 s by default; a slow role query under parallel load can use that
// up on its own, so give them time to stay below the test timeout in vitest.config.ts.
configure({ asyncUtilTimeout: 5000 });

// Vitest globals are off, so testing-library cannot register its own cleanup.
afterEach(() => {
  cleanup();
  // A comment draft lives in the session's storage and in memory: the next test starts without it.
  window.sessionStorage.clear();
  resetCommentDrafts();
  server.resetHandlers();
  const violations = takeContractViolations();
  if (violations.length) throw new Error(`Mock API contract violations:\n${violations.join('\n')}`);
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

// jsdom has no layout: a test says what is on the screen with showOnScreen / hideFromScreen (test/intersection.ts).
if (!('IntersectionObserver' in globalThis)) {
  Object.assign(globalThis, { IntersectionObserver: FakeIntersectionObserver });
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
