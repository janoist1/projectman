import { useState } from 'react';
import type { EngineView, ProjectEngineView } from '@projectman/shared';
import {
  useBindProjectEngine,
  useEngines,
  useProjectEngines,
  useUnbindProjectEngine,
} from '../../../api/queries';
import { useProject } from '../../../app/contexts';
import { Button } from '../../../components/Button';
import { Chip } from '../../../components/Chip';
import { Dialog } from '../../../components/Dialog';
import { ErrorBanner } from '../../../components/ErrorBanner';
import { MoreMenu } from '../../../components/MoreMenu';
import { useToast } from '../../../components/toastContext';
import { t } from '../../../i18n/t';
import { errorMessage } from '../../../lib/errors';
import { useNow } from '../../../lib/useNow';
import { CopyRow } from '../../engines/CopyRow';
import { engineState, projectSetCommand, statusText } from '../../engines/engineView';
import { SettingsSection } from './SettingsSection';
import styles from './EnginesSection.module.css';

type Dialogs = { kind: 'bind' } | { kind: 'unbind'; engine: ProjectEngineView } | null;

/**
 * Settings → Motorok → "Ezen a gépen fut a projekt" (PM-1078): the machines bound to this project, which is the
 * project owner's to arrange. A machine of another owner shows here too, but only its owner's own list can change it.
 */
export function ProjectEnginesCard({
  id,
  onNewMachine,
}: {
  id?: string;
  /** Opens the new-machine dialog of the "Gépeid" card. */
  onNewMachine: () => void;
}) {
  const { key } = useProject();
  const query = useProjectEngines(key);
  const own = useEngines(true);
  const makeBase = useBindProjectEngine(key);
  const toast = useToast();
  const now = new Date(useNow(true, 30_000));
  const [dialog, setDialog] = useState<Dialogs>(null);
  const engines = query.data?.engines;
  const bound = new Set(engines?.map((engine) => engine.id));
  // A machine of the caller's own that this project does not use yet; a revoked one cannot be bound.
  const free = (own.data ?? []).filter(
    (engine) => engine.ownedByMe === true && !engine.revokedAt && !bound.has(engine.id),
  );
  const seen = new Map<string, EngineView>((own.data ?? []).map((engine) => [engine.id, engine]));
  const title = t(engines && engines.length > 1 ? 'projectEngines.titleMany' : 'projectEngines.title');

  const setBase = (engine: ProjectEngineView) =>
    makeBase.mutate(
      { engineId: engine.id, isDefault: true },
      {
        onSuccess: () => toast.show(t('projectEngines.baseSet', { name: engine.name })),
        onError: (error) => toast.show(errorMessage(error), 'error'),
      },
    );

  const row = (engine: ProjectEngineView) => {
    const view = seen.get(engine.id);
    const state = engine.online ? 'online' : view ? engineState(view) : 'offline';
    const onlyBase = engine.isDefault && (engines?.length ?? 0) > 1;
    const reasonId = `unbind-reason-${engine.id}`;
    return (
      <li key={engine.id} className={styles.row}>
        <span className={styles.dot} data-state={state} />
        <div className={styles.body}>
          <div className={styles.head}>
            <strong className={styles.name}>{engine.name}</strong>
            {engine.isDefault && <span className={styles.chip}>{t('projectEngines.baseChip')}</span>}
            {!engine.ownedByMe && (
              <Chip tone="outline" size="sm">
                {t('projectEngines.othersChip')}
              </Chip>
            )}
          </div>
          <p className={styles.parts} data-needs={!engine.online}>
            <span>
              {view ? statusText(view, now) : t(engine.online ? 'engines.online' : 'projectEngines.offline')}
            </span>
          </p>
          {!engine.holdsProject && (
            <div className={styles.setup}>
              <p className={styles.line}>{t('projectEngines.notHolding')}</p>
              <CopyRow
                text={projectSetCommand(key, t('projectEngines.folderPlaceholder'))}
                label={t('projectEngines.commandAria')}
              />
              <p className={styles.muted}>{t('projectEngines.folderHint')}</p>
            </div>
          )}
        </div>
        {engine.ownedByMe ? (
          <MoreMenu label={t('engines.rowActions', { name: engine.name })}>
            {(close) => (
              <>
                {!engine.isDefault && (
                  <Button
                    variant="ghost"
                    icon="check"
                    onClick={() => {
                      close();
                      setBase(engine);
                    }}
                  >
                    {t('projectEngines.makeBase')}
                  </Button>
                )}
                <Button
                  variant="danger"
                  icon="trash"
                  aria-disabled={onlyBase || undefined}
                  aria-describedby={onlyBase ? reasonId : undefined}
                  onClick={() => {
                    if (onlyBase) return;
                    close();
                    setDialog({ kind: 'unbind', engine });
                  }}
                >
                  {t('projectEngines.unbind')}
                </Button>
                {onlyBase && (
                  <p id={reasonId} className={styles.muted}>
                    {t('projectEngines.unbindBlocked')}
                  </p>
                )}
              </>
            )}
          </MoreMenu>
        ) : (
          <span />
        )}
      </li>
    );
  };

  const bindButton = (variant: 'secondary' | 'primary') =>
    free.length > 0 ? (
      <Button variant={variant} size="md" icon="plus" onClick={() => setDialog({ kind: 'bind' })}>
        {t(engines && engines.length > 0 ? 'projectEngines.bindMore' : 'projectEngines.bindFirst')}
      </Button>
    ) : engines && engines.length === 0 ? (
      <Button variant={variant} size="md" icon="plus" onClick={onNewMachine}>
        {t('engines.newEngine')}
      </Button>
    ) : null;

  return (
    <SettingsSection
      id={id}
      title={title}
      meta={
        engines && engines.length > 0 && free.length > 0 ? (
          <span className={styles.newButton}>{bindButton('secondary')}</span>
        ) : undefined
      }
    >
      {query.isPending ? (
        <div className={styles.skeleton} aria-hidden="true">
          <div />
        </div>
      ) : query.isError ? (
        <div className={styles.error}>
          <ErrorBanner>{t('projectEngines.loadFailed')}</ErrorBanner>
          <Button size="md" icon="undo" onClick={() => void query.refetch()}>
            {t('app.retry')}
          </Button>
        </div>
      ) : query.data.engines.length === 0 ? (
        <div className={styles.error}>
          <p className={styles.needs} role="status">
            {t('projectEngines.emptyWarn')}
          </p>
          {bindButton('primary')}
        </div>
      ) : (
        <ul className={styles.list} aria-label={title}>
          {query.data.engines.map(row)}
        </ul>
      )}
      {dialog?.kind === 'bind' && <BindDialog free={free} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'unbind' && <UnbindDialog engine={dialog.engine} onClose={() => setDialog(null)} />}
    </SettingsSection>
  );
}

