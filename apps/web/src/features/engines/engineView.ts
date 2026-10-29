import type { EngineStatusView, EngineView } from '@projectman/shared';
import { formatAgo } from '../../i18n/format';
import { t } from '../../i18n/t';

/** `never`: the engine was created but has not connected yet. */
export type EngineState = 'online' | 'offline' | 'never';

export function engineState(engine: Pick<EngineStatusView, 'online' | 'lastSeenAt'>): EngineState {
  if (engine.online) return 'online';
  return engine.lastSeenAt ? 'offline' : 'never';
}

export function defaultEngine<T extends Pick<EngineStatusView, 'isDefault'>>(
  engines: readonly T[],
): T | null {
  return engines.find((engine) => engine.isDefault) ?? null;
}

/** The default engine first, then the order the server gave. */
export function defaultFirst<T extends Pick<EngineStatusView, 'isDefault'>>(engines: readonly T[]): T[] {
  return [...engines].sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
}

/** Engine names by id, for texts that name the engine a card waits for. */
export function engineNameMap(
  engines: readonly Pick<EngineStatusView, 'id' | 'name'>[] | undefined,
): ReadonlyMap<string, string> {
  return new Map((engines ?? []).map((engine) => [engine.id, engine.name]));
}

/** "Csatlakozva" / "Nem elérhető · utoljára 12 perce" / "Még nem csatlakozott". */
export function statusText(engine: Pick<EngineStatusView, 'online' | 'lastSeenAt'>, now: Date): string {
  const state = engineState(engine);
  if (state === 'online') return t('engines.online');
  if (state === 'never' || !engine.lastSeenAt) return t('engines.neverSeen');
  return t('engines.offlineSeen', { ago: formatAgo(engine.lastSeenAt, now) });
}

/** "2 munkamenet fut · 3 indítás és 1 üzenet vár rá", or "Nincs rajta munka". */
export function workText(
  engine: Pick<EngineView, 'runningSessions' | 'waitingStarts' | 'waitingMessages'>,
): string {
  return workParts(engine).join(t('engines.workJoin'));
}

/** The same, one part each, for a line that must not break inside a part. */
export function workParts(
  engine: Pick<EngineView, 'runningSessions' | 'waitingStarts' | 'waitingMessages'>,
): string[] {
  const parts: string[] = [];
  if (engine.runningSessions > 0) parts.push(t('engines.running', { count: engine.runningSessions }));
  const waiting: string[] = [];
  if (engine.waitingStarts > 0) waiting.push(t('engines.waitingStarts', { count: engine.waitingStarts }));
  if (engine.waitingMessages > 0)
    waiting.push(t('engines.waitingMessages', { count: engine.waitingMessages }));
  if (waiting.length > 0) parts.push(t('engines.waitsForIt', { what: waiting.join(t('common.and')) }));
  return parts.length > 0 ? parts : [t('engines.noWork')];
}

/** What the engine reported about its machine, one part each; empty before it has ever connected. */
export function machineParts(
  engine: Pick<EngineView, 'hostname' | 'platform' | 'version'>,
): { text: string; mono?: boolean }[] {
  const parts: { text: string; mono?: boolean }[] = [];
  if (engine.hostname) parts.push({ text: engine.hostname });
  if (engine.platform) parts.push({ text: t(`engines.platform.${engine.platform}`) });
  if (engine.version) parts.push({ text: `v${engine.version}`, mono: true });
  return parts;
}

/**
 * How the engine is installed on the machine: `app` is the downloaded motor app (no checkout; its CLI shim does
 * the commands), `checkout` is a projectman checkout (the developers' machines and Linux).
 */
export type EngineMode = 'app' | 'checkout';

/** The CLI shim the motor app installs; quoted because the folder name holds a space. */
const ENGINE_APP_SHIM = '"$HOME/Library/Application Support/projectman/engine/bin/projectman-engine"';

/** What the engine's commands start with in this mode. */
function enginePrefix(mode: EngineMode): string {
  return mode === 'app' ? ENGINE_APP_SHIM : 'npm run engine --';
}

/** The shim's path, for the assistant to check that the app has installed it. */
export const ENGINE_APP_SHIM_PATH = '~/Library/Application Support/projectman/engine/bin/projectman-engine';

/** The command that sets the engine up on its machine; the key is asked for there, never put in the command. */
export function engineCommand(id: string, mode: EngineMode): string {
  return `${enginePrefix(mode)} init --cloud ${window.location.origin} --id ${id}`;
}

/** Quotes a value for a POSIX shell command line: the name and the folder are typed by the user. */
function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./~-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Where the engine's Cloudflare Access service token file lives on the owner's machine (docs/HYBRID.md). */
export const LINK_HEADERS_FILE = '~/.config/projectman/access-token.json';

/** What that file holds; the values come from the host personally and are never typed into the app. */
export const LINK_HEADERS_SAMPLE = '{"CF-Access-Client-Id": "…", "CF-Access-Client-Secret": "…"}';

/** Keeps the engine running on the machine, and reads how it runs. */
export function engineServiceInstall(mode: EngineMode): string {
  return `${enginePrefix(mode)} service install`;
}
export function engineServiceStatus(mode: EngineMode): string {
  return `${enginePrefix(mode)} service status`;
}

/** The one-line set-up of a machine; the key comes from the clipboard (`pbpaste`), never from the command. */
export function engineInitCommand(engine: { id: string; name: string }, mode: EngineMode): string {
  return `pbpaste | ${enginePrefix(mode)} init --cloud ${shellQuote(window.location.origin)} --id ${engine.id} --name ${shellQuote(engine.name)} --link-headers-file ${LINK_HEADERS_FILE}`;
}

/** Fetches the version the hub runs, so the engine's version matches (`ref` is a tag or a commit). */
export function engineInstallCommand(ref: string | null): string {
  return [
    'git clone https://github.com/janoist1/projectman.git',
    'cd projectman',
    ...(ref ? [`git checkout ${shellQuote(ref)}`] : []),
    'npm install',
  ].join(' && ');
}

/** Makes the machine hold the project's folder and restarts the engine, which reports it only in its hello. */
export function projectSetCommand(projectKey: string, folder: string, mode: EngineMode): string {
  const prefix = enginePrefix(mode);
  // The app manages the service's plist, so it is restarted, not written again with `service install`.
  const restart = mode === 'app' ? `${prefix} service restart` : engineServiceInstall(mode);
  return `${prefix} project set ${projectKey} ${shellQuote(folder)} && ${restart}`;
}

/** One repository of the project; its `path` is relative to the project's folder. */
export function repoAddCommand(
  projectKey: string,
  repo: { name: string; path: string },
  folder: string,
  mode: EngineMode,
): string {
  const relative = repo.path.replace(/^\.?\/+/, '');
  const base = folder.replace(/\/+$/, '');
  const path = relative === '' || relative === '.' ? base : `${base}/${relative}`;
  return `${enginePrefix(mode)} repo add ${projectKey} ${shellQuote(repo.name)} ${shellQuote(path)}`;
}
