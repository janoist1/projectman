import { act } from '@testing-library/react';

/**
 * jsdom has no layout, so nothing is ever on the screen: this stands in for the browser's IntersectionObserver and
 * only reports what a test says with `showOnScreen` / `hideFromScreen`.
 */
const observers = new Set<FakeIntersectionObserver>();

export class FakeIntersectionObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = '';
  readonly scrollMargin = '';
  readonly thresholds: readonly number[] = [];
  private readonly targets = new Set<Element>();

  private readonly callback: IntersectionObserverCallback;

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    observers.add(this);
  }

  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
    observers.delete(this);
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  report(target: Element, ratio: number) {
    if (!this.targets.has(target)) return;
    const entry = {
      target,
      isIntersecting: ratio > 0,
      intersectionRatio: ratio,
      time: 0,
      boundingClientRect: target.getBoundingClientRect(),
      intersectionRect: target.getBoundingClientRect(),
      rootBounds: null,
    } satisfies IntersectionObserverEntry;
    this.callback([entry], this);
  }
}

function report(target: Element, ratio: number) {
  act(() => {
    for (const observer of [...observers]) observer.report(target, ratio);
  });
}

/**
 * A visual viewport a test drives (jsdom has none): `coverFrom(y)` stands for a keyboard from `y` down. An element
 * given a `placeAt` position has its bounding box faked, as jsdom has no layout. Returns the controls and `restore`.
 */
export function fakeVisualViewport(height = 800) {
  const events = new EventTarget();
  const viewport = Object.assign(events, { offsetTop: 0, offsetLeft: 0, width: 400, height, scale: 1 });
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
  return {
    placeAt(target: Element, top: number, size = 16) {
      target.getBoundingClientRect = () =>
        ({
          top,
          bottom: top + size,
          left: 20,
          right: 80,
          width: 60,
          height: size,
          x: 20,
          y: top,
          toJSON: () => ({}),
        }) satisfies DOMRect;
    },
    coverFrom(y: number) {
      viewport.height = y;
      act(() => {
        events.dispatchEvent(new Event('resize'));
      });
    },
    uncover() {
      viewport.height = height;
      act(() => {
        events.dispatchEvent(new Event('resize'));
      });
    },
    restore() {
      Reflect.deleteProperty(window, 'visualViewport');
    },
  };
}

/** The element is wholly on the screen. */
export const showOnScreen = (target: Element) => report(target, 1);
/** The element is off the screen (scrolled out, below the fold, folded away). */
export const hideFromScreen = (target: Element) => report(target, 0);
