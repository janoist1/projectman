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
  const parts: string[] = [];
  if (engine.runningSessions > 0) parts.push(t('engines.running', { count: engine.runningSessions }));
  const waiting: string[] = [];
  if (engine.waitingStarts > 0) waiting.push(t('engines.waitingStarts', { count: engine.waitingStarts }));
  if (engine.waitingMessages > 0)
    waiting.push(t('engines.waitingMessages', { count: engine.waitingMessages }));
  if (waiting.length > 0) parts.push(t('engines.waitsForIt', { what: waiting.join(t('common.and')) }));
  return parts.length > 0 ? parts.join(t('engines.workJoin')) : t('engines.noWork');
}

/** The command that sets the engine up on its machine; the key is asked for there, never put in the command. */
export function engineCommand(id: string): string {
  return `npm run engine -- init --cloud ${window.location.origin} --id ${id}`;
}
