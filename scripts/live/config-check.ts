import { existsSync } from 'node:fs';
import path from 'node:path';
import { createConfigStore } from '../../apps/server/src/config';
import type { LiveDeps } from './deps';

/**
 * Every project configuration of the home loads with this build's loaders (PM-493; it replaces
 * `config-dry-run.ts`). The watcher runs it with the next build's code, so that new loaders check the
 * real files before the switch. It only reads: a home without a customization repository is refused,
 * so that the store's `init` can never write one.
 *
 * Exit status: 0 all load, 1 a configuration does not load, 2 refused.
 */
export async function runConfigCheck(deps: LiveDeps, home: string): Promise<number> {
  const customization = path.join(home, 'customization');
  if (!existsSync(path.join(customization, '.git'))) {
    deps.out(`config-check: ${customization} is not a repository: nothing to check\n`);
    return 2;
  }
  const store = createConfigStore({ rootDir: customization });
  let failures = 0;
  for (const key of await store.list()) {
    try {
      await store.load(key);
      deps.out(`config-check: ${key} ok\n`);
    } catch (error) {
      failures += 1;
      const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ');
      deps.out(`config-check: ${key} failed: ${message}\n`);
    }
  }
  return failures > 0 ? 1 : 0;
}
