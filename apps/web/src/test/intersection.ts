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

/** The element is wholly on the screen. */
export const showOnScreen = (target: Element) => report(target, 1);
/** The element is off the screen (scrolled out, below the fold, folded away). */
export const hideFromScreen = (target: Element) => report(target, 0);
