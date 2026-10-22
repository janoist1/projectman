import { fileURLToPath } from 'node:url';

/**
 * The vitest setup file that installs the parent guard (PM-869); a vitest config lists it in
 * `setupFiles`. Kept apart from `worker-parent-guard.mjs`, which a worker loads: inside a jsdom
 * worker `import.meta.url` is not a `file:` URL.
 */
export const PARENT_GUARD_SETUP = fileURLToPath(new URL('./vitest-parent-guard.setup.mjs', import.meta.url));
