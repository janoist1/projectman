import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { CreateEngineResponse, EngineView } from '@projectman/shared';
import { useCreateEngine, useEngines, useRevokeEngine, useSetDefaultEngine } from '../../../api/queries';
import { useProject } from '../../../app/contexts';
import { Button } from '../../../components/Button';
import { Chip } from '../../../components/Chip';
import { Dialog } from '../../../components/Dialog';
import { ErrorBanner } from '../../../components/ErrorBanner';
import { TextField } from '../../../components/Field';
import { Fold } from '../../../components/Fold';
import { Icon } from '../../../components/Icon';
import { MoreMenu } from '../../../components/MoreMenu';
import { EmptyState } from '../../../components/States';
import { useToast } from '../../../components/toastContext';
import { formatDate } from '../../../i18n/format';
import { t } from '../../../i18n/t';
import { errorCode, errorMessage } from '../../../lib/errors';
import { useNow } from '../../../lib/useNow';
import { defaultFirst, engineCommand, engineState, statusText, workParts } from '../../engines/engineView';
import { SettingsSection } from './SettingsSection';
import styles from './EnginesSection.module.css';

type Dialogs =
  { kind: 'new' } | { kind: 'command'; engine: EngineView } | { kind: 'revoke'; engine: EngineView } | null;

/** How long a row that has just connected stays tinted. */
const FLASH_MS = 600;
const COPIED_MS = 1600;

/**
 * Settings → Motorok (PM-316): the machines the AI work runs on, their machine keys, the default
 * engine. Only the host owner gets here; the key of a new engine is shown once and lives only in the
 * dialog's state.
 */
