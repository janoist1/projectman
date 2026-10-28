import { finder } from '@medv/finder';

/** A CSS selector that finds `element` again later, or null when none could be built. */
export function selectorFor(element: Element, root: Element = document.body): string | null {
  try {
    const selector = finder(element, { root, timeoutMs: 400, maxNumberOfPathChecks: 5000 });
    return selector !== '' && selector.length <= 1000 ? selector : null;
  } catch {
    return null;
  }
}

/** A short name for the card header: `button.btn-cart`, `div#hero`. */
export function describeElement(element: Element): string {
  const tag = element.tagName.toLowerCase();
  const id = element.id !== '' && /^[\w-]+$/.test(element.id) ? `#${element.id}` : '';
  const firstClass = [...element.classList].find((name) => /^[\w-]+$/.test(name));
  const text = id || (firstClass ? `.${firstClass}` : '');
  return `${tag}${text}`.slice(0, 40);
}
