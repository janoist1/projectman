import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerPwa } from './register';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** Runs registerPwa and returns the listeners it added to the window, so tests do not leak them. */
function listeners() {
  const added = new Map<string, EventListener>();
  vi.spyOn(window, 'addEventListener').mockImplementation((type: string, handler: unknown) => {
    added.set(type, handler as EventListener);
  });
  registerPwa();
  return added;
}

describe('registerPwa', () => {
  it('swallows the install prompt, so the app never offers the installation', () => {
    const event = new Event('beforeinstallprompt', { cancelable: true });
    listeners().get('beforeinstallprompt')!(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('registers the worker with the root scope in a production build', () => {
    vi.stubEnv('PROD', true);
    const register = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { serviceWorker: { register } });
    listeners().get('load')!(new Event('load'));
    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
  });

  it('does not register the worker in development', () => {
    vi.stubEnv('PROD', false);
    const register = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { serviceWorker: { register } });
    expect(listeners().has('load')).toBe(false);
    expect(register).not.toHaveBeenCalled();
  });
});
