import { existsSync } from 'node:fs';
import path from 'node:path';
import { ENGINE_PACKAGE_FILE } from '../../apps/server/src/engine-link/engine-package';

/**
 * The process `engine start` runs in the foreground. A checkout runs the TypeScript source with tsx under the
 * node that runs the CLI; an engine package (PM-1104: `engine-package.json` in its root) has neither tsx nor
 * sources, so it runs the built server under its own bundled node.
 */
export function engineStartCommand(root: string, nodePath: string): { command: string; args: string[] } {
  if (existsSync(path.join(root, ENGINE_PACKAGE_FILE)))
    return { command: path.join(root, 'bin/node'), args: [path.join(root, 'apps/server/dist/index.js')] };
  return { command: nodePath, args: ['--import', 'tsx', path.join(root, 'apps/server/src/index.ts')] };
}