/** Picks one of the caller's free machines; an offline one is fine: it gets work when it next connects. */
function BindDialog({ free, onClose }: { free: EngineView[]; onClose: () => void }) {
  const { key } = useProject();
  const bind = useBindProjectEngine(key);
  const toast = useToast();
  const [selected, setSelected] = useState(free[0]?.id ?? '');
  const engine = free.find((candidate) => candidate.id === selected);
  return (
    <Dialog
      open
      size="sm"
      title={t('projectEngines.bindTitle', { key })}
      onClose={() => {
        if (!bind.isPending) onClose();
      }}
      footer={
        <>
          <Button variant="secondary" size="md" disabled={bind.isPending} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            size="md"
            loading={bind.isPending}
            disabled={!engine}
            onClick={() =>
              engine &&
              bind.mutate(
                { engineId: engine.id, isDefault: false },
                {
                  onSuccess: () => {
                    toast.show(t('projectEngines.bound', { name: engine.name }));
                    onClose();
                  },
                },
              )
            }
          >
            {t(bind.isPending ? 'projectEngines.binding' : 'projectEngines.bindConfirm')}
          </Button>
        </>
      }
      error={bind.isError ? <ErrorBanner>{errorMessage(bind.error)}</ErrorBanner> : undefined}
    >
      <fieldset className={styles.choices}>
        <legend>{t('projectEngines.bindLegend')}</legend>
        {free.map((candidate) => (
          <label key={candidate.id}>
            <input
              type="radio"
              name="bind-engine"
              value={candidate.id}
              checked={selected === candidate.id}
              disabled={bind.isPending}
              onChange={() => setSelected(candidate.id)}
            />
            <span className={styles.dot} data-state={engineState(candidate)} />
            <span>{candidate.name}</span>
          </label>
        ))}
      </fieldset>
      <p className={styles.muted}>{t('projectEngines.bindHint')}</p>
    </Dialog>
  );
}

function UnbindDialog({ engine, onClose }: { engine: ProjectEngineView; onClose: () => void }) {
  const { key } = useProject();
  const unbind = useUnbindProjectEngine(key);
  const toast = useToast();
  return (
    <Dialog
      open
      size="sm"
      title={t('projectEngines.unbindTitle', { name: engine.name })}
      description={t('projectEngines.unbindBody', { key })}
      onClose={() => {
        if (!unbind.isPending) onClose();
      }}
      footer={
        <>
          <Button variant="secondary" size="md" autoFocus disabled={unbind.isPending} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="dangerSolid"
            size="md"
            loading={unbind.isPending}
            onClick={() =>
              unbind.mutate(engine.id, {
                onSuccess: () => {
                  toast.show(t('projectEngines.unbound', { name: engine.name }));
                  onClose();
                },
              })
            }
          >
            {t('projectEngines.unbindConfirm')}
          </Button>
        </>
      }
      error={unbind.isError ? <ErrorBanner>{errorMessage(unbind.error)}</ErrorBanner> : undefined}
    />
  );
}
