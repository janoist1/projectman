import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { EngineConfigError } from '../../apps/server/src/engine-link/engine-config';
import { bootstrapJob, renderPlist, servicePathEnv } from './service';
import type { LaunchctlResult, ServiceOptions } from './service';

export interface MenubarMachine {
  applicationsDir: string;
  supportDir: string;
  buildDir: string;
  osRelease: string;
  run: (command: string, args: string[]) => LaunchctlResult;
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
function checked(o: Options, command: string, args: string[], code: string): string {
  const result = o.run(command, args);
  if (result.status !== 0) throw new EngineConfigError(code, (result.stderr || result.stdout).slice(-4000));
  return result.stdout.trim();
}
export async function installMenubar(o: Options): Promise<void> {
  requireMac(o);
  const toolchain = o.run('swift', ['--version']);
  if (toolchain.status !== 0)
    throw new EngineConfigError(
      'app_toolchain_missing',
      'Install Command Line Tools with xcode-select --install.',
    );
  const p = paths(o);
  const previousFiles = [p.config, p.plist].map((file) => ({
    file,
    content: existsSync(file) ? readFileSync(file) : null,
  }));
  let unloaded = false;
  let replaced = false;
  const source = path.join(o.root, 'deploy/mac/menubar');
  const args = ['build', '-c', 'release', '--package-path', source, '--scratch-path', o.buildDir];
  checked(o, 'swift', args, 'app_build_failed');
  const bin = checked(o, 'swift', [...args, '--show-bin-path'], 'app_build_failed');
  mkdirSync(o.applicationsDir, { recursive: true });
  rmSync(p.staged, { recursive: true, force: true });
  try {
    mkdirSync(path.join(p.staged, 'Contents/MacOS'), { recursive: true });
    cpSync(path.join(bin, 'EngineMenu'), path.join(p.staged, 'Contents/MacOS/EngineMenu'));
    cpSync(path.join(source, 'Info.plist'), path.join(p.staged, 'Contents/Info.plist'));
    cpSync(path.join(source, 'Resources'), path.join(p.staged, 'Contents/Resources'), { recursive: true });
    checked(o, 'codesign', ['--force', '--sign', '-', p.staged], 'app_sign_failed');
    unload(o);
    unloaded = true;
    rmSync(p.backup, { recursive: true, force: true });
    if (existsSync(p.app)) renameSync(p.app, p.backup);
    try {
      renameSync(p.staged, p.app);
      replaced = true;
    } catch (error) {
      if (existsSync(p.backup)) renameSync(p.backup, p.app);
      throw error;
    }
    mkdirSync(o.supportDir, { recursive: true });
    writeFileSync(
      p.config,
      JSON.stringify({
        schemaVersion: 1,
        node: o.nodePath,
        root: o.root,
        home: o.home,
        path: servicePathEnv(o.pathEnv),
      }) + '\n',
    );
    mkdirSync(o.agentsDir, { recursive: true });
    mkdirSync(path.join(o.home, 'logs'), { recursive: true, mode: 0o700 });
    writeFileSync(
      p.plist,
      renderPlist(readFileSync(path.join(o.root, `deploy/mac/${LABEL}.plist`), 'utf8'), {
        label: LABEL,
        executable: path.join(p.app, 'Contents/MacOS/EngineMenu'),
        node: o.nodePath,
        root: o.root,
        home: o.home,
        path: '',
        logOut: path.join(o.home, 'logs/engine-menubar.out.log'),
        logErr: path.join(o.home, 'logs/engine-menubar.err.log'),
      }),
    );
    await bootstrapJob(o, p.plist, 'app_bootstrap');
    rmSync(p.backup, { recursive: true, force: true });
    o.out(`menu bar app installed: ${p.app}`);
  } catch (error) {
    if (unloaded) {
      // A failed activation must not leave a new binary with the previous installation's metadata.
      unload(o);
      if (replaced) rmSync(p.app, { recursive: true, force: true });
      if (existsSync(p.backup)) renameSync(p.backup, p.app);
      for (const { file, content } of previousFiles) {
        if (content === null) rmSync(file, { force: true });
        else writeFileSync(file, content);
      }
      if (previousFiles[1]!.content !== null) {
        // Files are restored even if macOS still refuses the old background item.
        try {
          await bootstrapJob(o, p.plist, 'app_restore_bootstrap');
        } catch {
          /* Keep the original installation error. */
        }
      }
    }
    throw error;
  } finally {
    rmSync(p.staged, { recursive: true, force: true });
  }
}
export function uninstallMenubar(o: Options): void {
  requireMac(o);
  unload(o);
  const p = paths(o);
  for (const file of [p.app, p.staged, p.backup, p.plist, p.config, o.buildDir])
    rmSync(file, { recursive: true, force: true });
  o.out('menu bar app removed');
}
