import { rmSync } from 'node:fs';
import path from 'node:path';
import { EngineConfigError } from '../../apps/server/src/engine-link/engine-config';
import type { ServiceOptions } from './service';

/**
 * The menu bar app of PM-1088 was built on the engine's Mac by `app install`. PM-1125 retired that path: the
 * downloaded app installs itself and the engine on its first launch. What stays here is `app uninstall`, which
 * removes what PM-1088 left (the app, its launch agent, its fallback file, the build cache).
 */
export interface MenubarMachine {
  applicationsDir: string;
  supportDir: string;
  buildDir: string;
  osRelease: string;
}
type Options = ServiceOptions & MenubarMachine;
const LABEL = 'com.projectman.engine-menubar';
const paths = (o: Options) => ({
  app: path.join(o.applicationsDir, 'projectman motor.app'),
  staged: path.join(o.applicationsDir, '.projectman motor.app.new'),
  backup: path.join(o.applicationsDir, '.projectman motor.app.old'),
  plist: path.join(o.agentsDir, `${LABEL}.plist`),
  config: path.join(o.supportDir, 'menubar.json'),
});
function requireMac(o: Options): void {
  if (o.platform !== 'darwin')
    throw new EngineConfigError('app_unsupported', 'The menu bar app requires macOS.');
  if (Number.parseInt(o.osRelease, 10) < 22)
    throw new EngineConfigError('app_macos_too_old', 'The menu bar app requires macOS 13 or later.');
}
function unload(o: Options): void {
  const result = o.launchctl(['bootout', `gui/${o.uid}/${LABEL}`]);
  if (![0, 3, 113].includes(result.status))
    throw new EngineConfigError('app_bootout', result.stderr || result.stdout);
}
export function uninstallMenubar(o: Options): void {
  requireMac(o);
  unload(o);
  const p = paths(o);
  for (const file of [p.app, p.staged, p.backup, p.plist, p.config, o.buildDir])
    rmSync(file, { recursive: true, force: true });
  o.out('menu bar app removed');
}
