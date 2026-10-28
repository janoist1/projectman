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

/** The command that sets the engine up on its machine; the key is asked for there, never put in the command. */
export function engineCommand(id: string): string {
  return `npm run engine -- init --cloud ${window.location.origin} --id ${id}`;
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
export const ENGINE_SERVICE_INSTALL = 'npm run engine -- service install';
export const ENGINE_SERVICE_STATUS = 'npm run engine -- service status';

/** The one-line set-up of a machine; the key comes from the clipboard (`pbpaste`), never from the command. */
export function engineInitCommand(engine: { id: string; name: string }): string {
  return `pbpaste | npm run engine -- init --cloud ${shellQuote(window.location.origin)} --id ${engine.id} --name ${shellQuote(engine.name)} --link-headers-file ${LINK_HEADERS_FILE}`;
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
export function projectSetCommand(projectKey: string, folder: string): string {
  return `npm run engine -- project set ${projectKey} ${shellQuote(folder)} && npm run engine -- service install`;
}

/** One repository of the project; its `path` is relative to the project's folder. */
export function repoAddCommand(
  projectKey: string,
  repo: { name: string; path: string },
  folder: string,
): string {
  const relative = repo.path.replace(/^\.?\/+/, '');
  const base = folder.replace(/\/+$/, '');
  const path = relative === '' || relative === '.' ? base : `${base}/${relative}`;
  return `npm run engine -- repo add ${projectKey} ${shellQuote(repo.name)} ${shellQuote(path)}`;
}
