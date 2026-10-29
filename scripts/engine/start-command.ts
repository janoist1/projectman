import { existsSync } from 'node:fs';
import path from 'node:path';
import { ENGINE_PACKAGE_FILE } from '../../apps/server/src/engine-link/engine-package';

/**
 * The process `engine start` runs in the foreground. Both checkouts and engine packages run the built
 * server; a package (PM-1104: `engine-package.json` in its root) uses its own bundled node.
 */
export function engineStartCommand(root: string, nodePath: string): { command: string; args: string[] } {
  if (existsSync(path.join(root, ENGINE_PACKAGE_FILE)))
    return { command: path.join(root, 'bin/node'), args: [path.join(root, 'apps/server/dist/index.js')] };
  return { command: nodePath, args: [path.join(root, 'apps/server/dist/index.js')] };
}