export function EnginesSection() {
  const { me } = useProject();
  const query = useEngines(true);
  const setDefault = useSetDefaultEngine();
  const toast = useToast();
  const now = new Date(useNow(true, 30_000));
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [flash, setFlash] = useState<ReadonlySet<string>>(new Set());
  const known = useRef<Map<string, boolean> | null>(null);
  const engines = query.data;
  const active = engines?.filter((engine) => !engine.revokedAt) ?? [];
  const revoked = engines?.filter((engine) => engine.revokedAt) ?? [];

  // A row that comes online tints for a moment, so the change is seen where the eye is.
  useEffect(() => {
    if (!engines) return;
    const before = known.current;
    known.current = new Map(engines.map((engine) => [engine.id, engine.online]));
    if (!before) return;
    const connected = engines.filter((engine) => engine.online && before.get(engine.id) === false);
    if (connected.length === 0) return;
    setFlash((previous) => new Set([...previous, ...connected.map((engine) => engine.id)]));
    const timer = window.setTimeout(() => setFlash(new Set()), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [engines]);

  const newButton = (variant: 'secondary' | 'primary') => (
    <Button variant={variant} size="md" icon="plus" onClick={() => setDialog({ kind: 'new' })}>
      {t('engines.newEngine')}
    </Button>
  );
  const makeDefault = (engine: EngineView) =>
    setDefault.mutate(engine.id, {
      onSuccess: () => toast.show(t('engines.defaultSet', { name: engine.name })),
      onError: (error) => toast.show(errorMessage(error), 'error'),
    });

  const row = (engine: EngineView) => {
    const state = engineState(engine);
    const never = state === 'never';
    return (
      <li key={engine.id} className={styles.row} data-flash={flash.has(engine.id) || undefined}>
        <span className={styles.dot} data-state={state} />
        <div className={styles.body}>
          <div className={styles.head}>
            <strong className={styles.name}>{engine.name}</strong>
            {engine.isDefault && <span className={styles.chip}>{t('engines.defaultChipCap')}</span>}
          </div>
          <p className={styles.parts} data-needs={state === 'offline'}>
            <span>{statusText(engine, now)}</span>
            {engine.lastSeenIp && <span>{engine.lastSeenIp}</span>}
          </p>
          {never ? (
            <p className={styles.line}>
              {t('engines.neverHint')}{' '}
              <button
                type="button"
                className={styles.linkButton}
                onClick={() => setDialog({ kind: 'command', engine })}
              >
                {t('engines.showCommand')}
              </button>
            </p>
          ) : (
            <>
              <p className={styles.machine}>
                {machineParts(engine).length > 0 && (
                  <span className={styles.parts}>
                    {machineParts(engine).map((part) => (
                      <span key={part.text} className={part.mono ? styles.mono : undefined}>
                        {part.text}
                      </span>
                    ))}
                  </span>
                )}
                {engine.versionMismatch && (
                  <Chip tone="needs" size="sm" title={t('engines.mismatchHint')}>
                    {t('engines.mismatch')}
                  </Chip>
                )}
              </p>
              {engine.providers.length > 0 && (
                <ul className={styles.clis}>
                  {engine.providers.map((cli) => {
                    const name = t(`providers.${cli.provider}`);
                    return (
                      <li
                        key={cli.provider}
                        className={styles.cli}
                        data-available={cli.available}
                        title={t(cli.available ? 'engines.cliAvailable' : 'engines.cliMissing', { name })}
                      >
                        {cli.available && <Icon name="check" size={12} strokeWidth={2.6} />}
                        {name}
                        {cli.available ? (cli.version ? ` ${cli.version}` : '') : ` ${t('engines.cliNone')}`}
                      </li>
                    );
                  })}
                </ul>
              )}
              <p className={clsx(styles.parts, styles.muted)}>
                {workParts(engine).map((part) => (
                  <span key={part}>{part}</span>
                ))}
              </p>
            </>
          )}
          <p className={styles.muted}>
            {engine.createdBy === me.userId
              ? t('engines.keyLineBy', {
                  prefix: engine.keyPrefix,
                  created: formatDate(engine.createdAt),
                  who: me.name,
                })
              : t('engines.keyLine', { prefix: engine.keyPrefix, created: formatDate(engine.createdAt) })}
          </p>
        </div>
        <MoreMenu label={t('engines.rowActions', { name: engine.name })}>
          {(close) => (
            <>
              {!engine.isDefault && (
                <Button
                  variant="ghost"
                  icon="check"
                  onClick={() => {
                    close();
                    makeDefault(engine);
                  }}
                >
                  {t('engines.makeDefault')}
                </Button>
              )}
              {never && (
                <Button
                  variant="ghost"
                  icon="server"
                  onClick={() => {
                    close();
                    setDialog({ kind: 'command', engine });
                  }}
                >
                  {t('engines.setupCommand')}
                </Button>
              )}
              <Button
                variant="danger"
                icon="trash"
                onClick={() => {
                  close();
                  setDialog({ kind: 'revoke', engine });
                }}
              >
                {t('engines.revoke')}
              </Button>
            </>
          )}
        </MoreMenu>
      </li>
    );
  };

  return (
    <SettingsSection
      id="settings-engines"
      title={t('engines.settingsTitle')}
      meta={
        <>
          <span className={styles.meta}>{t('engines.settingsMeta')}</span>
          {engines && engines.length > 0 && (
            <span className={styles.newButton}>{newButton('secondary')}</span>
          )}
        </>
      }
    >
      {query.isPending ? (
        <div className={styles.skeleton} aria-hidden="true">
          <div />
          <div />
        </div>
      ) : query.isError ? (
        <div className={styles.error}>
          <ErrorBanner>{t('engines.loadFailed')}</ErrorBanner>
          <Button size="md" icon="undo" onClick={() => void query.refetch()}>
            {t('app.retry')}
          </Button>
        </div>
      ) : query.data.length === 0 ? (
        <div className={styles.emptyHost}>
          <EmptyState
            icon="server"
            title={t('engines.emptyTitle')}
            body={t('engines.emptyBody')}
            action={newButton('primary')}
          />
        </div>
      ) : (
        <>
          {active.length > 0 && !active.some((engine) => engine.isDefault) && (
            <p className={styles.needs} role="status">
              {t('engines.noDefaultHint')}
            </p>
          )}
          {active.length > 0 && (
            <ul className={styles.list} aria-label={t('engines.listLabel')}>
              {defaultFirst(active).map(row)}
            </ul>
          )}
          {revoked.length > 0 && (
            <Fold summary={t('engines.revokedFold', { count: revoked.length })}>
              <ul className={styles.list}>
                {revoked.map((engine) => (
                  <li key={engine.id} className={styles.row} data-revoked="true">
                    <span className={styles.dot} data-state="never" />
                    <div className={styles.body}>
                      <strong className={styles.name}>{engine.name}</strong>
                      <p className={styles.muted}>
                        {t('engines.revokedLine', {
                          when: formatDate(engine.revokedAt!),
                          prefix: engine.keyPrefix,
                        })}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </Fold>
          )}
        </>
      )}
      {dialog?.kind === 'new' && <NewEngineDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === 'command' && <CommandDialog engine={dialog.engine} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'revoke' && <RevokeDialog engine={dialog.engine} onClose={() => setDialog(null)} />}
    </SettingsSection>
  );
}

/** What the engine reported about its machine, one part each; empty before it has ever connected. */
function machineParts(engine: EngineView): { text: string; mono?: boolean }[] {
  const parts: { text: string; mono?: boolean }[] = [];
  if (engine.hostname) parts.push({ text: engine.hostname });
  if (engine.platform) parts.push({ text: t(`engines.platform.${engine.platform}`) });
  if (engine.version) parts.push({ text: `v${engine.version}`, mono: true });
  return parts;
}

function CopyRow({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  // "Másolva" is a confirmation, not a state: it goes back to "Másolás" after a moment.
  useEffect(() => {
    if (state !== 'copied') return;
    const timer = window.setTimeout(() => setState('idle'), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [state]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('failed');
    }
  };
  return (
    <>
      <div className={styles.copyRow}>
        <code className={styles.code} aria-label={label}>
          {text}
        </code>
        <Button variant="secondary" size="md" onClick={() => void copy()}>
          {t(state === 'copied' ? 'engines.copied' : 'engines.copy')}
        </Button>
      </div>
      {state === 'failed' && <ErrorBanner>{t('engines.copyFailed')}</ErrorBanner>}
    </>
  );
}

/** Step 1 asks the name; step 2 shows the machine key once, kept only in this component's state. */
function NewEngineDialog({ onClose }: { onClose: () => void }) {
  const create = useCreateEngine();
  const [name, setName] = useState('');
  const [created, setCreated] = useState<CreateEngineResponse | null>(null);
  const trimmed = name.trim();
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!trimmed || create.isPending) return;
    create.mutate({ name: trimmed, onCreated: setCreated });
  };
  if (created)
    return (
      <Dialog
        open
        size="md"
        title={t('engines.keyTitle', { name: created.engine.name })}
        closeOnBackdrop={false}
        onClose={onClose}
        footer={
          <Button variant="primary" size="md" onClick={onClose}>
            {t('engines.keyDone')}
          </Button>
        }
      >
        <p className={styles.warn} role="note">
          <strong>{t('engines.keyOnceStrong')}</strong> {t('engines.keyOnceBody')}
        </p>
        <h3 className={styles.step}>{t('engines.keyStep')}</h3>
        <CopyRow text={created.key} label={t('engines.keyAria')} />
        <h3 className={styles.step}>{t('engines.commandStep')}</h3>
        <CopyRow text={engineCommand(created.engine.id)} label={t('engines.commandAria')} />
        <p className={clsx(styles.muted, styles.note)}>{t('engines.keyPromptNote')}</p>
        <p className={clsx(styles.muted, styles.note)}>{t('engines.connectNote')}</p>
      </Dialog>
    );
  return (
    <Dialog
      open
      size="sm"
      title={t('engines.newTitle')}
      description={t('engines.newIntro')}
      onClose={() => {
        if (!create.isPending) onClose();
      }}
      footer={
        <>
          <Button variant="secondary" size="md" disabled={create.isPending} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            size="md"
            loading={create.isPending}
            disabled={!trimmed}
            onClick={() => submit()}
          >
            {t(create.isPending ? 'engines.creating' : 'engines.create')}
          </Button>
        </>
      }
      error={create.isError ? <ErrorBanner>{errorMessage(create.error)}</ErrorBanner> : undefined}
    >
      <form onSubmit={submit}>
        <TextField
          id="engine-name"
          label={t('engines.nameLabel')}
          hint={t('engines.nameHint')}
          placeholder={t('engines.namePlaceholder')}
          autoFocus
          maxLength={64}
          value={name}
          disabled={create.isPending}
          onChange={(event) => setName(event.target.value)}
        />
      </form>
    </Dialog>
  );
}

/** The set-up command of an engine that has not connected yet; the key is never shown again. */
function CommandDialog({ engine, onClose }: { engine: EngineView; onClose: () => void }) {
  return (
    <Dialog
      open
      size="md"
      title={t('engines.commandTitle', { name: engine.name })}
      description={t('engines.commandIntro')}
      onClose={onClose}
      footer={
        <Button variant="secondary" size="md" onClick={onClose}>
          {t('common.close')}
        </Button>
      }
    >
      <CopyRow text={engineCommand(engine.id)} label={t('engines.commandAria')} />
      <p className={styles.muted}>{t('engines.commandKeyGone')}</p>
    </Dialog>
  );
}

function RevokeDialog({ engine, onClose }: { engine: EngineView; onClose: () => void }) {
  const revoke = useRevokeEngine();
  const toast = useToast();
  // The list on screen is out of date: the mutation refreshes it, the message says why nothing happened.
  const stale =
    errorCode(revoke.error) === 'engine_revoked' || errorCode(revoke.error) === 'engine_not_found';
  return (
    <Dialog
      open
      size="sm"
      title={t('engines.revokeTitle', { name: engine.name })}
      description={t('engines.revokeBody')}
      onClose={() => {
        if (!revoke.isPending) onClose();
      }}
      footer={
        stale ? (
          <Button variant="secondary" size="md" onClick={onClose}>
            {t('common.close')}
          </Button>
        ) : (
          <>
            <Button variant="secondary" size="md" autoFocus disabled={revoke.isPending} onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="dangerSolid"
              size="md"
              loading={revoke.isPending}
              onClick={() =>
                revoke.mutate(engine.id, {
                  onSuccess: () => {
                    toast.show(t('engines.revoked', { name: engine.name }));
                    onClose();
                  },
                })
              }
            >
              {t('engines.revokeConfirm')}
            </Button>
          </>
        )
      }
      error={revoke.isError ? <ErrorBanner>{errorMessage(revoke.error)}</ErrorBanner> : undefined}
    >
      {engine.runningSessions > 0 && (
        <p className={styles.warn}>{t('engines.revokeRunning', { count: engine.runningSessions })}</p>
      )}
      {engine.isDefault && <p className={styles.warn}>{t('engines.revokeDefault')}</p>}
    </Dialog>
  );
}
