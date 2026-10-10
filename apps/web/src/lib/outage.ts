import type { InboxItem, WorkOutage } from '@projectman/shared';
import { alertPayloadOf } from '@projectman/shared';
import { formatStamp } from '../i18n/format';
import { t } from '../i18n/t';

/*
 * A provider or an engine that cannot work (PM-466 watches, PM-468 shows): the words for the inbox card,
 * the member's status, the card on the board and the toast, from the one `WorkOutage`.
 */

type ProviderOutage = Extract<WorkOutage, { kind: 'provider' }>;

/** The outage an inbox item carries; null for any other item. */
export function outageOfItem(item: InboxItem): WorkOutage | null {
  const alert = alertPayloadOf(item);
  return alert?.alert === 'work_outage' ? alert.outage : null;
}

/** What to do about an outage, before it is turned into words. */
export type OutageTodo =
  /** Log in (or install first) with this command; `engine` is the remote machine's name. */
  | { kind: 'login'; command: string; engine: string | null; install: boolean }
  /** The key or the setup is entered in the settings. */
  | { kind: 'settings' }
  /** NanoGPT's CLI is missing or old, or a ChatGPT login is in its Codex folder: the settings' fix sentence. */
  | { kind: 'fix'; problem: 'cli_missing' | 'cli_too_old' | 'chatgpt_login'; outage: ProviderOutage }
  | { kind: 'engine' };

export function outageTodo(outage: WorkOutage): OutageTodo {
  if (outage.kind === 'engine') return { kind: 'engine' };
  const { provider, problem } = outage;
  if (provider === 'nanogpt') {
    if (problem === 'cli_missing' || problem === 'cli_too_old' || problem === 'chatgpt_login')
      return { kind: 'fix', problem, outage };
    return { kind: 'settings' };
  }
  if (problem === 'not_logged_in' || problem === 'cli_missing' || problem === 'cli_too_old')
    return {
      kind: 'login',
      command: t(`providerSettings.loginCommands.${provider}`),
      engine: outage.engine?.name ?? null,
      install: problem !== 'not_logged_in',
    };
  return { kind: 'settings' };
}

/** The settings sentence that fixes NanoGPT's CLI or Codex folder. */
export function outageFixText(todo: Extract<OutageTodo, { kind: 'fix' }>): string {
  return t(`providerSettings.nanogptFixes.${todo.problem}`, {
    cliVersion: todo.outage.cliVersion ?? t('common.dash'),
    minCliVersion: todo.outage.minCliVersion ?? t('common.dash'),
  });
}

/** The headline of the inbox card. */
export function outageHeading(outage: WorkOutage): string {
  if (outage.kind === 'engine')
    return outage.engine
      ? t('inbox.alerts.work_outage.headings.engine', { engine: outage.engine.name })
      : t('inbox.alerts.work_outage.headings.engineNone');
  const heading = t(`inbox.alerts.work_outage.headings.${outage.problem}`, {
    provider: t(`providers.${outage.provider}`),
    cliVersion: outage.cliVersion ?? t('common.dash'),
  });
  return outage.engine
    ? heading + t('inbox.alerts.work_outage.onEngine', { engine: outage.engine.name })
    : heading;
}

/** The one sentence under the headline: what the outage stops. */
export function outageBody(outage: WorkOutage): string {
  if (outage.kind === 'engine')
    return outage.engine
      ? t('inbox.alerts.work_outage.bodyEngine', { since: formatStamp(outage.since) })
      : t('inbox.alerts.work_outage.bodyEngineNone');
  const provider = t(`providers.${outage.provider}`);
  return outage.problem === 'not_logged_in'
    ? t('inbox.alerts.work_outage.body', { provider })
    : t('inbox.alerts.work_outage.bodySetup', { provider });
}

/** Why a member or a card cannot work, in a few lower-case words ("a Claude nincs bejelentkezve (Mac mini)"). */
export function outageReason(outage: WorkOutage): string {
  if (outage.kind === 'engine')
    return outage.engine
      ? t('inbox.alerts.work_outage.reasons.engine', { engine: outage.engine.name })
      : t('inbox.alerts.work_outage.reasons.engineNone');
  const reason = t(`inbox.alerts.work_outage.reasons.${outage.problem}`, {
    provider: t(`providers.${outage.provider}`),
  });
  return outage.engine
    ? t('inbox.alerts.work_outage.reasons.onEngine', { reason, engine: outage.engine.name })
    : reason;
}

/** The line on a card that stands on an outage. */
export function outageStuckLabel(outage: WorkOutage): string {
  return t('taskStatus.stuck', { reason: outageReason(outage) });
}

/** What to do, as the tooltip of the card's line. */
export function outageStuckTitle(outage: WorkOutage): string {
  const todo = outageTodo(outage);
  switch (todo.kind) {
    case 'login':
      return todo.engine
        ? t('taskStatus.stuckTodo.loginOnEngine', { engine: todo.engine, command: todo.command })
        : t('taskStatus.stuckTodo.login', { command: todo.command });
    case 'fix':
      return outageFixText(todo);
    case 'settings':
      return t('taskStatus.stuckTodo.settings');
    case 'engine':
      return t('taskStatus.stuckTodo.engine');
  }
}

/**
 * The toast for an outage that ended by itself: the item is resolved with the rule `outage_ended`.
 * Null for any other item, and for anyone the alert was not for. "The waiting work started" only when
 * cards waited for it.
 */
export function outageEndedToast(item: InboxItem, myHandle: string | null): string | null {
  if (item.state !== 'resolved' || item.resolution?.rule !== 'outage_ended') return null;
  if (!myHandle || !item.assignees.includes(myHandle)) return null;
  const alert = alertPayloadOf(item);
  if (alert?.alert !== 'work_outage') return null;
  const { outage } = alert;
  const first =
    outage.kind === 'provider'
      ? t('inbox.alerts.work_outage.providerBack', { provider: t(`providers.${outage.provider}`) })
      : outage.engine
        ? t('inbox.alerts.work_outage.engineBack', { engine: outage.engine.name })
        : t('inbox.alerts.work_outage.engineBackNone');
  return alert.tasks.length > 0 ? `${first} ${t('inbox.alerts.work_outage.workStarted')}` : first;
}
